import { createFileRoute } from '@tanstack/react-router'
import { and, asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import * as dbApi from '../../db/index.js'
import { comments } from '../../db/schema.js'
import { renderMarkdown } from '../lib/markdown.js'
import { getEnv, getPublicOrigin, runInBackground } from '../lib/server-env.js'
import {
  TG_CHUNK_BYTES,
  TG_LOCAL_PART_BYTES,
  ATTACHMENT_LEGACY_MAX_BYTES,
  ATTACHMENT_DIRECT_MAX_BYTES,
  isTgConfigured,
  getStorageChatId,
  setStorageChatIdKv,
  gatewayConfig,
  gwUploadUrl,
  gwFileUrl,
  gwDlUrl,
  gwPreviewPutUrl,
  localPartBytes,
  tgSendChunk,
  tgDeleteMessages,
  tgGetMe,
  tgGetUpdates,
  tgGetChat,
  tgChunkUrl,
  encodeAttachmentManifest,
  decodeAttachmentManifest,
  streamAttachmentChunks,
  planAttachmentWindow,
  ATTACHMENT_MAX_CHUNKS_PER_RESPONSE,
  TgRateLimitError,
  type AttachmentManifest,
  type TgChatInfo,
} from '../lib/attachment-store.js'
import { TtlCache, safeKvGet, safeKvPut, safeKvDelete } from '../lib/cache.js'
import { DEFAULT_SITE_DESCRIPTION, DEFAULT_SITE_TITLE, foldPostsForLang, isPostLanguage, type PostLanguage } from '../lib/utils.js'

const commentSchema = z.object({
  postSlug: z.string().min(1).max(160),
  body: z.string().trim().min(2).max(4000),
  parentId: z.number().int().positive().optional(),
})

function xmlEscape(s: string) {
  return s.replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;' }[c]!))
}
function stripTags(html: string) {
  return html.replace(/<\/?[^>]+(>|$)/g, '').replace(/\s+/g, ' ').trim()
}
function filenameHeader(filename: string) {
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`
}

/** 分块 base64 编码（旧的 spread 调用参数随文件大小增长，>~100KB 就可能栈溢出） */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let out = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += globalThis.btoa(String.fromCharCode(...bytes.subarray(i, i + CHUNK)))
  }
  return out
}

// ── /rss.xml：分语言订阅源 + stale-while-revalidate 缓存 ──
// 抓取器（Feedly/Inoreader 等）每次拉取都打源站，而 Neon 冷启动可达 5-15s。
// 故源 XML 在 isolate 内缓存 10 分钟：新鲜直接返回；过期/降级时立即返回旧源
// 并在后台（ctx.waitUntil）刷新；仅冷启动无任何缓存时才同步等待（给 20s 预算）。
const RSS_TTL = 10 * 60_000
const RSS_COLD_DB_TIMEOUT = 20_000
const RSS_LANG_TAGS: Record<PostLanguage, string> = { zh: 'zh-CN', en: 'en', ru: 'ru' }
const RSS_LANG_HREFLANG: Record<PostLanguage, string> = { zh: 'zh-CN', en: 'en', ru: 'ru' }

type RssEntry = { xml: string; at: number; degraded: boolean }
const rssCache = new Map<PostLanguage, RssEntry>()
const rssInflight = new Map<PostLanguage, Promise<string>>()

function feedUrl(origin: string, lang: PostLanguage): string {
  return lang === 'zh' ? `${origin}/rss.xml` : `${origin}/rss.xml?lang=${lang}`
}

async function buildRssXml(request: Request, lang: PostLanguage): Promise<{ xml: string; degraded: boolean }> {
  // 跨账号代理下 request.url 是 workers.dev（国内不可达），必须用规范源
  const origin = getPublicOrigin(request)
  const [{ posts, dbOk }, settings] = await Promise.all([
    dbApi.listPublishedPostsDetailed(RSS_COLD_DB_TIMEOUT),
    dbApi.getPublicSettings(),
  ])
  // 与首页完全相同的折叠逻辑：同一翻译组只保留当前语言版本（缺译本按 en/组内回退）
  const items = foldPostsForLang(posts, lang).slice(0, 50).map((post) => {
    const link = `${origin}/posts/${encodeURIComponent(post.slug)}`
    const html = renderMarkdown(post.content || post.summary || '')
    const description = stripTags(html).slice(0, 500)
    const pubDate = isNaN(new Date(post.date).getTime())
      ? new Date().toUTCString()
      : new Date(post.date).toUTCString()
    const categories = post.categories.map((c) => `<category>${xmlEscape(c)}</category>`).join('')
    return `<item><title>${xmlEscape(post.title)}</title><link>${xmlEscape(link)}</link><guid isPermaLink="false">post-${post.id ?? post.slug}</guid><pubDate>${pubDate}</pubDate><description><![CDATA[${xmlEscape(description)}]]></description>${categories}</item>`
  }).join('')
  const now = new Date().toUTCString()
  const selfHref = feedUrl(origin, lang)
  const alternates = (['zh', 'en', 'ru'] as PostLanguage[])
    .filter((l) => l !== lang)
    .map((l) => `<atom:link rel="alternate" type="application/rss+xml" hreflang="${RSS_LANG_HREFLANG[l]}" href="${xmlEscape(feedUrl(origin, l))}" />`)
    .join('')
  const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${xmlEscape(settings.siteTitle || DEFAULT_SITE_TITLE)}</title><link>${xmlEscape(origin)}</link><atom:link href="${xmlEscape(selfHref)}" rel="self" type="application/rss+xml" />${alternates}<description>${xmlEscape(settings.siteDescription || DEFAULT_SITE_DESCRIPTION)}</description><language>${RSS_LANG_TAGS[lang]}</language><lastBuildDate>${now}</lastBuildDate>${items}</channel></rss>`
  return { xml, degraded: !dbOk }
}

/** 重建（含并发去重）；DB 降级且已有完好旧源时保留旧源 */
function refreshRss(request: Request, lang: PostLanguage): Promise<string> {
  const running = rssInflight.get(lang)
  if (running) return running
  const task = (async () => {
    const { xml, degraded } = await buildRssXml(request, lang)
    const prev = rssCache.get(lang)
    if (degraded && prev && !prev.degraded) return prev.xml
    rssCache.set(lang, { xml, at: Date.now(), degraded })
    return xml
  })().finally(() => rssInflight.delete(lang))
  rssInflight.set(lang, task)
  return task
}

function rssResponse(xml: string): Response {
  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=600, stale-while-revalidate=1800',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

/** 浏览器地址栏直接打开 /rss.xml 时的友好说明页（阅读器/抓取器不受影响，拿到的仍是 XML） */
function rssInfoHtmlResponse(origin: string): Response {
  const feeds: [string, string][] = [
    ['中文', `${origin}/rss.xml`],
    ['English', `${origin}/rss.xml?lang=en`],
    ['Русский', `${origin}/rss.xml?lang=ru`],
  ]
  const links = feeds.map(([label, href]) => {
    const rawHref = href.includes('?') ? `${href}&raw=1` : `${href}?raw=1`
    return `<li><a href="${xmlEscape(rawHref)}">${label}</a><code>${xmlEscape(href.replace(origin, ''))}</code></li>`
  }).join('')
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RSS 订阅源</title><style>body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:680px;margin:0 auto;padding:72px 24px;line-height:1.7;color:#1f2328}h1{margin:0 0 8px}p.dim{color:#656d76}li{margin:10px 0}code{display:block;font-size:13px;color:#656d76}a{color:#087f6d;font-size:17px}@media(prefers-color-scheme:dark){body{background:#0d1117;color:#c9d1d9}.dim,code{color:#8b949e}}</style></head><body><h1>RSS 订阅源 · RSS feeds</h1><p class="dim">同一篇文章的多个译本只会出现在对应语言的订阅源中；Each translation appears only in its matching language feed.</p><ul style="list-style:none;padding:0">${links}</ul></body></html>`
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

// GET /rss.xml（从 action 参数或原始路径分发）；?lang=zh|en|ru 选择订阅语言，缺省中文
export async function handleRss(request: Request): Promise<Response> {
  const url = new URL(request.url)
  // 浏览器顶层导航（地址栏回车/刷新）给友好说明页；阅读器与抓取器无此信号，照常拿 XML。
  // 页面内「查看源」链接带 raw=1 以直接查看 XML；raw 不影响源内容。
  if (
    !url.searchParams.has('raw') &&
    request.headers.get('sec-fetch-mode') === 'navigate' &&
    request.headers.get('accept')?.includes('text/html')
  ) {
    return rssInfoHtmlResponse(getPublicOrigin(request))
  }
  const langParam = url.searchParams.get('lang')
  const lang: PostLanguage = langParam && isPostLanguage(langParam) ? langParam : 'zh'
  const cached = rssCache.get(lang)
  if (cached) {
    // 新鲜 → 直接返回；过期或上次为降级源 → 返回旧源同时后台刷新（SWR）
    if (cached.degraded || Date.now() - cached.at >= RSS_TTL) {
      runInBackground(refreshRss(request, lang))
    }
    return rssResponse(cached.xml)
  }
  // 冷启动无缓存：同步等待一次构建（Neon 冷启动预算 20s）
  try {
    return rssResponse(await refreshRss(request, lang))
  } catch (err) {
    console.error('[rss] build failed:', err)
    return new Response('RSS temporarily unavailable, please retry later.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  }
}

// GET /sitemap.xml：静态 + DB 已发布文章、归档页与分类页
// 抓取器在冷启动 DB 超时时仍应拿到可用站点地图：文章查询失败则只输出固定页面
export async function handleSitemap(request: Request): Promise<Response> {
  const origin = getPublicOrigin(request)
  const posts = await dbApi.listPublishedPosts().catch(() => [])
  const today = new Date().toISOString().slice(0, 10)

  const staticEntries = [
    `<url><loc>${xmlEscape(origin)}/</loc><changefreq>daily</changefreq><priority>1.0</priority><lastmod>${today}</lastmod></url>`,
    `<url><loc>${xmlEscape(origin)}/archive</loc><changefreq>weekly</changefreq><priority>0.6</priority></url>`,
  ]

  const categories = new Set<string>()
  const postEntries = posts.map((post) => {
    for (const c of post.categories) categories.add(c)
    const lastmod = (post.updatedAt || `${post.date}T00:00:00.000Z`).slice(0, 10)
    return `<url><loc>${xmlEscape(`${origin}/posts/${encodeURIComponent(post.slug)}`)}</loc><lastmod>${lastmod}</lastmod><changefreq>monthly</changefreq><priority>0.8</priority></url>`
  })

  const categoryEntries = [...categories]
    .sort()
    .map(
      (c) =>
        `<url><loc>${xmlEscape(`${origin}/category/${encodeURIComponent(c)}`)}</loc><changefreq>weekly</changefreq><priority>0.5</priority></url>`,
    )

  const body = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[...staticEntries, ...postEntries, ...categoryEntries].join('')}</urlset>`
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=600, stale-while-revalidate=1800',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

// 附件下载门禁：登录 + 可选密码令牌。返回附件行或直接可返回的错误 Response。
type FullAttachmentRow = NonNullable<Awaited<ReturnType<typeof dbApi.getAttachmentFullRow>>>
async function authorizeAttachment(url: URL): Promise<{ row: FullAttachmentRow } | Response> {
  const user = await dbApi.getCurrentUser()
  if (!user) return Response.json({ authRequired: true, error: '请先登录后查看与下载附件。' }, { status: 401 })
  const id = Number(url.searchParams.get('id'))
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: '附件标识不合法。' }, { status: 400 })
  const row = await dbApi.getAttachmentFullRow(id)
  if (!row) return Response.json({ error: '附件不存在。' }, { status: 404 })
  const token = url.searchParams.get('token') || ''
  if (row.passwordHash && row.passwordSalt) {
    if (!token) return Response.json({ locked: true, error: '此附件已加密，请提供密码后下载。' }, { status: 401 })
    const secret = await dbApi.getTokenSecret()
    const payload = await dbApi.verifyToken<{ aid: number }>(token, secret)
    if (!payload || payload.aid !== id) {
      return Response.json({ locked: true, error: '下载令牌无效或已过期，请重新输入密码。' }, { status: 401 })
    }
  }
  return { row }
}

// GET /api/comments?action=file-urls&id=ID&token=...
// 网关模式：鉴权后为每个 tg1 分片签发直连签名 URL（浏览器直接从网关按
// Range 并发下载，字节完全不经过 Worker）。一次调用记一次下载。
async function handleFileUrlsGet(url: URL): Promise<Response> {
  const authz = await authorizeAttachment(url)
  if (authz instanceof Response) return authz
  const { row } = authz
  const manifest = decodeAttachmentManifest(row.storageKey)
  if (!manifest) return Response.json({ error: '该附件不支持网关直连。' }, { status: 404 })
  if (!(await isTgConfigured())) {
    return Response.json({ error: '附件服务暂不可用（尚未配置 Telegram 存储）。' }, { status: 503 })
  }
  if (!gatewayConfig()) return Response.json({ error: '附件网关未配置。' }, { status: 503 })
  const total = row.sizeBytes || manifest.p.reduce((a, b) => a + b.s, 0)
  const parts = await Promise.all(
    manifest.p.map(async (p) => ({ size: p.s, url: await gwFileUrl(p.f) })),
  )
  dbApi.recordDownload(row.id).catch(() => undefined)
  return Response.json(
    { total, filename: row.filename, mimeType: row.mimeType || 'application/octet-stream', parts },
    { headers: PRIVATE_NO_STORE },
  )
}

// POST /api/comments?action=record-download&id=ID
// 网关直连计数：非密码锁附件的 gwDl 最终地址随列表下发，点击后浏览器直接
// 导航到网关，请求不经过 action=file 路径；前端用 sendBeacon 把计数打到这里。
async function handleRecordDownloadPost(url: URL): Promise<Response> {
  const user = await dbApi.getCurrentUser()
  if (!user) return Response.json({ authRequired: true, error: '请先登录后查看与下载附件。' }, { status: 401 })
  const id = Number(url.searchParams.get('id'))
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: '附件标识不合法。' }, { status: 400 })
  const row = await dbApi.getAttachmentFullRow(id)
  if (!row) return Response.json({ error: '附件不存在。' }, { status: 404 })
  // 密码锁附件走令牌下载路径（action=file 自带计数），不下发 gwDl，此处不重复计
  if (row.passwordHash && row.passwordSalt) return new Response(null, { status: 204 })
  await dbApi.recordDownload(id)
  return new Response(null, { status: 204 })
}

// ── 网关 converter 服务：Office → PDF 转换队列 ──

/** 恒定时间比较 converter 密钥；未配置密钥时拒绝一切调用 */
function converterAuthorized(request: Request): boolean {
  const secret = getEnv().CONVERTER_SECRET || ''
  if (!secret) return false
  const got = request.headers.get('x-converter-secret') || ''
  const a = new TextEncoder().encode(got)
  const b = new TextEncoder().encode(secret)
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

// POST /api/comments?action=convert-poll （x-converter-secret）
// 回填旧附件状态 → 认领一个任务 → 下发源文件整流地址与 PDF 回传地址；无任务 204
async function handleConvertPollPost(request: Request): Promise<Response> {
  if (!converterAuthorized(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (!gatewayConfig()) return Response.json({ error: 'gateway not configured' }, { status: 503 })
  await dbApi.backfillPreviewStates(20).catch(() => undefined)
  const job = await dbApi.claimPreviewJob().catch(() => null)
  if (!job) return new Response(null, { status: 204 })
  const manifest = decodeAttachmentManifest(job.storageKey)
  if (!manifest) {
    // 非 tg1 清单不应进队（入队规则保证）；快速消耗重试次数后置 failed
    await dbApi.completePreviewJob(job.id, false).catch(() => undefined)
    return new Response(null, { status: 204 })
  }
  try {
    const sourceUrl = await gwDlUrl(
      job.filename,
      job.mimeType || 'application/octet-stream',
      manifest.p.map((p) => ({ f: p.f, s: p.s })),
    )
    const putUrl = await gwPreviewPutUrl(job.id)
    return Response.json({
      job: { id: job.id, filename: job.filename, ext: job.filename.split('.').pop() || '', sourceUrl, putUrl },
    })
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'sign failed' }, { status: 502 })
  }
}

// POST /api/comments?action=convert-done  {id, ok, size?}
async function handleConvertDonePost(request: Request): Promise<Response> {
  if (!converterAuthorized(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  const parsed = z.object({
    id: z.number().int().positive(),
    ok: z.boolean(),
    size: z.number().int().nonnegative().optional(),
    error: z.string().max(300).optional(),
  }).safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: 'bad payload' }, { status: 400 })
  await dbApi.completePreviewJob(parsed.data.id, parsed.data.ok, parsed.data.size)
  return new Response(null, { status: 204 })
}

// GET /api/comments?action=file&id=ID&token=...
async function handleFileGet(request: Request, url: URL): Promise<Response> {
  const authz = await authorizeAttachment(url)
  if (authz instanceof Response) return authz
  const { row } = authz
  // MTProto 个人会话附件（mt1）：单文件最大 2GB，Worker 经 WSS 拉块流式回源。
  // 免费版 10ms CPU 上限下单响应只回一个 256KiB 窗口，浏览器端 6 路并发
  // Range 拉取并按偏移写盘（见 attachment-download.ts）。
  if (row.storageKey?.startsWith('mt1:')) {
    const mt = await import('../lib/mtproto-store.js')
    const mtm = mt.decodeMtManifest(row.storageKey)
    if (!mtm) return Response.json({ error: '附件清单无效。' }, { status: 500 })
    const total = row.sizeBytes || mtm.p.reduce((a, b) => a + b.s, 0)
    let requestedStart = 0
    let isRange = false
    const m = /^bytes=(\d+)-(\d*)$/.exec((request.headers.get('Range') || '').trim())
    if (m && total > 0) {
      const s = Number(m[1])
      if (s < total) {
        isRange = true
        requestedStart = s
      }
    }
    const win = mt.planMtWindow(total, requestedStart)
    // 回源块按 MTProto 块大小对齐，响应体首字节为对齐后的窗口起点
    if (requestedStart >= total && total > 0) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } })
    }
    // 下载计数：只在响应从文件头开始时记一次（续传/并发块不计，
    // 否则 1.2GB 会被按 256KiB 块计出数千次"下载"）
    if (requestedStart === 0) dbApi.recordDownload(row.id).catch(() => undefined)
    return new Response(mt.streamMtManifest(mtm, win.start, total), {
      status: isRange ? 206 : 200,
      headers: {
        'Content-Type': row.mimeType || 'application/octet-stream',
        'Content-Length': String(win.endInclusive - win.start + 1),
        'Content-Disposition': filenameHeader(row.filename),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Accept-Ranges': 'bytes',
        'X-Chunk-Size': String(mt.MT_WINDOW_BYTES),
        ...(isRange ? { 'Content-Range': `bytes ${win.start}-${win.endInclusive}/${total}` } : {}),
        ...(win.complete ? {} : { 'X-Partial-Content': '1', 'X-Total-Size': String(total) }),
      },
    })
  }

  // Telegram 清单：Worker 从 TG 云端逐片取回并流式拼接（字节不整体进内存，
  // 2 GB 附件也只有单片缓冲；登录/密码令牌门禁同上）。
  // Cloudflare 免费版单请求 subrequest 上限 50：每片消耗 ≤2 次，单次响应最多
  // 流经 ATTACHMENT_MAX_CHUNKS_PER_RESPONSE 片；支持 HTTP Range 断点续传，
  // 大文件由前端下载器分段拉取拼接（浏览器自带下载也可"继续"恢复）。
  const manifest = decodeAttachmentManifest(row.storageKey)
  if (manifest) {
    if (!(await isTgConfigured())) {
      return Response.json({ error: '附件服务暂不可用（尚未配置 Telegram 存储）。' }, { status: 503 })
    }
    const total = row.sizeBytes || manifest.p.reduce((a, b) => a + b.s, 0)
    // 解析 Range: bytes=start-[end]（只支持单段；多段/后缀式一律从头）
    let requestedStart = 0
    let isRange = false
    const rangeHeader = request.headers.get('Range') || ''
    const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim())
    if (m && total > 0) {
      const s = Number(m[1])
      if (s < total) {
        isRange = true
        requestedStart = s
      }
    }

    // 网关整流直跳：配置网关时，整文件下载 302 到网关 /dl，由网关把多片顺序
    // 拼接成整流直吐（字节不过 Worker）。手机等无 FS API 的浏览器由系统下载器
    // 原生接管；带 Range 的请求跟随重定向时浏览器会自动带上同一 Range 头，
    // 网关侧 206/416 语义与这里一致。桌面 FS API 下载器走 file-urls 分片直连，
    // 不经此路径；网关不可用时回退到下面的 MTProto/窗口流式路径。
    if (gatewayConfig()) {
      try {
        const dlUrl = await gwDlUrl(row.filename, row.mimeType || 'application/octet-stream', manifest.p)
        if (requestedStart === 0) dbApi.recordDownload(row.id).catch(() => undefined)
        return new Response(null, {
          status: 302,
          headers: { Location: dlUrl, 'Cache-Control': 'private, no-store' },
        })
      } catch { /* 签名失败等异常：继续走下面的 Worker 代理路径 */ }
    }

    // 优先：MTProto 用户会话绑定的正是该存储频道 → WSS 逐 256KiB 窗口
    // 回源（bot getFile 只能下载 ≤20MB，47MiB 分片必须走这里；WebSocket
    // 帧不计 subrequest，也绕开 50 次/请求上限）。
    const mtMod = await import('../lib/mtproto-store.js')
    const mtChat = (await mtMod.isMtConfigured()) ? await mtMod.getMtChat() : null
    if (mtChat && String(mtChat.id) === String(manifest.c)) {
      if (requestedStart >= total && total > 0) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } })
      }
      const parts = manifest.p.map((p) => ({ m: p.m, s: p.s }))
      const win = mtMod.planMtPartsWindow(parts, total, requestedStart)
      if (requestedStart === 0) dbApi.recordDownload(row.id).catch(() => undefined)
      return new Response(mtMod.streamMtParts(mtChat.id, mtChat.accessHash, parts, win.start, total), {
        status: isRange ? 206 : 200,
        headers: {
          'Content-Type': row.mimeType || 'application/octet-stream',
          'Content-Length': String(win.endInclusive - win.start + 1),
          'Content-Disposition': filenameHeader(row.filename),
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          'Accept-Ranges': 'bytes',
          'X-Chunk-Size': String(mtMod.MT_WINDOW_BYTES),
          ...(isRange ? { 'Content-Range': `bytes ${win.start}-${win.endInclusive}/${total}` } : {}),
          ...(win.complete ? {} : { 'X-Partial-Content': '1', 'X-Total-Size': String(total) }),
        },
      })
    }

    // 兼容回退：旧 bot getFile 直连，仅能承载 ≤20MB 的历史分片（旧 19MiB 方案）
    if (manifest.p.some((p) => p.s > 20 * 1000 * 1000)) {
      return Response.json(
        { error: '该附件使用大分片存储，需管理员先在 /mt-setup 配置 MTProto 个人会话后才能下载。' },
        { status: 503 },
      )
    }
    const win = planAttachmentWindow(manifest, requestedStart)
    const winEnd = win.endInclusive
    const length = winEnd - requestedStart + 1
    if (length <= 0) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } })
    }
    if (requestedStart === 0) dbApi.recordDownload(row.id).catch(() => undefined)
    return new Response(
      streamAttachmentChunks(manifest, { startByte: requestedStart, maxChunks: ATTACHMENT_MAX_CHUNKS_PER_RESPONSE }),
      {
        status: isRange ? 206 : 200,
        headers: {
          'Content-Type': row.mimeType || 'application/octet-stream',
          'Content-Length': String(length),
          'Content-Disposition': filenameHeader(row.filename),
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          'Accept-Ranges': 'bytes',
          ...(isRange ? { 'Content-Range': `bytes ${requestedStart}-${winEnd}/${total}` } : {}),
          // 窗口未覆盖到文件尾时告知前端下载器继续拉下一段
          ...(win.complete ? {} : { 'X-Partial-Content': '1', 'X-Total-Size': String(total) }),
        },
      },
    )
  }

  // 降级路径：早期/本地 base64 行，从数据库恢复二进制并响应
  if (!row.content) {
    return Response.json({ error: '附件内容缺失（云端清单无效且无本地副本）。' }, { status: 404 })
  }
  try {
    const bytes = Uint8Array.from(globalThis.atob(row.content), (c) => c.charCodeAt(0))
    // 异步记录下载计数，不阻塞响应
    dbApi.recordDownload(row.id).catch(() => undefined)
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': row.mimeType || 'application/octet-stream',
        'Content-Length': String(bytes.length),
        'Content-Disposition': filenameHeader(row.filename),
        'Cache-Control': 'private, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return Response.json({ error: '附件内容读取失败。' }, { status: 500 })
  }
}

// POST /api/comments?action=token&id=ID {password} → 返回下载令牌
async function handleTokenPost(request: Request, url: URL): Promise<Response> {
  const user = await dbApi.getCurrentUser()
  if (!user) return Response.json({ authRequired: true, error: '请先登录后查看与下载附件。' }, { status: 401 })
  const id = Number(url.searchParams.get('id'))
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: '附件标识不合法。' }, { status: 400 })
  const row = await dbApi.getAttachmentFullRow(id)
  if (!row) return Response.json({ error: '附件不存在。' }, { status: 404 })
  if (!row.passwordHash || !row.passwordSalt) {
    // 未上锁的无需令牌——直接签发短期令牌用于下载计数
    const secret = await dbApi.getTokenSecret()
    const token = await dbApi.signToken({ aid: id, exp: Date.now() + 600_000 }, secret)
    return Response.json({ token })
  }
  const parsed = z.object({ password: z.string().min(1).max(512) }).safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: '请输入密码。' }, { status: 400 })
  const ok = await dbApi.verifyPassword(parsed.data.password, row.passwordSalt, row.passwordHash)
  if (!ok) return Response.json({ error: '密码不正确。' }, { status: 401 })
  const secret = await dbApi.getTokenSecret()
  const token = await dbApi.signToken({ aid: id, exp: Date.now() + 600_000 }, secret)
  return Response.json({ token })
}

// POST /api/comments?action=upload  multipart/form-data：file, postSlug, password?
async function handleUploadPost(request: Request): Promise<Response> {
  const user = await dbApi.getCurrentUser()
  if (!user?.email) return Response.json({ error: '请先登录。' }, { status: 401 })
  // 管理员身份交给 insertAttachment 内部 requireAdmin 校验
  const formData = await request.formData().catch(() => null as unknown as FormData)
  if (!formData) return Response.json({ error: '请求体解析失败。' }, { status: 400 })
  const file = formData.get('file') as File | null
  const postSlug = String(formData.get('postSlug') || '').trim()
  const password = String(formData.get('password') || '')
  if (!file || !(file instanceof File)) return Response.json({ error: '请选择要上传的文件。' }, { status: 400 })
  if (!postSlug) return Response.json({ error: '缺少 postSlug。' }, { status: 400 })
  if (file.size === 0) return Response.json({ error: '文件为空。' }, { status: 400 })

  const useTg = await isTgConfigured()
  const maxBytes = useTg ? TG_CHUNK_BYTES : ATTACHMENT_LEGACY_MAX_BYTES
  if (file.size > maxBytes) {
    return Response.json({
      error: useTg
        ? `单请求附件不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB；更大的文件前端会自动分片直传，请直接重新选择。`
        : `文件超过大小上限（${Math.round(maxBytes / 1024 / 1024)} MB）。`,
    }, { status: 413 })
  }

  const filename = file.name || 'unnamed'
  const mimeType = file.type || 'application/octet-stream'
  try {
    // 主路径：分片作为 document 发进 bot 管理的私有频道（Telegram 云端永久保存，
    // 无格式白名单——管理员可信），DB 只存清单与元数据
    if (useTg) {
      const chatId = await getStorageChatId()
      const part = await tgSendChunk({ chatId, chunk: file, filename, contentType: mimeType })
      try {
        const row = await dbApi.insertAttachment({
          postSlug, filename, mimeType, sizeBytes: file.size,
          storageKey: encodeAttachmentManifest({ c: chatId, p: [part] }),
          password: password || undefined,
        })
        return Response.json({ attachment: row }, { status: 201 })
      } catch (e) {
        // 元数据落库失败：删除刚上传的分片消息，避免云端孤儿文件
        await tgDeleteMessages(chatId, [part.m])
        throw e
      }
    }
    // 降级路径（未配置 TG_BOT_TOKEN 的本地开发）：分块 base64 入库，上限 4 MB
    const buffer = new Uint8Array(await file.arrayBuffer())
    const base64Content = bytesToBase64(buffer)
    const row = await dbApi.insertAttachment({
      postSlug, filename, mimeType, sizeBytes: file.size, base64Content,
      password: password || undefined,
    })
    return Response.json({ attachment: row }, { status: 201 })
  } catch (e) {
    if (e instanceof TgRateLimitError) {
      return Response.json(
        { error: '云端限流，请稍后重试上传。', retryAfterMs: e.retryAfterMs },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(e.retryAfterMs / 1000)) } },
      )
    }
    return Response.json({ error: e instanceof Error ? e.message : '上传失败。' }, { status: 403 })
  }
}

// ── 大文件：浏览器分片，经 Worker 代理转发到 Telegram 云端（每片 ≤19 MiB）──
// 流程：mp-start(申请参数) → 逐片 POST mp-part(sendDocument) → mp-complete(清单落库)。
// Worker 不需要维护会话状态：分片落位以 Telegram 消息为准，清单在 complete 时组装。

async function handleMpStartPost(request: Request): Promise<Response> {
  await dbApi.requireAdmin()
  if (!(await isTgConfigured())) {
    return Response.json({ error: '大文件直传尚未配置（Telegram 存储未绑定）。' }, { status: 503 })
  }
  const parsed = z.object({
    postSlug: z.string().trim().min(1).max(160),
    filename: z.string().trim().min(1).max(255),
    size: z.number().int().positive().max(ATTACHMENT_DIRECT_MAX_BYTES),
    contentType: z.string().max(255).optional(),
  }).safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: '上传参数不合法。' }, { status: 400 })
  // 网关模式：浏览器直连自建本地 Bot API Server（单片 90MiB，不经过 Worker），
  // Worker 只签发短期上传令牌；未配置网关时回退 Worker 代理（47MiB/片）。
  const gw = gatewayConfig()
  if (gw) {
    const chatId = await getStorageChatId()
    const { url, token } = await gwUploadUrl(chatId)
    return Response.json({
      mode: 'gateway',
      uploadId: crypto.randomUUID(),
      partSize: localPartBytes(),
      maxBytes: ATTACHMENT_DIRECT_MAX_BYTES,
      chatId,
      uploadUrl: url,
      uploadToken: token,
    })
  }
  return Response.json({
    mode: 'worker',
    uploadId: crypto.randomUUID(),
    partSize: TG_CHUNK_BYTES,
    maxBytes: ATTACHMENT_DIRECT_MAX_BYTES,
  })
}

// POST /api/comments?action=mp-part  multipart/form-data：file（单片 ≤19 MiB）
async function handleMpPartPost(request: Request): Promise<Response> {
  await dbApi.requireAdmin()
  if (!(await isTgConfigured())) return Response.json({ error: '大文件直传未配置。' }, { status: 503 })
  const formData = await request.formData().catch(() => null)
  if (!formData) return Response.json({ error: '请求体解析失败。' }, { status: 400 })
  const file = formData.get('file')
  if (!(file instanceof File)) return Response.json({ error: '缺少分片数据。' }, { status: 400 })
  if (file.size === 0 || file.size > TG_CHUNK_BYTES) {
    return Response.json({ error: `分片大小必须为 1 B ~ ${Math.round(TG_CHUNK_BYTES / 1024 / 1024)} MB。` }, { status: 413 })
  }
  const filename = String(formData.get('filename') || 'part').slice(0, 255)
  try {
    const part = await tgSendChunk({
      chatId: await getStorageChatId(),
      chunk: file,
      filename,
      contentType: file.type || 'application/octet-stream',
    })
    return Response.json({ part }, { headers: PRIVATE_NO_STORE })
  } catch (e) {
    // Telegram 限流：立即透传 429 + 等待时长，由前端节奏控制重试，
    // 服务端不长睡（长请求会被前置网关判超时）
    if (e instanceof TgRateLimitError) {
      return Response.json(
        { error: '云端限流，稍后自动重试。', retryAfterMs: e.retryAfterMs },
        { status: 429, headers: { ...PRIVATE_NO_STORE, 'Retry-After': String(Math.ceil(e.retryAfterMs / 1000)) } },
      )
    }
    return Response.json({ error: e instanceof Error ? e.message : '分片转发失败。' }, { status: 502 })
  }
}

async function handleMpCompletePost(request: Request): Promise<Response> {
  await dbApi.requireAdmin()
  if (!(await isTgConfigured())) return Response.json({ error: '大文件直传未配置。' }, { status: 503 })
  const parsed = z.object({
    postSlug: z.string().trim().min(1).max(160),
    filename: z.string().trim().min(1).max(255),
    size: z.number().int().positive().max(ATTACHMENT_DIRECT_MAX_BYTES),
    contentType: z.string().max(255).optional(),
    password: z.string().max(512).optional(),
    parts: z.array(z.object({
      m: z.number().int().positive(),
      f: z.string().min(10).max(256),
      s: z.number().int().min(0).max(TG_LOCAL_PART_BYTES),
    })).min(1).max(100),
  }).safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: '合并参数不合法。' }, { status: 400 })
  const d = parsed.data

  // 幂等：同一清单已登记过（客户端重试 complete）直接返回旧记录
  const manifest: AttachmentManifest = { c: await getStorageChatId(), p: d.parts }
  const key = encodeAttachmentManifest(manifest)
  const existed = await dbApi.getAttachmentByStorageKey(key).catch(() => null)
  if (existed) return Response.json({ attachment: existed })

  try {
    const row = await dbApi.insertAttachment({
      postSlug: d.postSlug,
      filename: d.filename,
      mimeType: d.contentType || 'application/octet-stream',
      sizeBytes: d.size,
      storageKey: key,
      password: d.password || undefined,
    })
    return Response.json({ attachment: row }, { status: 201 })
  } catch (e) {
    // 登记失败：删除已上传的分片消息，避免云端孤儿文件
    await tgDeleteMessages(manifest.c, manifest.p.map((x) => x.m))
    return Response.json({ error: e instanceof Error ? e.message : '登记附件失败。' }, { status: 502 })
  }
}

async function handleMpAbortPost(request: Request): Promise<Response> {
  await dbApi.requireAdmin()
  const parsed = z.object({
    parts: z.array(z.object({ m: z.number().int().positive() })).max(200),
  }).safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: '参数不合法。' }, { status: 400 })
  const chatId = await getStorageChatId()
  if (chatId) await tgDeleteMessages(chatId, parsed.data.parts.map((x) => x.m))
  return Response.json({ ok: true })
}

// GET /api/comments?action=tg-probe[&set=<id>] → 管理员探测页：
// 列出 bot 最近"看到"的频道/群组，点一下即绑定附件存储会话，免去手动找 chat_id。
function escHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

async function handleTgProbeGet(_request: Request, url: URL): Promise<Response> {
  try {
    await dbApi.requireAdmin()
  } catch {
    return Response.json({ error: '需要管理员登录后访问。' }, { status: 401 })
  }
  const noStore = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' }
  const token = getEnv().TG_BOT_TOKEN
  if (!token) {
    return new Response('<h1>TG_BOT_TOKEN 未配置 / TG_BOT_TOKEN not set</h1>', { status: 503, headers: noStore })
  }
  // token 指纹（不泄露密钥本体）：长度、botId 段、secret 前 4 / 后 3 字符。
  // 用于排查 secret 写入时混入换行（长度会变成 47+）或复制残缺。
  const tokParts = token.split(':')
  const tokSecret = tokParts[1] || ''
  const tokFingerprint =
    `长度 ${token.length}（标准 46）· botId=${escHtml(tokParts[0] || '?')} · ` +
    `secret=${escHtml(tokSecret.slice(0, 4))}…${escHtml(tokSecret.slice(-3))}` +
    (/[\r\n\s]/.test(token) ? ' · <b style="color:#c0392b">⚠ 含空白/换行字符</b>' : '')

  let flash = ''
  const setId = url.searchParams.get('set')
  if (setId) {
    if (!/^(-?\d{4,20}|@[A-Za-z0-9_]{5,32})$/.test(setId)) {
      flash = '<p style="color:#c0392b">会话标识不合法（应为数字 id 或 @用户名）。</p>'
    } else {
      try {
        const chat = await tgGetChat(setId)
        const ok = await setStorageChatIdKv(String(chat.id))
        if (ok) {
          flash = `<p style="color:#1a7f37">✓ 已绑定到：<b>${escHtml(chat.title || chat.username || chat.id)}</b>（${escHtml(chat.type)}，${chat.id}）。现在可以去后台上传附件了。</p>`
        } else {
          flash = '<p style="color:#c0392b">KV 命名空间不可用，绑定未保存。</p>'
        }
      } catch (e) {
        flash = `<p style="color:#c0392b">Bot 无法访问该会话（请确认 bot 已被拉进该频道/群组且为管理员）：${escHtml(e instanceof Error ? e.message : '未知错误')}</p>`
      }
    }
  }

  const [meResult, updatesResult, boundId] = await Promise.all([
    tgGetMe().then((v) => ({ v })).catch((e: unknown) => ({ e })),
    tgGetUpdates().then((v) => ({ v })).catch((e: unknown) => ({ e })),
    getStorageChatId(),
  ])
  const me = 'v' in meResult ? meResult.v : null
  const meError = 'e' in meResult ? (meResult.e instanceof Error ? meResult.e.message : String(meResult.e)) : ''
  const updates = 'v' in updatesResult ? updatesResult.v : []
  const updatesError = 'e' in updatesResult ? (updatesResult.e instanceof Error ? updatesResult.e.message : String(updatesResult.e)) : ''

  // 从各类 update 中抽取会话（加 bot 入群的 my_chat_member / 频道帖子等）
  const chats = new Map<number, TgChatInfo>()
  for (const u of updates) {
    const candidates: unknown[] = ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'my_chat_member', 'chat_member']
      .map((f) => (u as Record<string, unknown>)[f])
    const cb = u.callback_query as { message?: { chat?: TgChatInfo } } | undefined
    if (cb?.message?.chat) candidates.push(cb.message)
    for (const c0 of candidates) {
      const c = (c0 as { chat?: TgChatInfo } | undefined)?.chat
      if (c && Number.isInteger(c.id) && c.id !== 777000) {
        chats.set(c.id, { id: c.id, title: c.title, username: c.username, type: c.type })
      }
    }
  }
  const list = [...chats.values()].sort((a, b) => {
    if (String(a.id) === boundId) return -1
    if (String(b.id) === boundId) return 1
    return (b.type || '').localeCompare(a.type || '')
  })

  const typeLabel: Record<string, string> = {
    channel: '频道 channel', group: '群组 group', supergroup: '超级群组 supergroup', private: '私聊 private',
  }
  const rows = list.map((c) => {
    const active = String(c.id) === boundId
    const name = c.title || c.username || `(id ${c.id})`
    return `<li>${active ? '<b>✓ 当前绑定</b> · ' : ''}<b>${escHtml(name)}</b>
      <small>${escHtml(typeLabel[c.type || ''] || c.type)} · ${c.id}${c.username ? ` · @${escHtml(c.username)}` : ''}</small>
      ${active ? '' : ` · <a href="?action=tg-probe&set=${c.id}">绑定到此会话</a>`}</li>`
  }).join('')

  const botHandle = me?.username ? `@${escHtml(me.username)}` : '(未知)'
  const body = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Telegram 存储绑定</title>
  <style>body{font:15px/1.6 system-ui,sans-serif;max-width:780px;margin:40px auto;padding:0 16px;color:#222}
  code{background:#f2f2f2;padding:1px 5px;border-radius:4px}li{margin:10px 0}small{color:#666}
  .err{background:#fdecea;border:1px solid #f5c6c0;color:#a0260a;padding:8px 12px;border-radius:6px}
  input[type=text]{padding:6px 8px;width:260px;border:1px solid #bbb;border-radius:5px}</style></head><body>
  <h1>Telegram 附件存储绑定</h1>
  <p>Bot：${me ? botHandle : '<span class="err">getMe 失败：' + escHtml(meError) + '</span>'}</p>
  <p><small>Token 指纹 / fingerprint：${tokFingerprint}</small></p>
  <p>当前绑定 chat_id：<code>${escHtml(boundId || '（尚未绑定）')}</code>
  ${boundId ? ' · <a href="?action=tg-selftest"><b>▶ 运行上传/下载自检</b></a>' : ''}</p>
  ${flash}
  ${updatesError ? `<p class="err">getUpdates 调用失败：${escHtml(updatesError)}<br>
    （409 Conflict 通常是别处正在轮询该 bot；401 说明 token 错误；请刷新重试）</p>` : ''}
  <h3>推荐方式：与 bot 的私聊（最简单，无需建频道）</h3>
  <ol>
    <li>打开 <a href="https://t.me/${escHtml(me?.username || '')}" target="_blank">${botHandle}</a>，点 <b>Start / 开始</b>（或随便发一句 <code>hi</code>）。<br>
      Open <a href="https://t.me/${escHtml(me?.username || '')}" target="_blank">${botHandle}</a> and press <b>Start</b> (or send <code>hi</code>).<br>
      Откройте <a href="https://t.me/${escHtml(me?.username || '')}" target="_blank">${botHandle}</a> и нажмите <b>Старт</b> (или отправьте <code>hi</code>).</li>
    <li><a href="?action=tg-probe"><b>点此刷新本页</b></a>，下方会出现与 bot 的私聊（private），点「绑定到此会话」。<br>
      <a href="?action=tg-probe"><b>Refresh</b></a> — your private chat appears below; click “bind”.<br>
      <a href="?action=tg-probe"><b>Обновить</b></a> — ниже появится личный чат, нажмите «привязать».</li>
  </ol>
  <p><small>附件经 Worker 用 bot 凭据存取，私聊里出现的文件只有你和 bot 可见；下载始终走站点登录/密码门禁。
  Files are accessed server-side with the bot token; the chat is just private storage.</small></p>
  <h3>备选方式：私有频道 / 群组</h3>
  <ol>
    <li>新建<b>私有频道</b>，把 ${botHandle} 拉进去并设为<b>管理员</b>（仅加为成员<b>不行</b>，频道帖子只有管理员 bot 能收到）。<br>
      Create a <b>private channel</b> and add the bot as an <b>administrator</b> (plain member cannot see posts).<br>
      Создайте <b>приватный канал</b> и добавьте бота <b>администратором</b> (простой участник не видит посты).</li>
    <li>在频道里发一条消息（如 <code>init</code>，须在 bot 入群<b>之后</b>），再刷新本页。<br>
      Post a message (e.g. <code>init</code>) <b>after</b> adding the bot, then refresh.</li>
  </ol>
  <h3>或手动输入会话标识</h3>
  <form action="?" method="get">
    <input type="hidden" name="action" value="tg-probe">
    <input type="text" name="set" placeholder="-100xxxxxxxxxx 或 @channel_username" required>
    <button type="submit">校验并绑定</button>
  </form>
  <small>私有频道没有 @用户名；可把频道消息转发给 @userinfobot 查询数字 id。</small>
  <h3>bot 最近可见的会话（${list.length}，原始更新 ${updates.length} 条）</h3>
  ${list.length ? `<ul>${rows}</ul>` : '<p>（空）还没有事件。请先完成上面任一步骤，再刷新。<br>(empty) Complete either flow above, then refresh.</p>'}
  </body></html>`
  return new Response(body, { headers: noStore })
}

// GET /api/comments?action=tg-selftest → 向已绑定会话发测试文件→读回→删除
async function handleTgSelftestGet(): Promise<Response> {
  const noStore = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' }
  const page = (inner: string) =>
    new Response(`<!doctype html><meta charset="utf-8"><title>TG 自检</title>
    <body style="font:15px/1.7 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px">
    <h1>Telegram 附件链路自检</h1>${inner}
    <p><a href="?action=tg-probe">← 返回绑定页</a></p></body>`, { headers: noStore })
  try {
    await dbApi.requireAdmin()
  } catch {
    return page('<p style="color:#c0392b">需要管理员登录。</p>')
  }
  if (!getEnv().TG_BOT_TOKEN) return page('<p style="color:#c0392b">TG_BOT_TOKEN 未配置。</p>')
  const chatId = await getStorageChatId()
  if (!chatId) return page('<p style="color:#c0392b">尚未绑定存储会话，请先在绑定页选择。</p>')

  const log: string[] = [`绑定会话 chat_id=<code>${escHtml(chatId)}</code>`]
  const probe = new Blob([`syntax-garden self-test ${new Date().toISOString()}\n`], { type: 'text/plain' })
  let part: { m: number; f: string; s: number } | null = null
  let step1 = false
  let step2 = false
  try {
    part = await tgSendChunk({ chatId, chunk: probe, filename: 'sg-selftest.txt', contentType: 'text/plain' })
    step1 = true
    log.push(`① sendDocument 成功：message_id=${part.m}，file_id 长度=${part.f.length}，大小=${part.s} B`)
  } catch (e) {
    log.push(`<b style="color:#c0392b">① sendDocument 失败：${escHtml(e instanceof Error ? e.message : String(e))}</b><br>
      频道场景通常是 bot 不是管理员（无法发帖/发文件）；请在频道设置里把 bot 提为管理员后重试。`)
    return page(`<ul>${log.map((x) => `<li>${x}</li>`).join('')}</ul>`)
  }
  try {
    const url = await tgChunkUrl(part.f)
    const res = await fetch(url)
    const text = await res.text()
    if (!res.ok) throw new Error(`下载 HTTP ${res.status}`)
    step2 = text.startsWith('syntax-garden self-test')
    log.push(`② getFile + 边缘下载成功：HTTP ${res.status}，内容校验=${step2 ? 'OK' : '内容不符'}`)
  } catch (e) {
    log.push(`<b style="color:#c0392b">② 读回失败：${escHtml(e instanceof Error ? e.message : String(e))}</b>`)
  }
  let step3 = false
  try {
    await tgDeleteMessages(chatId, [part.m])
    step3 = true
    log.push('③ deleteMessages 清理成功（测试文件已从会话删除）')
  } catch (e) {
    log.push(`③ 清理失败（不影响使用，可手动删除）：${escHtml(e instanceof Error ? e.message : String(e))}`)
  }
  const allOk = step1 && step2 && step3
  log.unshift(allOk
    ? '<b style="color:#1a7f37">✓ 全链路正常，可以去后台上传真实附件了。</b>'
    : '<b style="color:#c0392b">部分步骤失败，请按提示处理后重试。</b>')
  return page(`<ul>${log.map((x) => `<li>${x}</li>`).join('')}</ul>`)
}

// GET /api/comments?action=adminStatus → 管理员状态（服务端可读 cookie）
async function handleAdminStatusGet(): Promise<Response> {
  const status = await dbApi.getAdminStatus()
  return Response.json({ status, gateway: !!gatewayConfig() }, {
    headers: { 'Cache-Control': 'private, no-store, must-revalidate' },
  })
}

// POST /api/comments?action=feedbackUpload  multipart：反馈附件（截图等），登录即可
async function handleFeedbackUploadPost(request: Request): Promise<Response> {
  const user = await dbApi.getCurrentUser()
  if (!user?.email) return Response.json({ error: '请先登录后再上传附件。' }, { status: 401 })
  const formData = await request.formData().catch(() => null as unknown as FormData)
  if (!formData) return Response.json({ error: '请求体解析失败。' }, { status: 400 })
  const file = formData.get('file') as File | null
  if (!file || !(file instanceof File)) return Response.json({ error: '请选择要上传的文件。' }, { status: 400 })
  if (file.size === 0) return Response.json({ error: '文件为空。' }, { status: 400 })
  if (file.size > dbApi.MAX_ATTACHMENT_BYTES) {
    return Response.json({ error: `文件超过大小上限（${Math.round(dbApi.MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB）。` }, { status: 413 })
  }
  const buffer = new Uint8Array(await file.arrayBuffer())
  const base64Content = bytesToBase64(buffer)
  try {
    const row = await dbApi.insertFeedbackAttachment({
      filename: file.name || 'screenshot',
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      base64Content,
    })
    return Response.json({ attachment: row }, { status: 201 })
  } catch (e) {
    const status = e instanceof Error && /请先登录/.test(e.message) ? 401 : 400
    return Response.json({ error: e instanceof Error ? e.message : '上传失败。' }, { status })
  }
}

// GET /api/comments?action=feedbackFile&id=ID → 反馈附件下载（本人或管理员）
async function handleFeedbackFileGet(url: URL): Promise<Response> {
  const id = Number(url.searchParams.get('id'))
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: '附件标识不合法。' }, { status: 400 })
  let row: Awaited<ReturnType<typeof dbApi.getFeedbackAttachmentRow>>
  try {
    row = await dbApi.getFeedbackAttachmentRow(id)
  } catch (e) {
    const status = e instanceof Error && /请先登录/.test(e.message) ? 401 : 403
    return Response.json({ error: e instanceof Error ? e.message : '无权访问。' }, { status })
  }
  if (!row) return Response.json({ error: '附件不存在。' }, { status: 404 })
  try {
    const bytes = Uint8Array.from(globalThis.atob(row.content || ''), (c) => c.charCodeAt(0))
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': row.mimeType || 'application/octet-stream',
        'Content-Length': String(bytes.length),
        'Content-Disposition': filenameHeader(row.filename),
        'Cache-Control': 'private, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return Response.json({ error: '附件内容读取失败。' }, { status: 500 })
  }
}

// 评论行的可序列化形状（返回给前台的统一结构）
// 注意：userId / userEmail 属于身份信息，绝不下发到前台；
//   - 本人判定由服务端计算为 mine 布尔值
//   - 邮箱搜索由服务端完成（emailQ 参数），仅返回命中的评论 id
type CommentPayload = {
  id: number
  parentId: number | null
  userName: string
  body: string
  createdAt: string
  editedAt: string | null
  status: string
  likes: number
  mine: boolean
  // 个性签名（Markdown 源，前台经 renderMarkdown 消毒渲染）；软删评论为空
  signature: string
  // 身份标签 id 列表（外显装饰；所有视角可见）
  tags: number[]
  // 仅管理员视角携带：评论者的不透明身份 id，用于个签管理/警告（访客无此字段）
  userKey?: string
}

type Viewer = { id: string; email: string; isAdmin: boolean } | null

const commentColumns = {
  id: comments.id,
  parentId: comments.parentId,
  postSlug: comments.postSlug,
  userId: comments.userId,
  userName: comments.userName,
  userEmail: comments.userEmail,
  body: comments.body,
  createdAt: comments.createdAt,
  editedAt: comments.editedAt,
  status: comments.status,
  likes: comments.likes,
}

function toCommentPayload(row: {
  id: number
  parentId: number | null
  postSlug: string
  userId: string
  userName: string
  userEmail: string
  body: string
  createdAt: Date | string
  editedAt: Date | string | null
  status: string
  likes: number
}, viewer: Viewer, signatureMap: Record<string, string>, tagsMap: Record<string, number[]>): CommentPayload {
  const deleted = row.status !== 'published'
  // 本人判定在服务端完成：前台只需知道是否可编辑/删除，不需要知道身份标识
  const mine = !!viewer
    && !deleted
    && (row.userId === viewer.id || row.userEmail.toLowerCase() === viewer.email.toLowerCase())
  return {
    id: row.id,
    parentId: row.parentId,
    // 软删评论对前台隐藏正文与署名（仅在有保留回复时作为匿名占位出现）
    userName: deleted ? '' : row.userName,
    body: deleted ? '' : row.body,
    createdAt: new Date(row.createdAt).toISOString(),
    editedAt: row.editedAt ? new Date(row.editedAt).toISOString() : null,
    status: row.status,
    likes: row.likes,
    mine,
    signature: deleted ? '' : (signatureMap[row.userId] || ''),
    tags: deleted ? [] : (tagsMap[row.userId] || []),
    // userKey 仅对管理员下发（不透明 UUID，非邮箱等 PII）
    ...(viewer?.isAdmin && !deleted ? { userKey: row.userId } : {}),
  }
}

// 评论列表按身份个性化（mine / userKey），必须 private 仅单用户浏览器缓存；
// max-age=0 始终校验，stale-while-revalidate=120 在弱网下立即返回旧列表并后台刷新，
// 让评论区首屏几乎零等待；变更（发/编/删）时前端用 cache:'no-store' 强制拉取最新。
const COMMENTS_LIST_CACHE = { 'Cache-Control': 'private, max-age=0, stale-while-revalidate=120' }

const PRIVATE_NO_STORE = { 'Cache-Control': 'private, no-store, must-revalidate' }

// ── 评论两级缓存（绕过 CF→Neon 高延迟）──
// L1 进程内存 60s（同 isolate，零 KV 成本，挡住文章页连续挂载/重渲染的重复拉取）
// L2 KV 1h（跨 colo；日限额熔断器保护，超额后自动退化为 L1 → DB）
// 缓存的是公开评论行（不含 mine/userKey 等个性化字段），viewer 在请求时实时计算。
// 评论变更（发/编/删）时主动清内存 + 删 KV。
const COMMENTS_MEM_TTL = 60_000
const COMMENTS_KV_TTL = 3600 // 秒（1 小时，减少 DB 超时导致的空评论概率）
const commentsMemCache = new TtlCache<CachedComments>(40)

type CachedCommentRow = {
  id: number
  parentId: number | null
  postSlug: string
  userId: string
  userName: string
  userEmail: string
  body: string
  createdAt: string
  editedAt: string | null
  status: string
  likes: number
}
type CachedComments = {
  rows: CachedCommentRow[]
  signatureMap: Record<string, string>
  tagsMap: Record<string, number[]>
  at: number
}

function getCommentsCacheKey(postSlug: string) {
  return `comments:${postSlug}`
}

/**
 * 读评论缓存。
 * @param allowStale DB 故障兜底用：跳过内存、强制尝试 KV（即使读熔断器打开也试一次），
 *                   且不校验新鲜度——有旧评论总比空列表好。
 */
async function getCommentsFromCache(postSlug: string, allowStale = false): Promise<CachedComments | null> {
  if (!allowStale) {
    const memHit = commentsMemCache.get(postSlug)
    if (memHit) return memHit
  }
  const kv = getEnv().SG_CACHE
  const raw = await safeKvGet(kv, getCommentsCacheKey(postSlug), allowStale)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as CachedComments
    if (!allowStale && Date.now() - parsed.at > COMMENTS_KV_TTL * 1000) return null
    if (!allowStale) commentsMemCache.set(postSlug, parsed, COMMENTS_MEM_TTL)
    return parsed
  } catch {
    return null
  }
}

async function setCommentsCache(postSlug: string, data: Omit<CachedComments, 'at'>): Promise<void> {
  const payload: CachedComments = { ...data, at: Date.now() }
  commentsMemCache.set(postSlug, payload, COMMENTS_MEM_TTL)
  await safeKvPut(getEnv().SG_CACHE, getCommentsCacheKey(postSlug), JSON.stringify(payload), COMMENTS_KV_TTL)
}

function invalidateCommentsCache(postSlug: string): void {
  commentsMemCache.delete(postSlug)
  void safeKvDelete(getEnv().SG_CACHE, getCommentsCacheKey(postSlug))
}

const fileRouterCommentsGet = async (request: Request) => {
  const url = new URL(request.url)
  const postSlug = url.searchParams.get('post')
  if (!postSlug) return Response.json({ error: '缺少文章标识。' }, { status: 400 })

  // 本地无 DB：返回空评论列表，避免文章页评论区 500
  if (!dbApi.isDbConfigured()) return Response.json({ comments: [], emailMatchIds: null })

  // 邮箱范围搜索短路：前台只消费 emailMatchIds。此前每次击键（250ms 防抖）都重跑
  // 整个评论列表（鉴权 + 评论 + 个签 + 标签共多个串行往返 + 全量 payload），
  // 这里直接走单条索引查询，且无需登录（与旧行为一致），payload 仅一组 id。
  const emailQ = url.searchParams.get('emailQ')?.trim()
  if (emailQ) {
    const isRegex = url.searchParams.get('emailMode') === 'regex'
    const emailMatchIds = await dbApi.matchCommentEmails({ postSlug, q: emailQ, isRegex })
    return Response.json({ comments: [], emailMatchIds }, { headers: PRIVATE_NO_STORE })
  }

  // viewer 同时需要 isAdmin（决定 userKey 是否下发）
  const me = await dbApi.getCurrentUser()
  const adminStatus = me ? await dbApi.getAdminStatus() : null
  const viewer: Viewer = me ? { id: me.id, email: me.email, isAdmin: !!adminStatus?.isAdmin } : null

  // fresh=1：刚完成发/编/删评论后的强制刷新。POST 只清了处理请求那个 isolate
  // 的内存缓存 + KV，若 GET 落在别的 colo，其 60s 内存缓存仍是旧列表——
  // 此时必须绕过缓存直查 DB（查到后照常回填缓存，后续访问继续命中）。
  const forceFresh = url.searchParams.get('fresh') === '1'

  // 1. 先查 KV 缓存（跨 colo 共享，<50ms，绕过 CF→Neon 高延迟）
  const cached = forceFresh ? null : await getCommentsFromCache(postSlug)
  if (cached) {
    const kept = new Set<number>(cached.rows.filter((r) => r.status === 'published').map((r) => r.id))
    for (const r of cached.rows) {
      if (r.status !== 'published' && r.parentId == null) {
        const hasKeptReply = cached.rows.some((c) => c.parentId === r.id && kept.has(c.id))
        if (hasKeptReply) kept.add(r.id)
      }
    }
    const visibleRows = cached.rows.filter((r) => kept.has(r.id))
    const visible = visibleRows.map((r) => toCommentPayload(r, viewer, cached.signatureMap, cached.tagsMap))
    return Response.json({ comments: visible, emailMatchIds: null }, { headers: COMMENTS_LIST_CACHE })
  }

  // 2. KV miss：查 DB
  // 硬超时重试：底层 fetch 长尾挂起时主动中断并重试一次，避免文章页评论区转圈 60s+
  // 超时降级：DB 不可用时返回过期 KV 数据（stale-while-error），而非空列表/500
  type CommentRow = {
    id: number; parentId: number | null; postSlug: string; userId: string
    userName: string; userEmail: string; body: string
    createdAt: Date; editedAt: Date | null; status: string; likes: number
  }
  const rows = (await dbApi.withDbRetry(
    () =>
      dbApi.useDb()
        .select(commentColumns)
        .from(comments)
        .where(eq(comments.postSlug, postSlug))
        .orderBy(asc(comments.createdAt), asc(comments.id)),
    { timeoutMs: 12_000 },
  ).catch(async () => {
    // DB 超时：用过期 KV 数据降级（用户至少能看到旧评论，而非空列表）
    const stale = await getCommentsFromCache(postSlug, true)
    if (stale) {
      return stale.rows.map((r) => ({
        ...r,
        createdAt: new Date(r.createdAt),
        editedAt: r.editedAt ? new Date(r.editedAt) : null,
      }))
    }
    return []
  })) as CommentRow[]

  // 软删过滤：已发布评论全部保留；被软删的评论仅当其下还有保留的回复时
  // 才作为占位保留（回复默认保留），否则彻底隐藏。
  const kept = new Set<number>(rows.filter((r) => r.status === 'published').map((r) => r.id))
  for (const r of rows) {
    if (r.status !== 'published' && r.parentId == null) {
      const hasKeptReply = rows.some((c) => c.parentId === r.id && kept.has(c.id))
      if (hasKeptReply) kept.add(r.id)
    }
  }
  const visibleRows = rows.filter((r) => kept.has(r.id))
  // 个签 + 标签单条 profiles 查询合并取回（原两条串行 SQL → 一次往返）
  const userIds = visibleRows.map((r) => r.userId)
  const { signatureMap, tagsMap } = await dbApi.getCommenterMaps(userIds).catch(() => ({ signatureMap: {}, tagsMap: {} }))

  // 写入 KV 缓存（仅公开数据，不含个性化字段）
  // 用 runInBackground 确保 KV 写入在请求结束后继续完成（Workers 中未 await 的
  // Promise 可能在请求结束时被取消，导致 KV 没写入）
  const cacheRows: CachedCommentRow[] = rows.map((r) => ({
    id: r.id,
    parentId: r.parentId,
    postSlug: r.postSlug,
    userId: r.userId,
    userName: r.userName,
    userEmail: r.userEmail,
    body: r.body,
    createdAt: new Date(r.createdAt).toISOString(),
    editedAt: r.editedAt ? new Date(r.editedAt).toISOString() : null,
    status: r.status,
    likes: r.likes,
  }))
  runInBackground(setCommentsCache(postSlug, { rows: cacheRows, signatureMap, tagsMap }))

  const visible = visibleRows.map((r) => toCommentPayload(r, viewer, signatureMap, tagsMap))

  return Response.json({ comments: visible, emailMatchIds: null }, {
    headers: COMMENTS_LIST_CACHE,
  })
}

const fileRouterCommentsPost = async (request: Request) => {
  const user = await dbApi.getCurrentUser()
  if (!user?.email) {
    return Response.json({ error: '请先登录并完成邮箱验证。' }, { status: 401 })
  }

  const parsed = commentSchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return Response.json({ error: '评论需为 2–4000 个字符。' }, { status: 422 })
  }
  const { postSlug, body, parentId } = parsed.data

  // 违禁词检测（个签/反馈共用同一词表）
  const banned = await dbApi.containsBannedWord(body)
  if (banned) {
    return Response.json({ error: `评论包含违禁内容（命中词：${banned}），请修改后重试。` }, { status: 422 })
  }

  // 回复校验：目标必须存在、属于同一篇文章、状态正常且本身是顶层评论（回复只有一层）
  if (parentId != null) {
    const [parent] = await dbApi.useDb()
      .select({ id: comments.id, postSlug: comments.postSlug, parentId: comments.parentId, status: comments.status })
      .from(comments)
      .where(eq(comments.id, parentId))
      .limit(1)
    if (!parent || parent.postSlug !== postSlug || parent.status !== 'published' || parent.parentId != null) {
      return Response.json({ error: '回复目标不存在或不可回复。' }, { status: 400 })
    }
  }

  const displayName = user.name || user.email.split('@')[0]

  const [created] = await dbApi.useDb()
    .insert(comments)
    .values({
      postSlug,
      body,
      parentId: parentId ?? null,
      userId: user.id,
      userEmail: user.email,
      userName: displayName,
    })
    .returning(commentColumns)

  // 资料注入（个签+标签单查询）与管理员状态互不依赖：并行，3 个串行往返 → 1 个
  const [{ signatureMap: sigMap, tagsMap }, status] = await Promise.all([
    dbApi.getCommenterMaps([user.id]).catch(() => ({ signatureMap: {} as Record<string, string>, tagsMap: {} as Record<string, number[]> })),
    dbApi.getAdminStatus(),
  ])
  const viewer: Viewer = { id: user.id, email: user.email, isAdmin: status.isAdmin }
  invalidateCommentsCache(postSlug)
  return Response.json({ comment: toCommentPayload(created!, viewer, sigMap, tagsMap) }, { status: 201 })
}

