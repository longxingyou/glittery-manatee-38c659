import { createFileRoute } from '@tanstack/react-router'

import * as dbApi from '../../db/index.js'
import { getEnv, getPublicOrigin } from '../lib/server-env.js'
import { TtlCache, edgeCacheGet, edgeCacheSet } from '../lib/cache.js'

/**
 * /api/net —— 管理后台「网络工具」（方案 C）
 *
 * 设计原则：
 * - 仅管理员可用（sg_auth + ADMIN_EMAILS，复用 dbApi.requireAdmin）；
 * - 只做文件/API/文本级中转，不做整站反代、不跑代理协议、不碰视频；
 * - GitHub 下载默认「边缘解析 + 302 直跳官方对象存储」，字节不经过 CF，
 *   只有直连失败时才由 mode=pipe 流式中转（一个文件只算 1 次 Worker 请求）；
 * - 所有响应 no-store + noindex，不进任何缓存层。
 */

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store, must-revalidate',
  'X-Robots-Tag': 'noindex, nofollow',
} as const

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

// Chrome 126 的 Sec-Ch-Ua 链（与 BROWSER_UA 版本对齐）。国内站风控常校验此头，
// 缺失会被判定为非浏览器请求直接 403。
const SEC_CH_UA = '"Chromium";v="126", "Not(A:Brand";v="24", "Google Chrome";v="126"'

const FETCH_TEXT_LIMIT = 4 * 1024 * 1024 // 通用文本/API 抓取上限 4MiB
const READER_HTML_LIMIT = 2 * 1024 * 1024 // 阅读模式 HTML 上限 2MiB
const DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024 // 通用下载中转上限 200MiB（超过则截断或拒绝）

/**
 * 构建反风控请求头：模拟真实 Chrome 浏览器发出的请求。
 *
 * 国内大量站点（知乎、CSDN、豆瓣、微信读书、书源站等）对服务端抓取做了风控：
 * 缺少 Sec-Fetch-* / Sec-Ch-Ua* / Accept-Language / Upgrade-Insecure-Requests
 * 等头会被 WAF 直接拒绝。Worker 默认 fetch 不带这些头，必须显式补齐。
 *
 * @param mode  'navigate'=模拟地址栏输入访问页面（reader/搜索），'cors'=模拟页面内资源/API 请求（fetch）
 * @param accept  自定义 Accept 头
 * @param referer  Referer 头；不提供时按同源路径推导
 */
function buildBrowserHeaders(
  opts: { mode?: 'navigate' | 'cors'; accept?: string; referer?: string } = {},
): Record<string, string> {
  const { mode = 'navigate', accept, referer } = opts
  const headers: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br', // Worker 自动解压，上游以为是真实浏览器
    'Sec-Ch-Ua': SEC_CH_UA,
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    DNT: '1',
    ...(mode === 'navigate'
      ? {
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
        }
      : {
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
        }),
  }
  if (accept) headers.Accept = accept
  if (referer) headers.Referer = referer
  return headers
}

function jsonError(error: string, status = 400, extra?: Record<string, unknown>): Response {
  return Response.json({ ok: false, error, ...extra }, { status, headers: PRIVATE_HEADERS })
}

async function requireAdminOr401(): Promise<Response | null> {
  try {
    await dbApi.requireAdmin()
    return null
  } catch {
    return jsonError('需要管理员登录。', 401)
  }
}

// ────────────────────────────────────────────────────────────
// 分享模式：免登录加密链接（先到先得绑定单设备；管理员在后台管理）
// ────────────────────────────────────────────────────────────

function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get('cookie')
  if (!raw) return null
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim()
  }
  return null
}

/** 访问控制：管理员 cookie → 'admin'；否则 SG_SHARE 分享 cookie → 'share'；皆失败 → 401 */
async function requireNetAccess(request: Request): Promise<{ via: 'admin' | 'share' } | Response> {
  try {
    await dbApi.requireAdmin()
    return { via: 'admin' }
  } catch {
    // 继续尝试分享凭证
  }
  try {
    if (await dbApi.verifyNetShareCookie(readCookie(request, dbApi.SHARE_COOKIE_NAME))) {
      return { via: 'share' }
    }
  } catch {
    // DB 异常等视为无权限
  }
  return jsonError('需要管理员登录或有效的分享链接。', 401)
}

function shareHtmlPage(title: string, message: string, status: number): Response {
  const page =
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
    `<body style="font:15px system-ui;padding:48px 24px;max-width:560px;margin:0 auto;line-height:1.7">` +
    `<h2 style="margin:0 0 12px">${escapeHtml(title)}</h2><p style="margin:0;color:#57606a">${escapeHtml(message)}</p></body></html>`
  return new Response(page, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...PRIVATE_HEADERS } })
}

/** action=claim：打开分享链接，先到先得绑定设备（种 SG_SHARE cookie）后跳转 /share */
async function handleClaimGet(request: Request, url: URL): Promise<Response> {
  const token = (url.searchParams.get('t') || '').trim()
  if (!token) return shareHtmlPage('链接无效', '缺少分享令牌，请核对链接是否完整。', 400)
  const result = await dbApi.claimNetShareLink(token, readCookie(request, dbApi.SHARE_COOKIE_NAME))
  if (result.status === 'invalid') return shareHtmlPage('链接无效', '链接不存在或已被管理员删除。', 400)
  if (result.status === 'disabled') return shareHtmlPage('分享已关闭', '管理员已关闭分享模式，全部链接已失效。', 403)
  if (result.status === 'taken') {
    return shareHtmlPage('链接已被占用', '此链接已在其他设备上绑定使用（每个链接仅限一人）。如需换绑，请联系管理员重置绑定。', 403)
  }
  const origin = getPublicOrigin(request)
  const headers = new Headers(PRIVATE_HEADERS)
  headers.set('Location', `${origin}/share`)
  if (result.status === 'bound') {
    headers.set(
      'Set-Cookie',
      `${dbApi.SHARE_COOKIE_NAME}=${result.id}.${result.secret}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${dbApi.SHARE_COOKIE_MAX_AGE}`,
    )
  }
  return new Response(null, { status: 302, headers })
}

/** action=share_info：/share 页面挂载时自检访问权限 */
async function handleShareInfoGet(request: Request): Promise<Response> {
  const access = await requireNetAccess(request)
  if (access instanceof Response) return access
  return Response.json({ ok: true, via: access.via }, { headers: PRIVATE_HEADERS })
}

/** POST：分享模式管理动作（仅管理员） */
async function handleSharePost(request: Request): Promise<Response> {
  const denied = await requireAdminOr401()
  if (denied) return denied
  let body: { action?: string; id?: string; enabled?: boolean } = {}
  try {
    body = (await request.json()) as typeof body
  } catch {
    return jsonError('请求体不是有效的 JSON。')
  }
  const action = body.action || ''
  if (action === 'share_list') {
    const { enabled, links } = await dbApi.listNetShareLinks()
    return Response.json({ ok: true, enabled, links }, { headers: PRIVATE_HEADERS })
  }
  if (action === 'share_create') {
    const { id, token } = await dbApi.createNetShareLink()
    return Response.json({ ok: true, id, token }, { headers: PRIVATE_HEADERS })
  }
  if (action === 'share_delete') {
    if (!body.id) return jsonError('缺少链接 id。')
    await dbApi.deleteNetShareLink(body.id)
    return Response.json({ ok: true }, { headers: PRIVATE_HEADERS })
  }
  if (action === 'share_reset') {
    if (!body.id) return jsonError('缺少链接 id。')
    await dbApi.resetNetShareLink(body.id)
    return Response.json({ ok: true }, { headers: PRIVATE_HEADERS })
  }
  if (action === 'share_toggle') {
    const { token } = await dbApi.setNetShareEnabled(body.enabled === true)
    // 开启且原本无链接时自动补建一条，明文 token 仅此一次返回
    return Response.json({ ok: true, enabled: body.enabled === true, token }, { headers: PRIVATE_HEADERS })
  }
  return jsonError('未知的分享管理动作。', 404)
}

