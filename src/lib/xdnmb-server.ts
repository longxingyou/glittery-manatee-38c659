/**
 * X 岛匿名版（nmbxd / api.nmb.best）服务端客户端 + HTML 安全净化。
 *
 * 设计要点：
 * - 纯 fetcher 在 xdnmb-api.ts（主站 + 爬虫 Worker 共用），本文件仅做
 *   主站专用包装：注入 gatewayConfig()、HTML 净化、内存缓存、发帖/图片代理；
 * - 串内容是服务端给的 HTML 片段，Workers 运行时没有 DOMParser，
 *   用白名单扫描器净化：只保留排版/链接/图片标签，重写站内链接为 xdnmb: 内部协议，
 *   图片重写为同源 /api/xdnmb 代理（防盗链 + 弱网友好）；
 * - 错误响应可能是裸字符串（"该串不存在"）或 { success:false, error }，统一抛错。
 */
import { TtlCache } from './cache.js'
import { gatewayConfig, signGwToken } from './attachment-store.js'
import {
  X_API,
  X_IMG,
  X_WEB,
  xFetchRaw as xFetchRawGw,
  xFetch as xFetchGw,
  getForums as getForumsRaw,
  getTimelineList as getTimelineListRaw,
  showForum as showForumRaw,
  showTimeline as showTimelineRaw,
  getThread as getThreadRaw,
  getRef as getRefRaw,
} from './xdnmb-api.js'
import type { XForumGroup, XPost, XTimeline } from './xdnmb-types.js'

export type { XForumGroup, XPost, XTimeline } from './xdnmb-types.js'
export { X_API, X_IMG, X_WEB }

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 主站本地包装：注入 gatewayConfig()，供 getFeeds/addFeed/delFeed 等主站专用函数使用 */
async function xFetchRaw(path: string, userhash: string): Promise<Response> {
  return xFetchRawGw(path, userhash, gatewayConfig())
}

async function xFetch<T>(path: string, userhash: string): Promise<T> {
  return xFetchGw<T>(path, userhash, gatewayConfig())
}

/** 版面分组列表（isolate 内存缓存 30 分钟，结构几乎不变；受限版面依赖饼干故按饼干分桶） */
const forumsCache = new TtlCache<XForumGroup[]>(30)
export async function getForums(userhash: string): Promise<XForumGroup[]> {
  const key = userhash ? 'auth' : 'anon'
  const cached = forumsCache.get(key)
  if (cached) return cached
  const groups = await getForumsRaw(userhash, gatewayConfig())
  forumsCache.set(key, groups, 30 * 60 * 1000)
  return groups
}

/** 时间线分区列表（与版面列表独立；结构几乎不变，内存缓存 30 分钟） */
const timelinesCache = new TtlCache<XTimeline[]>(30)
export async function getTimelineList(): Promise<XTimeline[]> {
  const cached = timelinesCache.get('all')
  if (cached) return cached
  const arr = await getTimelineListRaw(gatewayConfig())
  timelinesCache.set('all', arr, 30 * 60 * 1000)
  return arr
}

/** 版面串列表（含最近回复预览；HTML 净化） */
export async function showForum(fid: string, page: number, userhash: string): Promise<XPost[]> {
  const list = await showForumRaw(fid, page, userhash, gatewayConfig())
  return list.map((p) => ({ ...p, content: purifyXHtml(p.content, 'thumb') }))
}

/** 时间线串列表（HTML 净化） */
export async function showTimeline(tid: string, page: number, userhash: string): Promise<XPost[]> {
  const list = await showTimelineRaw(tid, page, userhash, gatewayConfig())
  return list.map((p) => ({ ...p, content: purifyXHtml(p.content, 'thumb') }))
}

/** 串详情（主楼 + 当页回复；HTML 净化） */
export async function getThread(id: string, page: number, userhash: string): Promise<XPost> {
  const t = await getThreadRaw(id, page, userhash, gatewayConfig())
  return {
    ...t,
    content: purifyXHtml(t.content, 'image'),
    Replies: (t.Replies || []).map((r) => ({ ...r, content: purifyXHtml(r.content, 'image') })),
  }
}