// PATCH /api/comments { id, body } → 编辑评论（本人或管理员），记录最后编辑时间
async function handleCommentPatch(request: Request): Promise<Response> {
  const user = await dbApi.getCurrentUser()
  if (!user?.email) return Response.json({ error: '请先登录。' }, { status: 401 })

  const parsed = z.object({ id: z.number().int().positive(), body: z.string().trim().min(2).max(4000) })
    .safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: '评论需为 2–4000 个字符。' }, { status: 422 })

  // 目标评论查询与管理员状态查询互不依赖：并行省一个往返
  const [rowRows, status] = await Promise.all([
    dbApi.useDb().select(commentColumns).from(comments).where(eq(comments.id, parsed.data.id)).limit(1),
    dbApi.getAdminStatus(),
  ])
  const row = rowRows[0]
  if (!row) return Response.json({ error: '评论不存在。' }, { status: 404 })
  if (row.status !== 'published') return Response.json({ error: '该评论已删除，无法编辑。' }, { status: 400 })

  const isOwner = row.userId === user.id || row.userEmail.toLowerCase() === user.email.toLowerCase()
  if (!status.isAdmin && !isOwner) {
    return Response.json({ error: '只能编辑自己的评论。' }, { status: 403 })
  }

  // 违禁词检测（管理员编辑同样拦截，避免违规内容留存）
  const banned = await dbApi.containsBannedWord(parsed.data.body)
  if (banned) {
    return Response.json({ error: `评论包含违禁内容（命中词：${banned}），请修改后重试。` }, { status: 422 })
  }

  const [updated] = await dbApi.useDb()
    .update(comments)
    .set({ body: parsed.data.body, editedAt: sql`NOW()` })
    .where(eq(comments.id, parsed.data.id))
    .returning(commentColumns)
  // 个签 + 标签合并为单查询（原两条串行 SQL）
  const { signatureMap: sigMap, tagsMap } = await dbApi
    .getCommenterMaps([updated!.userId])
    .catch(() => ({ signatureMap: {} as Record<string, string>, tagsMap: {} as Record<string, number[]> }))
  const viewer: Viewer = { id: user.id, email: user.email, isAdmin: status.isAdmin }
  invalidateCommentsCache(row.postSlug)
  return Response.json({ comment: toCommentPayload(updated!, viewer, sigMap, tagsMap) })
}