// ────────────────────────────────────────────────────────────
// action=gh：GitHub 加速
// ────────────────────────────────────────────────────────────

const GH_HOST_SUFFIXES = ['github.com', 'githubusercontent.com', 'githubassets.com']

function isGithubHost(host: string): boolean {
  const h = host.toLowerCase()
  return GH_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`))
}

/**
 * 规范化 GitHub URL：
 * - github.com/:o/:r/blob/:ref/... → raw.githubusercontent.com/:o/:r/:ref/...
 * - github.com/:o/:r/raw/:ref/...  → raw.githubusercontent.com/:o/:r/:ref/...
 * 其余（releases/download、archive、codeload、api、objects 等）原样保留。
 */
function normalizeGithubUrl(raw: string): URL | null {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || !isGithubHost(u.hostname)) return null
  if (u.port !== '') return null
  const m = /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/.exec(u.pathname)
  if (m && u.hostname.toLowerCase() === 'github.com') {
    const [, owner, repo, rest] = m
    return new URL(`https://raw.githubusercontent.com/${owner}/${repo}/${rest}${u.search}`)
  }
  return u
}

const GH_PASSTHROUGH_HEADERS = [
  'content-type',
  'content-length',
  'content-disposition',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
] as const

/** 把上游响应（含 206 分片/错误页）流式转回客户端，只保留安全的实体头 */
function pipeGithub(res: Response): Response {
  const headers = new Headers()
  for (const name of GH_PASSTHROUGH_HEADERS) {
    const v = res.headers.get(name)
    if (v != null) headers.set(name, v)
  }
  headers.set('Cache-Control', 'private, max-age=3600')
  headers.set('X-Robots-Tag', 'noindex, nofollow')
  // worker.ts 会对流式 body 删除 Content-Length（chunked 传输），此处保留无害
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

async function handleGithubGet(request: Request, url: URL): Promise<Response> {
  const access = await requireNetAccess(request)
  if (access instanceof Response) return access

  const rawUrl = url.searchParams.get('u') || ''
  const target = normalizeGithubUrl(rawUrl)
  if (!target) return jsonError('仅支持 github.com / githubusercontent.com / githubassets.com 的 HTTPS 链接。')
  const mode = url.searchParams.get('mode') === 'pipe' ? 'pipe' : 'auto'

  const range = request.headers.get('range')
  const baseInit: RequestInit = {
    method: 'GET',
    redirect: 'manual',
    headers: { 'User-Agent': BROWSER_UA, ...(range ? { Range: range } : {}) },
  }

  // pipe：跟随重定向（最多 5 跳），字节全部经 Worker 中转，支持 Range/断点续传
  if (mode === 'pipe') {
    const res = await fetch(new Request(target.toString(), { ...baseInit, redirect: 'follow' } as RequestInit))
    return pipeGithub(res)
  }

  // auto：在边缘跟随 github.com → objects.githubusercontent.com 的重定向。
  // 一旦拿到对象存储/CDN 地址（githubusercontent.com / githubassets.com），
  // 直接 302 让浏览器直连下载——release 大文件字节不经过 CF（规避 ToS 2.8、零带宽）。
  // raw / codeload 等直接返回 200 的地址则就地流式中转。
  let current = target
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(new Request(current.toString(), baseInit))
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) return pipeGithub(res)
      let next: URL
      try {
        next = new URL(loc, current)
      } catch {
        return pipeGithub(res)
      }
      try { res.body?.cancel() } catch { /* ignore */ }
      if (isGithubHost(next.hostname) && next.hostname.toLowerCase() !== 'github.com') {
        const headers = new Headers(PRIVATE_HEADERS)
        headers.set('Location', next.toString())
        return new Response(null, { status: 302, headers })
      }
      current = next
      continue
    }
    return pipeGithub(res)
  }
  return jsonError('GitHub 重定向层级过多。', 502)
}

// ────────────────────────────────────────────────────────────
// action=fetch：管理员通用文本/JSON API 抓取
// ────────────────────────────────────────────────────────────

const TEXT_TYPE_PREFIXES = ['application/json', 'text/', 'application/xml', 'application/xhtml', 'application/javascript']

function isSafePublicUrl(raw: string): URL | null {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  // 回国线路：允许 HTTP（大量中国站点仍用 HTTP；Worker→origin 为服务端连接，MITM 风险低）
  // 用户明确要求"更激进方便"——去掉 HTTPS-only 与端口限制，SSRF 防护（内网/私有 IP）保留
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const h = u.hostname.toLowerCase().replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return null
  if (h === '127.0.0.1' || h === '0.0.0.0' || h === '[::1]' || h === '169.254.169.254' || h === 'metadata.google.internal') return null
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const octets = v4.slice(1).map(Number)
    const [a, b] = octets
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 169) return null
  }
  u.username = ''
  u.password = ''
  return u
}

/**
 * 已知被 Cloudflare Worker 出口 IP 屏蔽的主机 → 可用别名映射。
 *
 * 背景：部分站点（如 CSDN www.csdn.net）的源站对 Cloudflare Worker IP 段做了
 * TCP 层拒绝，返回 Cloudflare 521。但其博客子域（blog.csdn.net）未受影响。
 * 这里把被屏蔽的主机自动改写为可访问的别名，保留路径和查询参数。
 */
const BLOCKED_HOST_REWRITES: Record<string, string> = {
  'www.csdn.net': 'blog.csdn.net',
}

function rewriteBlockedHost(u: URL): URL {
  const h = u.hostname.toLowerCase()
  const alias = BLOCKED_HOST_REWRITES[h]
  if (!alias) return u
  const rewritten = new URL(u.toString())
  rewritten.hostname = alias
  return rewritten
}

/**
 * 检测访问是否被站点拦截（WAF/反爬/Cloudflare 错误等）。
 * 返回 kind 分级：
 * - 'hard'：源站网络层明确不可达（Cloudflare 5xx）——reader 自动走 Wayback 存档回退；
 * - 'soft'：WAF 风控（403/412/429、人机验证页）——可能只是暂时拦截，reader 仅提示 +
 *   手动回退入口，不自动跳 Wayback（避免误判时滥用 archive.org 配额、拖垮正常浏览）。
 *
 * 关键词只查 <title>（验证页标题固定）和已知固定错误体，绝不扫正文——
 * 否则正文提到这些词的正常页面（如 Wikipedia 的 CAPTCHA 词条、反爬技术文章、
 * 含关键词的搜索结果摘要）会被误判拦截。
 */