/** 单楼查询（>>No.xxx 引用预览；ref 只返回该楼本身，无 Replies；HTML 净化） */
export async function getRef(id: string, userhash: string): Promise<XPost> {
  const r = await getRefRaw(id, userhash, gatewayConfig())
  return { ...r, content: purifyXHtml(r.content, 'thumb') }
}

// ───────────────────────── 官方订阅（feed，uuid 与饼干独立） ─────────────────────────
//
// X 岛的"订阅 ID"是一串与饼干完全无关的 uuid：浏览器首次访问时随机下发，也可自定义。
// Api/feed/addFeed/delFeed 只认 uuid，因此同一订阅 ID 可在网页与各客户端之间同步。
// 参考：黎明岛 NMBService（getNMBFeeds/addNMBFeed/delNMBFeed）。

/** 查看订阅串列表（每页 10 条，形态同版面列表） */
export async function getFeeds(feedUuid: string, page: number): Promise<XPost[]> {
  if (!feedUuid) throw new Error('尚未设置订阅 ID。')
  const list = await xFetch<XPost[]>(
    `feed?uuid=${encodeURIComponent(feedUuid)}&page=${Math.max(1, page | 0 || 1)}`,
    '',
  )
  return (Array.isArray(list) ? list : []).map((p) => ({ ...p, content: purifyXHtml(p.content, 'thumb') }))
}

/**
 * 写操作专用：X 岛 addFeed/delFeed 成功时返回的是纯文本提示
 * （如「订阅大成功→_→」「取消订阅成功!」），HTTP 200 非 JSON 即视为成功；
 * 只有 HTTP 失败或 {success:false} JSON 才算错误。
 */
async function xFetchOk(path: string): Promise<void> {
  const res = await xFetchRaw(path, '')
  const text = (await res.text()).trim()
  if (!res.ok) throw new Error(text.slice(0, 120) || `X 岛请求失败（HTTP ${res.status}）`)
  if (!text) return
  try {
    const data = JSON.parse(text)
    if (data && typeof data === 'object' && (data as { success?: boolean }).success === false) {
      throw new Error((data as { error?: string }).error || 'X 岛返回错误。')
    }
  } catch (e) {
    // 非 JSON 纯文本 = 成功提示；其他解析异常才继续抛
    if (!(e instanceof SyntaxError)) throw e
  }
}

/** 订阅串（X 岛写操作也是 GET） */
export async function addFeed(feedUuid: string, tid: string): Promise<void> {
  if (!feedUuid) throw new Error('尚未设置订阅 ID。')
  await xFetchOk(`addFeed?uuid=${encodeURIComponent(feedUuid)}&tid=${encodeURIComponent(tid)}`)
}

/** 退订串 */
export async function delFeed(feedUuid: string, tid: string): Promise<void> {
  if (!feedUuid) throw new Error('尚未设置订阅 ID。')
  await xFetchOk(`delFeed?uuid=${encodeURIComponent(feedUuid)}&tid=${encodeURIComponent(tid)}`)
}

// ───────────────────────── 发言（网页版端点，无 JSON API） ─────────────────────────
//
// X 岛的发串/回复没有 JSON API，只能走主站网页端点（参考 xdcmd 整理的 API 文档）：
// POST https://www.nmbxd1.com/home/forum/doReplyThread.html | doPostThread.html
// multipart 表单：resto/fid、content、name、title、image、water；
// 注意：email/SAGE 是管理员锁定帖子的管理操作，普通用户无此字段。
// 鉴权 Cookie: userhash=<饼干>；返回 HTML 跳转提示页。
// 注意必须直连 nmbxd1.com：旧域 nmbxd.com 对 POST 回 307 跨主机跳转，
// fetch 跟随跨源 307 会丢弃 Cookie（容器探针实证），真饼干会被判为“未应用饼干”。
// 发送后不可修改/删除，仅能向委员会申诉——不做任何重试，失败原样抛给前端。