// DELETE /api/comments?id=ID&cascade=1 → 软删评论；cascade 仅管理员可用，级联软删全部直接回复
async function handleCommentDelete(_request: Request, url: URL): Promise<Response> {
  const user = await dbApi.getCurrentUser()
  if (!user?.email) return Response.json({ error: '请先登录。' }, { status: 401 })

  const id = Number(url.searchParams.get('id'))
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: '评论标识不合法。' }, { status: 400 })

  // 目标评论查询与管理员状态查询互不依赖：并行省一个往返
  const [rowRows, status] = await Promise.all([
    dbApi.useDb().select(commentColumns).from(comments).where(eq(comments.id, id)).limit(1),
    dbApi.getAdminStatus(),
  ])
  const row = rowRows[0]
  if (!row) return Response.json({ error: '评论不存在。' }, { status: 404 })

  const isOwner = row.userId === user.id || row.userEmail.toLowerCase() === user.email.toLowerCase()
  if (!status.isAdmin && !isOwner) {
    return Response.json({ error: '只能删除自己的评论。' }, { status: 403 })
  }

  const cascade = url.searchParams.get('cascade') === '1'
  if (cascade && !status.isAdmin) {
    return Response.json({ error: '仅管理员可以级联删除全部回复。' }, { status: 403 })
  }

  // 级联：软删该评论下的全部保留回复（回复只有一层，直接子级即全部）
  if (cascade) {
    await dbApi.useDb()
      .update(comments)
      .set({ status: 'deleted' })
      .where(and(eq(comments.parentId, id), eq(comments.status, 'published')))
  }
  // 软删本体（正文保留在库中，前台隐藏；若有保留回复则显示占位）
  await dbApi.useDb().update(comments).set({ status: 'deleted' }).where(eq(comments.id, id))
  invalidateCommentsCache(row.postSlug)
  return Response.json({ ok: true })
}