function detectBlock(status: number, bodyText: string): { kind: 'hard' | 'soft'; code: number; hint: string } | null {
  // 1) Cloudflare 5xx：状态码是权威信号；状态码正常时，仅当响应前段同时出现
  //    cloudflare 标记 + 错误码才认定（避免 API 返回 {"status":500} 之类的数据被误伤）
  const head = bodyText.slice(0, 5000)
  let cfCode = 0
  if (status >= 520 && status <= 530) cfCode = status
  else if (/cloudflare/i.test(head)) {
    const m = /Error code\s*(5[0-9]{2})/i.exec(head) || /"status"\s*:\s*(5[0-9]{2})/.exec(head)
    if (m) cfCode = parseInt(m[1]!, 10)
  }
  if (cfCode) {
    const hints: Record<number, string> = {
      521: '源站拒绝了来自服务器的连接（该站点可能屏蔽了 Cloudflare IP 段）。',
      522: '服务器连接源站超时。',
      523: '源站不可达（可能 DNS 解析失败或源站宕机）。',
      524: '源站响应超时。',
      520: '源站返回了未知错误。',
      525: 'TLS 握手失败。',
      526: '源站证书无效。',
      530: '源站 DNS 解析失败。',
    }
    return { kind: 'hard', code: cfCode, hint: hints[cfCode] || '源站返回了 Cloudflare 错误。' }
  }

  // 2) WAF 状态码 → 软失败
  if (status === 403 || status === 412 || status === 429) {
    const wafHints: Record<number, string> = {
      403: '该页面禁止访问（可能需要登录或触发了反爬策略）。',
      412: '请求被站点 WAF 拦截（如 B站的数据中心 IP 风控）。',
      429: '请求过于频繁，被站点限流。',
    }
    return { kind: 'soft', code: status, hint: wafHints[status] || '请求被站点拦截。' }
  }

  // 3) 人机验证页：只查 <title>。中文验证页标题固定（整词匹配），
  //    英文 WAF 页标题含独特短语（子串匹配）。
  //    注意不能用 ^ 锚定——真实 HTML 的 <title> 前有 doctype/html/head 标签。
  const title = (/<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(bodyText)?.[1] || '').replace(/\s+/g, ' ').trim()
  if (
    /^(?:百度安全验证|安全验证|人机验证|滑块验证|请完成验证|请输入验证码)$/i.test(title) ||
    /Just a moment|Attention Required|Access Denied|unusual traffic/i.test(title)
  ) {
    return { kind: 'soft', code: status, hint: '站点返回了人机验证页。' }
  }
  // 4) 已知固定错误体（仅匹配响应开头，如 B站 JSON {"code":-412,...}）
  if (/^\s*\{\s*"code"\s*:\s*-412/.test(bodyText.slice(0, 100))) {
    return { kind: 'soft', code: 412, hint: '请求被站点 WAF 拦截（数据中心 IP 风控）。' }
  }

  return null
}

/**
 * 查询 Wayback Machine 是否有该 URL 的存档。
 * 返回存档 URL（如 https://web.archive.org/web/2024.../https://...），无存档则返回 null。
 * 带超时保护，避免 archive.org 慢时拖垮 reader。
 */
// Wayback 存档查询缓存（同 isolate 内复用，减少对 archive.org 的请求次数）
const wbCache = new TtlCache<string | null>(200)

/**
 * 查询 Wayback Machine 是否有 targetUrl 的存档。
 * 为缓解 archive.org 对数据中心 IP 的限流（429），采用：
 * 1. 浏览器请求头伪装（Referer + Accept）
 * 2. 429 时退避 2s 重试一次
 * 3. 进程内缓存 1 小时，同 URL 不重复查询
 */
async function tryWaybackArchive(targetUrl: string): Promise<string | null> {
  const cacheKey = `wb:${targetUrl}`
  const cached = wbCache.get(cacheKey)
  if (cached !== undefined) return cached

  const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(targetUrl)}`

  // L2 边缘缓存（caches.default，同 colo 跨 isolate 共享）：进一步削减 archive.org 请求。
  // 值以 JSON 字符串存储——"null"（无存档）与未缓存（null 返回值）可区分。
  const edgeHit = await edgeCacheGet(apiUrl)
  if (edgeHit !== null) {
    try {
      const url = JSON.parse(edgeHit) as string | null
      wbCache.set(cacheKey, url, 300_000)
      return url
    } catch { /* 缓存体异常则回源查询 */ }
  }

  const wbHeaders = {
    'User-Agent': BROWSER_UA,
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://web.archive.org/',
    'Accept-Language': 'en-US,en;q=0.9',
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(apiUrl, { headers: wbHeaders, signal: AbortSignal.timeout(10000) })
      if (res.status === 429) {
        // 限流：退避 2 秒后重试一次
        if (attempt === 0) { await new Promise((r) => setTimeout(r, 2000)); continue }
        wbCache.set(cacheKey, null, 60_000) // 限流时短缓存 1 分钟，避免反复打
        return null
      }
      if (!res.ok) return null
      const data = (await res.json()) as { archived_snapshots?: { closest?: { url?: string } } }
      const url = data.archived_snapshots?.closest?.url || null
      wbCache.set(cacheKey, url, 3600_000) // 缓存 1 小时
      // 边缘缓存：有存档 24h；无存档 10 分钟（新存档出现后不至于太久不可见）
      await edgeCacheSet(apiUrl, JSON.stringify(url), url ? 86_400 : 600)
      return url
    } catch {
      if (attempt === 0) { await new Promise((r) => setTimeout(r, 2000)); continue }
      return null
    }
  }
  return null
}

async function readCapped(res: Response, max: number): Promise<{ text: string; truncated: boolean; bytes: number }> {
  if (!res.body) return { text: '', truncated: false, bytes: 0 }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > max) {
        chunks.push(value.subarray(0, Math.max(0, max - (total - value.byteLength))))
        truncated = true
        try { await res.body.cancel() } catch { /* ignore */ }
        break
      }
      chunks.push(value)
    }
  }
  const merged = new Uint8Array(Math.min(total, max))
  let off = 0
  for (const c of chunks) {
    merged.set(c.subarray(0, Math.min(c.byteLength, merged.byteLength - off)), off)
    off += Math.min(c.byteLength, merged.byteLength - off)
    if (off >= merged.byteLength) break
  }
  return { text: new TextDecoder('utf-8').decode(merged), truncated, bytes: Math.min(total, max) }
}

async function handleFetchGet(request: Request, url: URL): Promise<Response> {
  const access = await requireNetAccess(request)
  if (access instanceof Response) return access

  const rawTarget = isSafePublicUrl(url.searchParams.get('u') || '')
  if (!rawTarget) return jsonError('仅支持 HTTP(S) 且非公网内网地址的 URL。')
  // 自动改写已知被 Worker IP 屏蔽的主机（如 www.csdn.net → blog.csdn.net）
  const target = rewriteBlockedHost(rawTarget)

  let res: Response
  try {
    res = await fetch(target.toString(), {
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000),
      headers: buildBrowserHeaders({ mode: 'cors', accept: 'application/json,text/*;q=0.9,*/*;q=0.5' }),
    })
  } catch (e) {
    return jsonError(`上游请求失败：${e instanceof Error ? e.message : '网络错误'}`, 502)
  }

  const ct = (res.headers.get('content-type') || '').toLowerCase()
  const { text, truncated } = await readCapped(res, FETCH_TEXT_LIMIT)

  // 检测访问是否被拦截（Cloudflare 5xx / WAF / 人机验证页），不把错误页当内容返回
  const block = detectBlock(res.status, text)
  if (block) {
    const rewritten = target.toString() !== rawTarget.toString()
      ? `（已自动尝试别名 ${target.hostname}）` : ''
    return jsonError(`${block.code}：${block.hint}${rewritten}`, 502, { upstreamStatus: block.code })
  }

  const isText = TEXT_TYPE_PREFIXES.some((p) => ct.startsWith(p)) || /\b(?:json|xml|html)\b/.test(ct)
  if (!isText) {
    return jsonError(`内容类型 ${ct || '未知'} 不是文本/JSON；请使用下方「文件下载」中转。`, 415, {
      contentType: ct,
      readerHint: ct.includes('html'),
    })
  }

  return Response.json({
    ok: true,
    status: res.status,
    finalUrl: res.url || target.toString(),
    contentType: ct,
    truncated,
    body: text,
  }, { headers: PRIVATE_HEADERS })
}

// ────────────────────────────────────────────────────────────
// action=reader：网页应急阅读模式（去脚本的静态 HTML）
// ────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/`/g, '&#96;')
}