export interface XSubmitInput {
  /** 正文（与图片至少有一个非空，上限 10000 字由调用方校验） */
  content: string
  /** 回复目标串 ID（回复时必填） */
  resto?: string
  /** 版面 ID（发串时必填） */
  fid?: string
  title?: string
  /** 自定义名称，留空即“无名氏”（社区惯例：填名称等于自爆身份） */
  name?: string
  /** 图片加水印（无图片时无效） */
  water?: boolean
  /** 附加图片（原图直传，调用方负责格式校验） */
  image?: { blob: Blob; filename: string } | null
}

/** 从网页版"跳转提示"HTML 中提取 success/error 文案（Worker 无 DOMParser，用正则） */
function parsePostResult(html: string): { ok: boolean; message: string } {
  const m = /<p class="(success|error)">([\s\S]*?)<\/p>/i.exec(html)
  if (!m) {
    const plain = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
    return { ok: false, message: plain || 'X 岛返回了无法识别的响应。' }
  }
  return {
    ok: m[1].toLowerCase() === 'success',
    message: m[2].replace(/<[^>]+>/g, '').trim() || (m[1] === 'success' ? '成功' : '失败'),
  }
}

/** 按官网表单字段组 multipart（xdcmd 实证：无需 __hash__ 令牌） */
function buildPostForm(input: XSubmitInput): FormData {
  const fd = new FormData()
  if (input.name) fd.set('name', input.name.slice(0, 100))
  if (input.title) fd.set('title', input.title.slice(0, 100))
  if (input.content) fd.set('content', input.content)
  if (input.fid) fd.set('fid', String(input.fid))
  if (input.resto) fd.set('resto', String(input.resto))
  if (input.image) {
    fd.set('image', input.image.blob, input.image.filename)
    if (input.water) fd.set('water', 'true')
  }
  return fd
}