// ── MTProto（用户会话）大文件直传：配置/登记/自检 ─────────────────────

async function handleMtStatusGet(): Promise<Response> {
  try {
    await dbApi.requireAdmin()
  } catch {
    return Response.json({ error: '需要管理员登录。' }, { status: 401 })
  }
  const mt = await import('../lib/mtproto-store.js')
  const [cfg, session, chat] = await Promise.all([mt.getMtConfig(), mt.getMtSession(), mt.getMtChat()])
  return Response.json({
    configured: !!(cfg && session && chat),
    // 自建本地 Bot API 网关可用（大文件优先走它，无需 MTProto 个人会话）
    gateway: !!gatewayConfig(),
    hasConfig: !!cfg,
    hasSession: !!session,
    chat: chat ? { id: chat.id } : null,
  }, { headers: PRIVATE_NO_STORE })
}

/** 管理员浏览器取回会话凭据：仅用于管理员自己的上传页（账号所有者本人） */
async function handleMtCredsGet(): Promise<Response> {
  try {
    await dbApi.requireAdmin()
  } catch {
    return Response.json({ error: '需要管理员登录。' }, { status: 401 })
  }
  const mt = await import('../lib/mtproto-store.js')
  const [cfg, session, chat] = await Promise.all([mt.getMtConfig(), mt.getMtSession(), mt.getMtChat()])
  if (!cfg || !session) return Response.json({ error: '尚未登录 MTProto。' }, { status: 404 })
  return Response.json({
    apiId: cfg.apiId,
    apiHash: cfg.apiHash,
    session,
    chat: chat ? { id: chat.id, accessHash: chat.accessHash } : null,
  }, { headers: PRIVATE_NO_STORE })
}