/** 粗粒度清理：移除可执行内容与事件处理器。配合 worker.ts 的严格 CSP 双保险。 */
function sanitizeForReader(html: string): string {
  let out = html
  out = out.replace(/<!--[\s\S]*?-->/g, '')
  // 去掉嵌套的文档结构标签，避免 reader 页里出现双重 <!doctype>/<html>/<head>/<body>
  out = out.replace(/<!doctype[^>]*>/gi, '')
  out = out.replace(/<\/?html[^>]*>/gi, '')
  // 去掉整个 <head>...</head>（包括原站的 title/meta/link/script），后面统一注入
  out = out.replace(/<head[^>]*>[\s\S]*?<\/head\s*>/gi, '')
  out = out.replace(/<\/?body[^>]*>/gi, '')
  // 去掉 Wayback Machine 注入的工具栏（id 以 wm-ipp / wm-toolbar 开头）。
  // 工具栏是多层嵌套 div，非贪婪匹配只能去掉最内层，循环直到无匹配。
  const wmToolbarRe = /<div\b[^>]*\bid=["'](?:wm-ipp[^"']*|wm-toolbar[^"']*)["'][^>]*>[\s\S]*?<\/div>/gi
  let prev: string
  do { prev = out; out = out.replace(wmToolbarRe, '') } while (out !== prev)
  // 兜底：删除残留的空 wm-ipp 容器标签
  out = out.replace(/<div\b[^>]*\bid=["'](?:wm-ipp[^"']*|wm-toolbar[^"']*)["'][^>]*>\s*<\/div>/gi, '')

  out = out.replace(/<(script|style|iframe|object|embed|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
  out = out.replace(/<(?:iframe|object|embed|link|meta|base)\b[^>]*>/gi, (tag) =>
    /<meta\b[^>]+charset/i.test(tag) ? tag : '')
  out = out.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '')
  out = out.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '')
  out = out.replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, '')
  out = out.replace(/(href|src)\s*=\s*("|')\s*javascript:[\s\S]*?\2/gi, '$1="#"')
  // 注入 head 内容：charset、referrer、base target
  const head =
    `<meta charset="utf-8"><meta name="referrer" content="no-referrer">` +
    `<base target="_blank" rel="noopener noreferrer">`
  out = `${head}${out}`
  return out
}

/**
 * 服务端 URL 重写（CSP base-uri 'self' 禁用了 <base href> 指向外站，必须显式重写）：
 * - a[href]：http(s) 链接转回 reader 端点继续阅读模式浏览，新标签打开；
 *   锚点/mailto/tel 保持原样。
 * - img[src]：绝对化直链原站（CSP img-src 放行 https:）；srcset 删除避免相对路径 404。
 * - form[action]：绝对化 + 新标签（静态页面下表单基本不可用，仅保证不再 404 到本站）。
 */
function rewriteForReader(html: string, pageUrl: string, selfOrigin: string): string {
  const absolutize = (raw: string): string => {
    const v = decodeEntities(raw).trim()
    if (!v || v.startsWith('#') || /^(?:javascript|mailto|tel|data):/i.test(v)) return ''
    try {
      return new URL(v, pageUrl).toString()
    } catch {
      return ''
    }
  }
  let out = html.replace(/<a\b([^>]*?)\shref=(["'])([^"']*)\2([^>]*)>/gi, (whole, pre: string, quote: string, href: string, post: string) => {
    const abs = absolutize(href)
    if (!abs) return whole
    const proxied = `${selfOrigin}/api/net?action=reader&u=${encodeURIComponent(abs)}`
    const hasTarget = /\starget=/i.test(pre + post)
    const extra = hasTarget ? '' : ' target="_blank" rel="noopener noreferrer"'
    return `<a${pre} href=${quote}${escapeAttr(proxied)}${quote}${post}${extra}>`
  })
  // img[src]：走 download 端点代理，避免国内打不开的资源（如 web-static.archive.org、被墙 CDN）
  out = out.replace(/<img\b([^>]*?)\ssrc=(["'])([^"']*)\2([^>]*)>/gi, (whole, pre: string, quote: string, src: string, post: string) => {
    const abs = absolutize(src)
    if (!abs) return whole
    const proxied = `${selfOrigin}/api/net?action=download&u=${encodeURIComponent(abs)}`
    return `<img${pre} src=${quote}${escapeAttr(proxied)}${quote}${post}>`
  })
  out = out.replace(/\ssrcset=(["'])[^"']*\1/gi, '')
  out = out.replace(/<form\b([^>]*?)\saction=(["'])([^"']*)\2([^>]*)>/gi, (whole, pre: string, quote: string, action: string, post: string) => {
    const abs = absolutize(action)
    if (!abs) return whole
    const hasTarget = /\starget=/i.test(pre + post)
    return `<form${pre} action=${quote}${escapeAttr(abs)}${quote}${post}${hasTarget ? '' : ' target="_blank"'}>`
  })
  return out
}

async function handleReaderGet(request: Request, url: URL): Promise<Response> {
  const access = await requireNetAccess(request)
  if (access instanceof Response) {
    // 顶层导航（新窗口打开）时 401 也要有可读提示
    return new Response('<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;padding:40px">需要管理员登录或有效的分享链接，请核对后重试。</body>', {
      status: 401,
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...PRIVATE_HEADERS },
    })
  }

  const rawTarget = isSafePublicUrl(url.searchParams.get('u') || '')
  if (!rawTarget) return jsonError('仅支持 HTTP(S) 网页 URL。')
  // 自动改写已知被 Worker IP 屏蔽的主机（如 www.csdn.net → blog.csdn.net）
  const target = rewriteBlockedHost(rawTarget)

  let res: Response
  try {
    res = await fetch(target.toString(), {
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000),
      headers: buildBrowserHeaders({ mode: 'navigate', accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }),
    })
  } catch (e) {
    return jsonError(`页面请求失败：${e instanceof Error ? e.message : '网络错误'}`, 502)
  }
  const ct = (res.headers.get('content-type') || '').toLowerCase()
  // 跨账号代理架构下 request.url 的 origin 是 workers.dev（国内不可达），
  // 重写后的递归链接必须指向 PUBLIC_ORIGIN，否则访客点击即超时。
  const selfOrigin = getPublicOrigin(request)

  // 先读 body：拦截响应可能是 JSON（如 B站 412）也可能是 HTML，都需要检测后再决定是否渲染
  const { text } = await readCapped(res, READER_HTML_LIMIT)

  // 检测访问是否被拦截。分级处理：
  // - hard（Cloudflare 5xx，源站网络层不可达）→ 自动走 Wayback 存档回退；
  // - soft（WAF 403/412/429、人机验证页）→ 仅提示 + 手动入口，不自动跳存档，
  //   避免误判时消耗 archive.org 配额、拖垮正常浏览（此前正文含 captcha 等词的
  //   正常页面被误判后立即跳 Wayback，反而被 archive.org 限流拖死）。
  // force=1（错误页「强制显示返回内容」入口）跳过检测，直接渲染原始内容。
  const block = url.searchParams.get('force') === '1' ? null : detectBlock(res.status, text)
  const isWaybackHost = /(^|\.)archive\.org$/i.test(rawTarget.hostname)
  if (block) {
    const rewritten = target.toString() !== rawTarget.toString()
      ? `（已自动尝试别名 ${target.hostname}，仍失败）` : ''
    const msg = `${block.code}：${block.hint}${rewritten}`

    // 目标本身是 Wayback（如存档页被限流 429）时不再回退到 Wayback，避免死循环
    if (isWaybackHost) {
      return new Response(
        `<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;padding:40px;max-width:640px;margin:0 auto;line-height:1.7">` +
        `<h2 style="margin:0 0 8px">网页存档加载失败</h2>` +
        `<p style="color:#57606a">${escapeHtml(msg)}</p>` +
        `<p style="color:#8b949e;font-size:13px">Internet Archive（Wayback Machine）暂时不可用或限流。可稍后重试，或直接在浏览器打开原始页面。</p>` +
        `<p><a href="${escapeAttr(rawTarget.toString())}" style="color:#58a6ff">重试存档页 ↗</a></p>` +
        `</body>`,
        { status: 502, headers: { 'Content-Type': 'text/html; charset=utf-8', ...PRIVATE_HEADERS } },
      )
    }

    if (block.kind === 'hard') {
      // 硬失败：源站网络层明确不可达 → 自动尝试 Wayback Machine 存档
      const wbUrl = await tryWaybackArchive(rawTarget.toString())
      if (wbUrl) {
        const wbReaderUrl = `${selfOrigin}/api/net?action=reader&u=${encodeURIComponent(wbUrl)}`
        return new Response(
          `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="1;url=${escapeAttr(wbReaderUrl)}">` +
          `<body style="font:15px system-ui;padding:40px;max-width:640px;margin:0 auto;line-height:1.7">` +
          `<h2 style="margin:0 0 8px">正在加载网页存档…</h2>` +
          `<p style="color:#57606a">${escapeHtml(msg)}</p>` +
          `<p style="color:#8b949e;font-size:13px">源站不可达，正在从 Internet Archive（Wayback Machine）加载历史存档版本，1 秒后自动跳转。</p>` +
          `<p><a href="${escapeAttr(wbReaderUrl)}" style="color:#58a6ff">立即跳转 ↗</a> &nbsp;|&nbsp; <a href="${escapeAttr(rawTarget.toString())}" style="color:#58a6ff">打开原始页面</a></p>` +
          `</body>`,
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ...PRIVATE_HEADERS } },
        )
      }

      return new Response(
        `<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;padding:40px;max-width:640px;margin:0 auto;line-height:1.7">` +
        `<h2 style="margin:0 0 8px">无法加载该页面</h2>` +
        `<p style="color:#57606a">${escapeHtml(msg)}</p>` +
        `<p style="color:#8b949e;font-size:13px">该站点拦截了服务器请求，且 Wayback Machine 无存档。可尝试：① 直接在浏览器打开原始链接；② 用搜索引擎查看缓存；③ 换用该站点的其他子域或移动端。</p>` +
        `<p>` +
        `<a href="${escapeAttr(rawTarget.toString())}" style="color:#58a6ff">在新标签打开原始页面 ↗</a> &nbsp;|&nbsp; ` +
        `<a href="${escapeAttr(selfOrigin + '/api/net?action=reader&u=' + encodeURIComponent('https://web.archive.org/web/*/' + rawTarget.toString()))}" style="color:#58a6ff">在 Wayback Machine 搜索存档（经代理）</a>` +
        `</p>` +
        `</body>`,
        { status: 502, headers: { 'Content-Type': 'text/html; charset=utf-8', ...PRIVATE_HEADERS } },
      )
    }

    // 软失败：可能只是暂时拦截，不自动跳存档，给出手动入口
    const forceUrl = `${selfOrigin}/api/net?action=reader&force=1&u=${encodeURIComponent(rawTarget.toString())}`
    const wbManualUrl = `${selfOrigin}/api/net?action=reader&u=${encodeURIComponent('https://web.archive.org/web/2024/' + rawTarget.toString())}`
    return new Response(
      `<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;padding:40px;max-width:640px;margin:0 auto;line-height:1.7">` +
      `<h2 style="margin:0 0 8px">页面被站点拦截</h2>` +
      `<p style="color:#57606a">${escapeHtml(msg)}</p>` +
      `<p style="color:#8b949e;font-size:13px">这通常是站点对服务器 IP 的风控，可能只是暂时的。可稍后重试，或：</p>` +
      `<p>` +
      `<a href="${escapeAttr(rawTarget.toString())}" style="color:#58a6ff">在新标签打开原始页面 ↗</a> &nbsp;|&nbsp; ` +
      `<a href="${escapeAttr(wbManualUrl)}" style="color:#58a6ff">尝试加载网页存档</a> &nbsp;|&nbsp; ` +
      `<a href="${escapeAttr(forceUrl)}" style="color:#58a6ff">强制显示返回内容</a>` +
      `</p>` +
      `</body>`,
      { status: 502, headers: { 'Content-Type': 'text/html; charset=utf-8', ...PRIVATE_HEADERS } },
    )
  }

  // 未被拦截但不是 HTML 页面（如纯 JSON/API），提示用「抓取」
  if (!ct.includes('html')) {
    return jsonError('该地址不是 HTML 页面；JSON/文本请使用「抓取」。', 415)
  }

  const finalUrl = res.url || target.toString()
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)
  const title = (titleMatch?.[1] || target.hostname).replace(/\s+/g, ' ').trim().slice(0, 160)
  const body = rewriteForReader(sanitizeForReader(text), finalUrl, selfOrigin)
  const backHref = access.via === 'share' ? '/share' : '/admin/network'
  const bar =
    `<div style="position:sticky;top:0;z-index:9;font:13px/1.6 system-ui,sans-serif;background:#0d1117;color:#c9d1d9;padding:8px 14px;margin:0 0 18px;border-bottom:1px solid #30363d">` +
    `阅读模式 · 经 Syntax Garden 服务器中转 · <a href="${escapeAttr(finalUrl)}" style="color:#58a6ff">${escapeHtml(target.hostname)} ↗ 原始页面</a>` +
    ` &nbsp;|&nbsp; <a href="${backHref}" style="color:#58a6ff">返回网络工具</a></div>`
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)} · 阅读模式</title></head><body>${bar}${body}</body></html>`
  return new Response(page, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      ...PRIVATE_HEADERS,
    },
  })
}

// ────────────────────────────────────────────────────────────
// action=download：通用文件中转下载（电子书/任意文件，流式 pipe，不限域名）
// ────────────────────────────────────────────────────────────

/** 从 Content-Disposition 头解析文件名；兼容 filename= 与 RFC 5987 的 filename*=UTF-8''%E4... */
function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null
  // 优先 RFC 5987: filename*=UTF-8''encoded
  const starRe = /filename\*\s*=\s*([^']+)'[^']*'([^;]+)/i
  const m = starRe.exec(header)
  if (m) {
    try { return decodeURIComponent(m[2]!.trim()) } catch { /* fall through */ }
  }
  // 回退 filename="..." 或 filename=...
  const plainRe = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i
  const m2 = plainRe.exec(header)
  if (m2) return (m2[1] || m2[2] || '').trim() || null
  return null
}

const DOWNLOAD_PASSTHROUGH_HEADERS = [
  'content-type', 'content-length', 'content-disposition', 'content-range',
  'accept-ranges', 'etag', 'last-modified',
] as const

async function handleDownloadGet(request: Request, url: URL): Promise<Response> {
  const access = await requireNetAccess(request)
  if (access instanceof Response) return access

  const rawTarget = isSafePublicUrl(url.searchParams.get('u') || '')
  if (!rawTarget) return jsonError('仅支持 HTTP(S) 且非公网内网地址的文件 URL。')
  const target = rewriteBlockedHost(rawTarget)

  const range = request.headers.get('range')
  const init: RequestInit = {
    method: 'GET',
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000), // 下载给更长超时
    headers: buildBrowserHeaders({ mode: 'navigate', accept: '*/*' }),
  }
  if (range) init.headers = { ...init.headers, Range: range }

  let res: Response
  try {
    res = await fetch(target.toString(), init)
  } catch (e) {
    return jsonError(`下载请求失败：${e instanceof Error ? e.message : '网络错误'}`, 502)
  }

  // 大小限制：已知 Content-Length 超过上限直接拒绝（避免刷大文件浪费 Worker 带宽）
  const clHeader = res.headers.get('content-length')
  const contentLength = clHeader ? parseInt(clHeader, 10) : NaN
  if (!Number.isNaN(contentLength) && contentLength > DOWNLOAD_MAX_BYTES) {
    try { res.body?.cancel() } catch { /* ignore */ }
    return jsonError(`文件过大（${(contentLength / 1024 / 1024).toFixed(1)} MiB），单文件中转上限 ${DOWNLOAD_MAX_BYTES / 1024 / 1024} MiB。`, 413)
  }

  // 构造响应头
  const outHeaders = new Headers(PRIVATE_HEADERS)
  for (const name of DOWNLOAD_PASSTHROUGH_HEADERS) {
    const v = res.headers.get(name)
    if (v != null) outHeaders.set(name, v)
  }
  // 强制浏览器下载而非预览（即使上游 Content-Type 是 text/html 也按下载处理）
  const origDisp = res.headers.get('content-disposition')
  if (!origDisp || !/attachment/i.test(origDisp)) {
    const filename = parseContentDispositionFilename(origDisp) || target.pathname.split('/').pop() || 'download'
    // 同时给 ASCII 名（filename=）和 UTF-8 名（filename*=），兼容所有浏览器
    const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')
    const utf8 = encodeURIComponent(filename)
    outHeaders.set('content-disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`)
  }
  outHeaders.set('Cache-Control', 'private, max-age=3600')

  // 流式 pipe：上游 body 直接作为响应体，字节不经过 Worker 内存缓冲
  // worker.ts 会删除 Content-Length 以允许 chunked 传输（未知长度的 chunked 上游也支持）
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: outHeaders,
  })
}