/** 发串/回复统一入口（不做重试，防重复发言）；成功返回官网成功文案 */
export async function xSubmitPost(userhash: string, input: XSubmitInput): Promise<string> {
  if (!userhash) throw new Error('尚未绑定饼干：请先在设置中添加并选用一个饼干。')
  const pp = input.fid
    ? 'home/forum/doPostThread.html'
    : 'home/forum/doReplyThread.html'
  const fd = buildPostForm(input)
  const hasImage = !!input.image
  const gw = gatewayConfig()
  if (gw) {
    try {
      // 与读接口同构：载荷绑定 kind/path/userhash，multipart 经网关出口 Blob 透传
      const token = await signGwToken('bili', `xdnmb.post.${pp}.${userhash}`, 5 * 60 * 1000)
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), hasImage ? 50000 : 20000)
      try {
        const r = await fetch(
          `${gw.url}/xdnmb?k=post&p=${encodeURIComponent(pp)}&uh=${encodeURIComponent(userhash)}`,
          {
            method: 'POST',
            signal: ctrl.signal,
            headers: { 'x-sg-bili': token },
            body: fd,
          },
        )
        const text = await r.text()
        if (!r.ok) {
          // 透传网关的错误详情（如 xdnmb post failed: ...），便于定位转发故障
          console.log(`[xdnmb] gw post ${r.status}: ${text.slice(0, 400)}`)
          let detail = ''
          try {
            detail = String((JSON.parse(text) as { error?: unknown }).error || '')
          } catch { /* 非 JSON 错误体则忽略 */ }
          throw new Error(`网关转发失败（HTTP ${r.status}）${detail ? `：${detail}` : ''}`)
        }
        const parsed = parsePostResult(text)
        if (!parsed.ok) throw new Error(parsed.message)
        return parsed.message
      } finally {
        clearTimeout(timer)
      }
    } catch (e) {
      // 网关不可达才回退直连；业务错误（如"未应用饼干"/发太快）原样抛出
      if (!(e instanceof TypeError)) throw e
    }
  }
  // 直连兜底（Worker 出口通常被 403，仅在未配置网关时走到）
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), hasImage ? 50000 : 20000)
  try {
    const r = await fetch(`https://www.nmbxd1.com/${pp}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        ...(userhash ? { Cookie: `userhash=${userhash}` } : {}),
      },
      body: fd,
    })
    const parsed = parsePostResult(await r.text())
    if (!parsed.ok) throw new Error(parsed.message)
    return parsed.message
  } finally {
    clearTimeout(timer)
  }
}

// ───────────────────────── HTML 白名单净化 ─────────────────────────

const TAG_ALLOW = new Set([
  'a', 'b', 'i', 's', 'u', 'strong', 'em', 'br', 'p', 'span', 'font',
  'img', 'blockquote', 'h1', 'h2', 'h3', 'small', 'sub', 'sup', 'ul', 'ol', 'li',
])
// 这些标签连同内容整体丢弃
const TAG_STRIP_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta'])

/** 图片代理 URL：thumb=列表缩略图，image=原图 */
export function xImgUrl(img: string, ext: string, kind: 'thumb' | 'image'): string {
  if (!img || !ext) return ''
  return `/api/xdnmb?action=img&kind=${kind}&p=${encodeURIComponent(`${img}${ext}`)}`
}

/** 本站图片 CDN 绝对地址（代理 fetch 上游用） */
export function xImgAbs(kind: 'thumb' | 'image', p: string): string {
  return `${X_IMG}/${kind}/${p.replace(/^\/+/, '')}`
}

/**
 * 拉取 X 岛图片（网关优先，同样绕过 Worker 出口 403；失败直连兜底）。
 * 返回状态码 / content-type / 流，由路由透传给浏览器。
 */
export async function xImgUpstream(
  kind: 'thumb' | 'image',
  p: string,
): Promise<{ status: number; contentType: string; body: ReadableStream<Uint8Array> }> {
  const gw = gatewayConfig()
  if (gw) {
    try {
      const k = kind === 'thumb' ? 'imgt' : 'imgi'
      // 图片不需要饼干，载荷尾部 uh 留空（网关侧以同样形式校验）
      const token = await signGwToken('bili', `xdnmb.${k}.${p}.`, 5 * 60 * 1000)
      const r = await fetch(`${gw.url}/xdnmb?k=${k}&p=${encodeURIComponent(p)}`, {
        headers: { 'x-sg-bili': token },
      })
      if (r.ok && r.body) {
        return { status: r.status, contentType: r.headers.get('content-type') || 'image/jpeg', body: r.body }
      }
    } catch {
      // 网关不可达：直连兜底
    }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const r = await fetch(xImgAbs(kind, p), {
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        'Referer': 'https://nmbxd.com/',
        'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8',
      },
    })
    if (!r.ok || !r.body) throw new Error(`图片上游返回 ${r.status}`)
    return { status: r.status, contentType: r.headers.get('content-type') || 'image/jpeg', body: r.body }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 净化 X 岛 HTML 片段：
 * - 白名单标签保留，未知标签剥离（script/style 等连内容删除）；
 * - 属性白名单：a[href] img[src] font[color] span[class]；
 * - /t/123、>>No.123 → xdnmb:thread:123（前端容器拦截内部导航）；/f/名 → xdnmb:forum:名；
 * - 外链仅允许 http/https/mailto，强制新窗口；javascript:/data: 一律删；
 * - <img src> 重写为同源代理；裸 img 字段由前端按 xImgUrl 自行组合。
 */
export function purifyXHtml(raw: string, imgKind: 'thumb' | 'image'): string {
  if (!raw) return ''
  let html = raw
  let out = ''
  // 标签扫描器（X 岛 HTML 不规范：属性可能无引号、标签大小写混杂）
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g
  let last = 0
  let m: RegExpExecArray | null
  const stripUntil: string[] = [] // 正在整体丢弃的标签栈
  while ((m = re.exec(html))) {
    const text = html.slice(last, m.index)
    out += stripUntil.length ? '' : linkifyPlain(text)
    last = re.lastIndex
    const closing = m[1] === '/'
    const tag = m[2].toLowerCase()
    const attrRaw = m[3]

    if (stripUntil.length) {
      if (closing && stripUntil[stripUntil.length - 1] === tag) stripUntil.pop()
      continue
    }
    if (TAG_STRIP_CONTENT.has(tag)) {
      if (!closing) stripUntil.push(tag)
      continue
    }
    if (!TAG_ALLOW.has(tag)) continue // 剥离未知标签但保留内容

    if (closing) {
      out += `</${tag}>`
      continue
    }
    const attrs = parseAttrs(attrRaw)
    let kept = ''
    if (tag === 'a') {
      const href = safeHref(attrs.href || attrs[''])
      if (href) kept = ` href="${href}" target="_blank" rel="noopener noreferrer"`
    } else if (tag === 'img') {
      const src = safeImgSrc(attrs.src, imgKind)
      if (!src) { last = re.lastIndex; continue }
      const alt = attrs.alt ? escAttr(attrs.alt.slice(0, 60)) : ''
      kept = ` src="${src}" alt="${alt}" loading="lazy" class="x-img"`
    } else if (tag === 'font' && attrs.color && /^#[0-9a-fA-F]{3,8}$|^[a-zA-Z]{3,20}$/.test(attrs.color)) {
      kept = ` color="${escAttr(attrs.color)}"`
    } else if (tag === 'span' && attrs.class === 'h-thread-info') {
      kept = ' class="h-thread-info"'
    }
    const selfClose = ['br', 'img'].includes(tag)
    out += `<${tag}${kept}${selfClose ? ' /' : ''}>`
  }
  out += stripUntil.length ? '' : linkifyPlain(html.slice(last))
  return out
}

/** 文本节点里的 >>No.123 / >No.123 引用 → 楼层引用协议（前端弹预览，而非直接跳走）；
 *  [h]剧透[/h] → 防剧透黑条（官网由前端 JS 做同一件事，API 返回的是字面文本） */
function linkifyPlain(text: string): string {
  const linked = escLt(text).replace(
    /&gt;&gt;?\s*No\.?\s*(\d{6,})/g,
    (_, id) => `>>No.<a href="xdnmb:ref:${id}">${id}</a>`,
  )
  return linked.replace(/\[h\]([\s\S]*?)\[\/h\]/g, (_, inner: string) => `<span class="x-spoiler">${inner}</span>`)
}

// 只转义新增的裸 <（不触碰已有的合法标签——本函数仅处理标签之间的文本）
function escLt(s: string): string {
  return s.replace(/</g, '&lt;')
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const k = m[1].toLowerCase()
    out[k] = m[2] ?? m[3] ?? m[4] ?? ''
  }
  return out
}

function safeHref(href: string): string {
  const h = href.trim().replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, '&')
  if (/^(javascript|data|vbscript|file):/i.test(h)) return ''
  // 站内串链接：/t/123、t/123
  let mm = /^\/?t\/(\d+)/i.exec(h)
  if (mm) return `xdnmb:thread:${mm[1]}`
  // 完整域名串链接（正文里常见 nmbxd.com / nmbxd1.com 备用域）
  mm = /^https?:\/\/(?:[\w-]+\.)?nmbxd\d?\.com\/t\/(\d+)/i.exec(h)
  if (mm) return `xdnmb:thread:${mm[1]}`
  // 站内版面：/f/名字
  mm = /^\/?f\/([^/?#]+)/i.exec(h)
  if (mm) return `xdnmb:forum:${decodeURIComponent(mm[1])}`
  if (/^https?:\/\//i.test(h) || h.startsWith('mailto:')) return h
  if (/^\d{6,}$/.test(h)) return `xdnmb:thread:${h}`
  return ''
}

function safeImgSrc(src: string, kind: 'thumb' | 'image'): string {
  if (!src) return ''
  let s = src.trim().replace(/&amp;/g, '&')
  // 完整 CDN 地址 → 拆成 path 走代理
  const mm = /^https?:\/\/[^/]*nmb\.best\/(?:image|thumb)\/(.+)$/i.exec(s)
  if (mm) return `/api/xdnmb?action=img&kind=${kind}&p=${encodeURIComponent(mm[1])}`
  // 协议相对 / 根路径
  if (s.startsWith('//')) s = `https:${s}`
  if (/^https?:\/\//i.test(s)) {
    // 外站图片直接放行（X 岛内容偶有外链图）
    return s
  }
  if (/^[\w./-]+\.(?:jpg|jpeg|png|gif|webp)$/i.test(s)) {
    return `/api/xdnmb?action=img&kind=${kind}&p=${encodeURIComponent(s.replace(/^\/+/, ''))}`
  }
  return ''
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