async function handleMtSaveSessionPost(request: Request): Promise<Response> {
  try {
    await dbApi.requireAdmin()
  } catch {
    return Response.json({ error: '需要管理员登录。' }, { status: 401 })
  }
  const parsed = z.object({
    apiId: z.number().int().positive(),
    apiHash: z.string().trim().min(8).max(64),
    session: z.string().trim().min(10).max(2048),
  }).safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: '登录信息不合法。' }, { status: 400 })
  const mt = await import('../lib/mtproto-store.js')
  await mt.saveMtConfig({ apiId: parsed.data.apiId, apiHash: parsed.data.apiHash })
  await mt.saveMtSession(parsed.data.session)
  mt.dropMtClient()
  return Response.json({ ok: true })
}

async function handleMtSaveChatPost(request: Request): Promise<Response> {
  try {
    await dbApi.requireAdmin()
  } catch {
    return Response.json({ error: '需要管理员登录。' }, { status: 401 })
  }
  const parsed = z.object({
    id: z.string().trim().min(2).max(64).regex(/^-?\d+$/),
    accessHash: z.string().trim().max(40).regex(/^-?\d+$/).optional(),
  }).safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: '频道 id 不合法。' }, { status: 400 })
  const mt = await import('../lib/mtproto-store.js')
  await mt.saveMtChat({ id: parsed.data.id, accessHash: parsed.data.accessHash || '0' })
  return Response.json({ ok: true })
}