// ────────────────────────────────────────────────────────────
// action=search：代理搜索（Brave API 优先，无密钥回退 DuckDuckGo）
// ────────────────────────────────────────────────────────────

interface SearchResult { title: string; url: string; snippet: string }

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'")
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
}

/** 解析 DuckDuckGo html/lite 两种标记；链接均为 /l/?uddg=<编码后的真实地址>。
 *  注意：lite 端点历史标记使用单引号属性，必须同时兼容单/双引号，否则解析恒为空。 */
function parseDdg(html: string): SearchResult[] {
  const results: SearchResult[] = []
  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = anchorRe.exec(html))) {
    const href = decodeEntities(m[1]!)
    const title = stripTags(m[2]!)
    if (!href.includes('uddg=') || !title) continue
    let real = href
    try {
      real = new URL(href.startsWith('//') ? `https:${href}` : href, 'https://duckduckgo.com').searchParams.get('uddg') || ''
    } catch { /* ignore */ }
    if (!real || !/^https?:/.test(real)) continue
    results.push({ title, url: real, snippet: '' })
  }
  // 摘要：result__snippet（html 端点）/ result-snippet（lite 端点），按出现顺序与结果配对
  const snippets: string[] = []
  const snipRe = /class=["'][^"']*(?:result__snippet|result-snippet)[^"']*["'][^>]*>([\s\S]*?)<\/a|class=["'][^"']*(?:result__snippet|result-snippet)[^"']*["'][^>]*>([\s\S]*?)<\/td>/gi
  while ((m = snipRe.exec(html))) snippets.push(stripTags(m[1] || m[2] || ''))
  const dedup = new Set<string>()
  return results
    .filter((r) => (dedup.has(r.url) ? false : (dedup.add(r.url), true)))
    .slice(0, 20)
    .map((r, i) => ({ ...r, snippet: snippets[i] || '' }))
}