async function handleMtClearPost(): Promise<Response> {
  try {
    await dbApi.requireAdmin()
  } catch {
    return Response.json({ error: '需要管理员登录。' }, { status: 401 })
  }
  const mt = await import('../lib/mtproto-store.js')
  mt.dropMtClient()
  await mt.clearMtSession()
  return Response.json({ ok: true })
}

/** 浏览器直传完成后登记附件（manifest 由浏览器从 sendFile 结果组装） */
async function handleMtCompletePost(request: Request): Promise<Response> {
  try {
    await dbApi.requireAdmin()
  } catch {
    return Response.json({ error: '需要管理员登录。' }, { status: 401 })
  }
  const mt = await import('../lib/mtproto-store.js')
  if (!(await mt.isMtConfigured())) return Response.json({ error: 'MTProto 尚未配置。' }, { status: 503 })
  const parsed = z.object({
    postSlug: z.string().trim().min(1).max(160),
    filename: z.string().trim().min(1).max(255),
    size: z.number().int().positive().max(ATTACHMENT_DIRECT_MAX_BYTES),
    contentType: z.string().max(255).optional(),
    password: z.string().max(512).optional(),
    chat: z.object({
      id: z.string().min(2).max(64),
      accessHash: z.string().max(40).optional(),
    }),
    part: z.object({
      m: z.number().int().positive(),
      id: z.string().min(5).max(32),
      a: z.string().min(1).max(40),
      d: z.number().int().min(1).max(10),
      s: z.number().int().min(0).max(ATTACHMENT_DIRECT_MAX_BYTES),
    }),
  }).safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: '登记参数不合法。' }, { status: 400 })
  const d = parsed.data
  const key = mt.encodeMtManifest({
    c: d.chat.id,
    a: d.chat.accessHash || '0',
    p: [{ m: d.part.m, id: d.part.id, a: d.part.a, d: d.part.d, s: d.part.s }],
  })
  const existed = await dbApi.getAttachmentByStorageKey(key).catch(() => null)
  if (existed) return Response.json({ attachment: existed })
  try {
    const row = await dbApi.insertAttachment({
      postSlug: d.postSlug,
      filename: d.filename,
      mimeType: d.contentType || 'application/octet-stream',
      sizeBytes: d.size,
      storageKey: key,
      password: d.password || undefined,
    })
    return Response.json({ attachment: row }, { status: 201 })
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : '登记附件失败。' }, { status: 502 })
  }
}