async function ddgSearch(q: string): Promise<SearchResult[]> {
  const endpoints = [
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
    `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
  ]
  const fails: string[] = []
  for (const ep of endpoints) {
    const tag = new URL(ep).host
    try {
      const res = await fetch(ep, {
        signal: AbortSignal.timeout(15_000),
        headers: buildBrowserHeaders({ mode: 'navigate', accept: 'text/html,application/xhtml+xml' }),
      })
      if (!res.ok) { fails.push(`${tag}=${res.status}`); continue }
      const { text } = await readCapped(res, READER_HTML_LIMIT)
      // DDG 对数据中心 IP 常返回验证码页而非结果页
      if (/anomaly-modal|challenge-form|Unfortunately, bots use DuckDuckGo too/i.test(text)) {
        fails.push(`${tag}=captcha`)
        continue
      }
      const parsed = parseDdg(text)
      if (parsed.length) return parsed
      fails.push(`${tag}=empty`)
    } catch (e) {
      fails.push(`${tag}=${e instanceof Error ? e.message : 'neterr'}`)
    }
  }
  throw new Error(`DDG[${fails.join(', ')}]`)
}

/** DuckDuckGo 官方 Instant Answer JSON API（对机器人友好；只有即时答案而非完整网页结果） */
async function ddgInstantAnswer(q: string): Promise<SearchResult[]> {
  const res = await fetch(
    `https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=${encodeURIComponent(q)}`,
    { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': BROWSER_UA } },
  )
  if (!res.ok) throw new Error(`IA=${res.status}`)
  const data = (await res.json()) as {
    Heading?: string; AbstractText?: string; AbstractURL?: string
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>
  }
  const out: SearchResult[] = []
  if (data.AbstractURL && data.AbstractText) {
    out.push({ title: data.Heading || data.AbstractURL, url: data.AbstractURL, snippet: data.AbstractText })
  }
  for (const t of data.RelatedTopics ?? []) {
    const items = t.Topics?.length ? t.Topics : [t]
    for (const it of items) {
      if (it.FirstURL && it.Text && out.length < 12) {
        const cut = it.Text.indexOf(' - ')
        out.push({
          title: (cut > 0 ? it.Text.slice(0, cut) : it.Text).slice(0, 120),
          url: it.FirstURL,
          snippet: cut > 0 ? it.Text.slice(cut + 3) : '',
        })
      }
    }
  }
  return out
}

/** Crossref 学术搜索：免费无需密钥的稳定 JSON API（DOI 元数据，覆盖期刊论文场景） */
async function crossrefSearch(q: string): Promise<SearchResult[]> {
  const res = await fetch(
    `https://api.crossref.org/works?rows=8&select=DOI,title,abstract,published,container-title&query=${encodeURIComponent(q)}`,
    { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': BROWSER_UA } },
  )
  if (!res.ok) throw new Error(`Crossref=${res.status}`)
  const data = (await res.json()) as {
    message?: { items?: Array<{ DOI?: string; title?: string[]; abstract?: string; published?: { 'date-parts'?: number[][] }; 'container-title'?: string[] }> }
  }
  const out: SearchResult[] = []
  for (const w of data.message?.items ?? []) {
    if (!w.DOI || !w.title?.[0]) continue
    const year = w.published?.['date-parts']?.[0]?.[0]
    const venue = w['container-title']?.[0]
    const abs = w.abstract ? stripTags(w.abstract) : ''
    const meta = [year, venue].filter(Boolean).join(' · ')
    out.push({
      title: w.title[0],
      url: `https://doi.org/${w.DOI}`,
      snippet: [meta, abs ? `${abs.slice(0, 280)}${abs.length > 280 ? '…' : ''}` : ''].filter(Boolean).join(' — '),
    })
  }
  return out
}

/** arXiv 预印本搜索：Atom XML，免费无需密钥 */
async function arxivSearch(q: string): Promise<SearchResult[]> {
  const res = await fetch(
    `https://export.arxiv.org/api/query?max_results=6&search_query=all:${encodeURIComponent(q)}`,
    { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': BROWSER_UA } },
  )
  if (!res.ok) throw new Error(`arXiv=${res.status}`)
  const xml = await res.text()
  const out: SearchResult[] = []
  const entryRe = /<entry>([\s\S]*?)<\/entry>/gi
  let m: RegExpExecArray | null
  while ((m = entryRe.exec(xml))) {
    const body = m[1]!
    const id = /<id>([^<]+)<\/id>/.exec(body)?.[1]?.trim()
    const title = /<title>([\s\S]*?)<\/title>/.exec(body)?.[1]
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(body)?.[1]
    if (!id || !title) continue
    const abs = decodeEntities((summary || '').replace(/\s+/g, ' ').trim())
    out.push({
      title: decodeEntities(title.replace(/\s+/g, ' ').trim()),
      url: id,
      snippet: `arXiv — ${abs.slice(0, 280)}${abs.length > 280 ? '…' : ''}`,
    })
  }
  return out
}

// ────────────────────────────────────────────────────────────
// 回国线路：中国搜索引擎（Bing 中国 + 百度，HTML 抓取解析）
// ────────────────────────────────────────────────────────────

/** 解析 Bing 中国搜索结果（cn.bing.com）——直接从 <h2> 提取外部链接，更鲁棒 */
function parseBingCN(html: string): SearchResult[] {
  const results: SearchResult[] = []
  // Bing 结果标题在 <h2><a href="外部URL">，跳过 bing.com 内部链接
  const re = /<h2\b[^>]*>[\s\S]*?<a\b[^>]*href=["'](https?:\/\/(?![^/]*\bbing\.com)[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const u = decodeEntities(m[1]!)
    const title = stripTags(m[2]!)
    if (!title) continue
    results.push({ title, url: u, snippet: '' })
  }
  // 摘要从 b_lineclamp/b_caption 段落提取
  const snipRe = /<p\b[^>]*class="[^"]*(?:b_lineclamp|b_caption|b_paractl)[^"]*"[^>]*>([\s\S]*?)<\/p>/gi
  const snippets: string[] = []
  while ((m = snipRe.exec(html))) snippets.push(stripTags(m[1]!))
  return results.slice(0, 20).map((r, i) => ({ ...r, snippet: snippets[i] || '' }))
}

/** 解析百度搜索结果——仅提取 <h3> 内的 baidu.com/link 跳转链接（真实结果标题在 h3 中，
 *  避开百度百科内部导航 tab 等噪音） */
function parseBaidu(html: string): SearchResult[] {
  const results: SearchResult[] = []
  const seen = new Set<string>()
  // 百度真实结果标题在 <h3><a href="...baidu.com/link?url=...">标题</a></h3>
  const re = /<h3\b[^>]*>[\s\S]*?<a\b[^>]*href=["'](https?:\/\/[^"']*baidu\.com\/link\?url=[^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const u = decodeEntities(m[1]!)
    if (seen.has(u)) continue
    const title = stripTags(m[2]!)
    if (!title) continue
    seen.add(u)
    results.push({ title, url: u, snippet: '' })
  }
  return results.slice(0, 20)
}

async function bingCnSearch(q: string): Promise<SearchResult[]> {
  // 用国际 Bing + 中文市场参数（cn.bing.com 对 Worker IP 反爬严重，恒返回首页壳）
  const res = await fetch(
    `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=20&setlang=zh-cn&mkt=zh-CN&cc=CN`,
    {
      signal: AbortSignal.timeout(15_000),
      headers: buildBrowserHeaders({ mode: 'navigate', accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', referer: 'https://www.bing.com/' }),
    },
  )
  if (!res.ok) throw new Error(`BingCN=${res.status}`)
  const { text } = await readCapped(res, READER_HTML_LIMIT)
  const parsed = parseBingCN(text)
  if (!parsed.length) throw new Error('BingCN=empty')
  return parsed
}

async function baiduSearch(q: string): Promise<SearchResult[]> {
  const res = await fetch(
    `https://www.baidu.com/s?wd=${encodeURIComponent(q)}&rn=20&ie=utf-8`,
    {
      signal: AbortSignal.timeout(15_000),
      headers: buildBrowserHeaders({ mode: 'navigate', accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', referer: 'https://www.baidu.com/' }),
    },
  )
  if (!res.ok) throw new Error(`Baidu=${res.status}`)
  const { text } = await readCapped(res, READER_HTML_LIMIT)
  const parsed = parseBaidu(text)
  if (!parsed.length) throw new Error('Baidu=empty')
  return parsed
}

async function handleSearchGet(request: Request, url: URL): Promise<Response> {
  const access = await requireNetAccess(request)
  if (access instanceof Response) return access

  const q = (url.searchParams.get('q') || '').trim().slice(0, 200)
  if (!q) return jsonError('缺少搜索关键词。')
  const region = url.searchParams.get('region') === 'cn' ? 'cn' : 'global'

  // 回国线路：优先中国搜索引擎（Bing 中国 → 百度），全挂则落到国际链路
  let cnErrors = ''
  if (region === 'cn') {
    try {
      const results = await bingCnSearch(q)
      return Response.json({ ok: true, engine: 'bing-cn', query: q, results }, { headers: PRIVATE_HEADERS })
    } catch (e) {
      cnErrors += `bing-cn:${e instanceof Error ? e.message : '?'};`
    }
    try {
      const results = await baiduSearch(q)
      return Response.json({ ok: true, engine: 'baidu', query: q, results }, { headers: PRIVATE_HEADERS })
    } catch (e) {
      cnErrors += `baidu:${e instanceof Error ? e.message : '?'};`
    }
    // 两端均失败 → 落到国际链路
  }

  const braveKey = (getEnv().BRAVE_API_KEY || '').trim()

  if (braveKey) {
    try {
      const res = await fetch(
        `https://api.search.brave.com/res/v1/web/search?count=20&q=${encodeURIComponent(q)}`,
        { signal: AbortSignal.timeout(20_000), headers: { Accept: 'application/json', 'X-Subscription-Token': braveKey } },
      )
      if (res.ok) {
        const data = (await res.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } }
        const results = (data.web?.results ?? [])
          .filter((r) => r.url && r.title)
          .map((r) => ({ title: r.title!, url: r.url!, snippet: r.description || '' }))
        return Response.json({ ok: true, engine: 'brave', query: q, results, ...(cnErrors ? { cnErrors } : {}) }, { headers: PRIVATE_HEADERS })
      }
    } catch {
      // 密钥失效/网络异常时落到 DDG
    }
  }

  try {
    const results = await ddgSearch(q)
    return Response.json({ ok: true, engine: 'duckduckgo', query: q, results, ...(cnErrors ? { cnErrors } : {}) }, { headers: PRIVATE_HEADERS })
  } catch (ddgErr) {
    // DDG 全挂（常见于数据中心 IP 被验证码拦截）→ 兜底：官方 Instant Answer + Crossref + arXiv
    const [ia, cr, ax] = await Promise.allSettled([ddgInstantAnswer(q), crossrefSearch(q), arxivSearch(q)])
    const results: SearchResult[] = []
    const seen = new Set<string>()
    for (const r of [ia, cr, ax]) {
      if (r.status !== 'fulfilled') continue
      for (const it of r.value) {
        if (seen.has(it.url)) continue
        seen.add(it.url)
        results.push(it)
      }
    }
    if (results.length) {
      return Response.json({ ok: true, engine: 'fallback', query: q, results, ...(cnErrors ? { cnErrors } : {}) }, { headers: PRIVATE_HEADERS })
    }
    const d = ddgErr instanceof Error ? ddgErr.message : 'DDG?'
    const i = ia.status === 'rejected' ? (ia.reason as Error)?.message : 'IA=empty'
    const c = cr.status === 'rejected' ? (cr.reason as Error)?.message : 'Crossref=empty'
    const a = ax.status === 'rejected' ? (ax.reason as Error)?.message : 'arXiv=empty'
    return jsonError(`搜索暂不可用（${d}; ${i}; ${c}; ${a}）。可配置 BRAVE_API_KEY 获得稳定网页搜索。`, 502)
  }
}

// ────────────────────────────────────────────────────────────
// action=yt_search：YouTube 站内搜索（YouTube Data API v3）
// 需要 Worker secret YT_API_KEY。免费配额 10000 单位/天，search 每次 100 单位
// （约 100 次/天）；搜索只拿元数据，视频流不经过本站服务器（前端嵌官方播放器）。
// ────────────────────────────────────────────────────────────

async function handleYtSearchGet(request: Request, url: URL): Promise<Response> {
  const access = await requireNetAccess(request)
  if (access instanceof Response) return access
  const q = (url.searchParams.get('q') || '').trim()
  if (!q) return jsonError('缺少搜索词。')
  const apiKey = (getEnv().YT_API_KEY || '').trim()
  if (!apiKey) return jsonError('未配置 YT_API_KEY（Worker secret），无法搜索 YouTube。', 503)

  const api =
    `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=12` +
    `&q=${encodeURIComponent(q)}&key=${encodeURIComponent(apiKey)}`
  let res: Response
  try {
    res = await fetch(api, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) })
  } catch {
    return jsonError('YouTube API 请求失败（网络超时）。', 502)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    if (res.status === 403 && /quotaExceeded/i.test(body)) {
      return jsonError('YouTube 搜索配额已用尽（每日约 100 次），请明天再试。', 429)
    }
    if (res.status === 400 || res.status === 403) {
      return jsonError('YT_API_KEY 无效或未启用 YouTube Data API v3。', 502)
    }
    return jsonError(`YouTube 搜索失败（HTTP ${res.status}）。`, 502)
  }
  const data = (await res.json().catch(() => ({}))) as {
    items?: Array<{
      id?: { videoId?: string }
      snippet?: { title?: string; channelTitle?: string; publishedAt?: string; thumbnails?: { medium?: { url?: string } } }
    }>
  }
  const items = (data.items || [])
    .filter((i) => i.id?.videoId)
    .map((i) => ({
      id: i.id!.videoId!,
      title: i.snippet?.title || '',
      channel: i.snippet?.channelTitle || '',
      date: (i.snippet?.publishedAt || '').slice(0, 10),
      thumb: i.snippet?.thumbnails?.medium?.url || '',
    }))
  return Response.json({ ok: true, items }, { headers: PRIVATE_HEADERS })
}

// ────────────────────────────────────────────────────────────
// action=bili_playurl：代理 B站 playurl（platform=html5 免登录 MP4）。
// 必要性：playurl 严格校验 Referer（仅接受 *.bilibili.com，第三方/空 Referer
// 返回 403），第三方页面里的浏览器请求无法伪造 Referer，JSONP 还会被 Chrome
// ORB 拦截；故由 Worker 转发并带上 bilibili Referer。仅返回小 JSON（视频流
// 本身不经 Worker：直链 platform=html5 无 Referer 鉴权，浏览器 <video> 直连 CDN）。
// ────────────────────────────────────────────────────────────

/** 与 deploy/botapi-gateway 的 verifyToken 同算法：<exp>.<payloadB64url>.<sigB64url> */
async function signBiliGwToken(secret: string, payload: string, ttlMs: number): Promise<string> {
  const exp = Date.now() + ttlMs
  const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`bili.${exp}.${payload}`))
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${exp}.${b64(payload)}.${sigB64}`
}

async function handleBiliPlayUrlGet(request: Request, url: URL): Promise<Response> {
  const access = await requireNetAccess(request)
  if (access instanceof Response) return access
  const bvid = (url.searchParams.get('bvid') || '').trim()
  const aid = (url.searchParams.get('aid') || '').trim()
  const cid = Number(url.searchParams.get('cid') || '')
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid) && !/^\d{6,}$/.test(aid)) {
    return jsonError('参数 bvid/aid 非法。')
  }
  if (!Number.isInteger(cid) || cid <= 0) return jsonError('参数 cid 非法。')
  const idParam = bvid ? `bvid=${encodeURIComponent(bvid)}` : `aid=${encodeURIComponent(aid)}`
  const payload = `${bvid ? 'bvid' : 'aid'}.${bvid || aid}.${cid}`

  // 首选自建网关出口（港/日容器 IP，通常不在 B站 WAF 封锁段）；
  // Cloudflare 数据中心出口直连 api.bilibili.com 稳定 412，仅作兜底。
  const env = getEnv()
  const gw = (env.TG_GATEWAY_URL || '').trim().replace(/\/+$/, '')
  if (gw && env.TG_GATEWAY_SECRET) {
    try {
      const token = await signBiliGwToken(env.TG_GATEWAY_SECRET, payload, 5 * 60 * 1000)
      const gwRes = await fetch(`${gw}/bili-playurl?${idParam}&cid=${cid}`, {
        headers: { 'x-sg-bili': token },
        signal: AbortSignal.timeout(12000),
      })
      const gwBody = (await gwRes.json().catch(() => ({}))) as {
        ok?: boolean
        streams?: string[]
        quality?: number | null
        error?: string
      }
      if (gwRes.ok && gwBody.ok && gwBody.streams?.length) {
        return Response.json(
          { ok: true, quality: gwBody.quality ?? null, streams: gwBody.streams },
          { headers: PRIVATE_HEADERS },
        )
      }
      // 网关失败（风控/超时）继续走直连兜底
      console.warn('[bili_playurl] gateway failed:', gwRes.status, gwBody.error || '')
    } catch (e) {
      console.warn('[bili_playurl] gateway error:', e instanceof Error ? e.message : e)
    }
  }

  const api =
    `https://api.bilibili.com/x/player/playurl?${idParam}&cid=${cid}` +
    `&platform=html5&high_quality=1&qn=64&fnval=1`
  let res: Response
  try {
    res = await fetch(api, {
      headers: buildBrowserHeaders({
        mode: 'cors',
        accept: 'application/json, text/plain, */*',
        referer: 'https://www.bilibili.com/',
      }),
      signal: AbortSignal.timeout(10000),
    })
  } catch {
    return jsonError('B站 playurl 请求失败（网络超时）。', 502)
  }
  const body = await res.text().catch(() => '')
  if (!res.ok) {
    // 数据中心 IP 风控（403/412 HTML 拦截页）
    return jsonError(`B站拒绝了服务器请求（HTTP ${res.status}，可能是出口 IP 风控）。`, 502)
  }
  let data: { code?: number; message?: string; data?: { durl?: Array<{ url?: string; backup_url?: string[] }>; quality?: number } }
  try {
    data = JSON.parse(body)
  } catch {
    return jsonError('B站 playurl 返回了非 JSON 响应。', 502)
  }
  if (data.code !== 0 || !data.data?.durl?.[0]?.url) {
    return jsonError(`B站 playurl 错误：${data.message || data.code || '未知'}。`, 502)
  }
  const d = data.data.durl[0]
  return Response.json(
    {
      ok: true,
      quality: data.data.quality ?? null,
      streams: [d.url, ...(d.backup_url ?? [])].filter(Boolean),
    },
    { headers: PRIVATE_HEADERS },
  )
}

export const Route = createFileRoute('/api/net')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const action = url.searchParams.get('action')
        try {
          if (action === 'claim') return await handleClaimGet(request, url)
          if (action === 'share_info') return await handleShareInfoGet(request)
          if (action === 'gh') return await handleGithubGet(request, url)
          if (action === 'fetch') return await handleFetchGet(request, url)
          if (action === 'reader') return await handleReaderGet(request, url)
          if (action === 'download') return await handleDownloadGet(request, url)
          if (action === 'search') return await handleSearchGet(request, url)
          if (action === 'yt_search') return await handleYtSearchGet(request, url)
          if (action === 'bili_playurl') return await handleBiliPlayUrlGet(request, url)
          return jsonError('未知的网络工具动作。', 404)
        } catch (e) {
          return jsonError(e instanceof Error ? e.message : '网络工具内部错误。', 500)
        }
      },
      POST: async ({ request }) => {
        try {
          return await handleSharePost(request)
        } catch (e) {
          return jsonError(e instanceof Error ? e.message : '网络工具内部错误。', 500)
        }
      },
    },
  },
})