/** Worker 侧 MTProto 自检：连接 → getMe → 读取绑定频道（验证会话与频道权限） */
async function handleMtSelftestGet(): Promise<Response> {
  try {
    await dbApi.requireAdmin()
  } catch {
    return Response.json({ error: '需要管理员登录。' }, { status: 401 })
  }
  const mt = await import('../lib/mtproto-store.js')
  const noStore = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' }
  const page = (inner: string) =>
    new Response(`<!doctype html><meta charset="utf-8"><title>MTProto 自检</title>
    <body style="font:15px/1.7 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px">
    <h1>MTProto 附件链路自检</h1>${inner}<p><a href="/mt-setup">← 返回 MT 设置页</a></p></body>`, { headers: noStore })
  const log: string[] = []
  try {
    if (!(await mt.isMtConfigured())) return page('<p style="color:#c0392b">尚未完成登录与频道绑定。</p>')
    const client = await mt.getMtClient()
    const [{ Api }, { default: bigInt }] = await Promise.all([import('telegram'), import('big-integer')])
    log.push('① WSS 连接成功')
    const me = await client.getMe()
    log.push(`② 账号校验通过：<b>${escHtml((me as { firstName?: string }).firstName || '已登录用户')}</b>（id=${String(me.id)}）`)
    const chat = await mt.getMtChat()
    if (chat) {
      await client.invoke(new Api.channels.GetChannels({
        id: [new Api.InputChannel({
          channelId: bigInt(mt.channelIdFromMarked(chat.id).toString()),
          accessHash: bigInt(chat.accessHash || '0'),
        })],
      }))
      log.push(`③ 频道 ${escHtml(chat.id)} 可读（账号在频道内、accessHash 有效）`)
    }
    log.push('<b style="color:#1a7f37">✓ Worker 侧 MTProto 正常。请实际上传一个文件验证全链路与下载。</b>')
    return page(`<ul>${log.map((x) => `<li>${x}</li>`).join('')}</ul>`)
  } catch (e) {
    log.push(`<b style="color:#c0392b">失败：${escHtml(e instanceof Error ? e.message : String(e))}</b>`)
    return page(`<ul>${log.map((x) => `<li>${x}</li>`).join('')}</ul>`)
  }
}

export const Route = createFileRoute('/api/comments')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const action = url.searchParams.get('action')
        if (action === 'file') return handleFileGet(request, url)
        if (action === 'file-urls') return handleFileUrlsGet(url)
        if (action === 'feedbackFile') return handleFeedbackFileGet(url)
        if (action === 'adminStatus') return handleAdminStatusGet()
        if (action === 'tg-probe') return handleTgProbeGet(request, url)
        if (action === 'tg-selftest') return handleTgSelftestGet()
        if (action === 'mt-status') return handleMtStatusGet()
        if (action === 'mt-creds') return handleMtCredsGet()
        if (action === 'mt-selftest') return handleMtSelftestGet()
        if (action === 'rss') return handleRss(request)
        return fileRouterCommentsGet(request)
      },
      POST: async ({ request }) => {
        const url = new URL(request.url)
        const action = url.searchParams.get('action')
        if (action === 'token') return handleTokenPost(request, url)
        if (action === 'record-download') return handleRecordDownloadPost(url)
        if (action === 'convert-poll') return handleConvertPollPost(request)
        if (action === 'convert-done') return handleConvertDonePost(request)
        if (action === 'upload') return handleUploadPost(request)
        if (action === 'feedbackUpload') return handleFeedbackUploadPost(request)
        if (action === 'mp-start') return handleMpStartPost(request)
        if (action === 'mp-part') return handleMpPartPost(request)
        if (action === 'mp-complete') return handleMpCompletePost(request)
        if (action === 'mp-abort') return handleMpAbortPost(request)
        if (action === 'mt-save-session') return handleMtSaveSessionPost(request)
        if (action === 'mt-save-chat') return handleMtSaveChatPost(request)
        if (action === 'mt-clear') return handleMtClearPost()
        if (action === 'mt-complete') return handleMtCompletePost(request)
        return fileRouterCommentsPost(request)
      },
      PATCH: async ({ request }) => handleCommentPatch(request),
      DELETE: async ({ request }) => handleCommentDelete(request, new URL(request.url)),
    },
  },
})
