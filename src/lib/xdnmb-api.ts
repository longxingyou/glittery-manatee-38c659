/**
 * X 岛匿名版共享 API fetcher（主站 + 爬虫 Worker 共用）。
 *
 * 设计要点：
 * - 纯 fetcher：所有函数接受 `gw: XdGateway | null` 参数，由调用方决定网关配置
 * - 不做 HTML 净化：返回 X 岛原始 HTML 片段，主站需自行调用 purifyXHtml，
 *   爬虫需自行调用 toPlain 转纯文本
 * - 内联 HMAC 签名：signXdGwToken 与 attachment-store.signGwToken 算法一致，
 *   避免爬虫 Worker 引入 Telegram 依赖
 * - toPlain 在此导出：爬虫与 xdnmb-crawler.ts 共用
 */
import type { XForumGroup, XPost, XTimeline } from './xdnmb-types.js'

export type { XForumGroup, XPost, XTimeline } from './xdnmb-types.js'

export const X_API = 'https://api.nmb.best/api'
export const X_IMG = 'https://image.nmb.best'
export const X_WEB = 'https://nmbxd.com'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** Azure 网关配置（主站从 attachment-store.gatewayConfig() 取，爬虫从 env 构造） */
export interface XdGateway {
  /** 网关 base URL（无尾斜杠） */
  url: string
  /** 下载专用地址（缺省同 url） */
  dlUrl: string
  /** HMAC 密钥 */
  secret: string
}

// ───────────────────────── HMAC 签名 ─────────────────────────

function b64urlBytes(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const enc = new TextEncoder()

/**
 * 签发网关 HMAC 令牌：`<exp>.<payloadB64url>.<sigB64url>`
 * 与 deploy/botapi-gateway/gateway/server.mjs 的校验算法、
 * 与 attachment-store.signGwToken 的签名算法保持一致。
 */
export async function signXdGwToken(
  gw: XdGateway,
  payload: string,
  ttlMs: number,
): Promise<string> {
  const exp = Date.now() + ttlMs
  const data = `bili.${exp}.${payload}`
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(gw.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = b64urlBytes(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data))))
  return `${exp}.${b64urlBytes(enc.encode(payload))}.${sig}`
}

// ───────────────────────── HTML → 纯文本 ─────────────────────────

const REPLY_PREVIEW_CAP = 4000 // 单楼纯文本最大保存长度（与 db schema 一致）

/** 把 X 岛 HTML 片段转纯文本（搜索索引用，不需要保留任何标签） */
export function toPlain(html: string): string {
  if (!html) return ''
  // 先把 <br> 转 \n，<p>/<div> 块级标签也补 \n，再统一剥标签
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&bull;/g, '•')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, REPLY_PREVIEW_CAP)
}

// ───────────────────────── 核心 fetcher ─────────────────────────

/**
 * 经 Azure 网关转发 X 岛 API（Cloudflare Worker 出口 IP 被 403，
 * 与 B站/抖音同因）；网关未配置或返回错误时直连兜底。
 * 网关令牌载荷绑定 `xdnmb.api.<path>.<userhash>`，5 分钟有效。
 */
export async function xFetchRaw(
  path: string,
  userhash: string,
  gw: XdGateway | null,
): Promise<Response> {
  if (gw) {
    try {
      const token = await signXdGwToken(gw, `xdnmb.api.${path}.${userhash}`, 5 * 60 * 1000)
      const gwUrl =
        `${gw.url}/xdnmb?k=api&p=${encodeURIComponent(path)}` +
        (userhash ? `&uh=${encodeURIComponent(userhash)}` : '')
      const r = await fetch(gwUrl, { headers: { 'x-sg-bili': token } })
      if (r.ok) return r
      // 上游 4xx 是业务响应（如"该串不存在"/需要饼干）：直接交还解析器，错误信息更准确；
      // 5xx/网关故障才回退直连
      if (r.status >= 400 && r.status < 500) return r
    } catch {
      // 网关不可达：走直连
    }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12000)
  try {
    return await fetch(`${X_API}/${path}`, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...(userhash ? { Cookie: `userhash=${userhash}` } : {}),
      },
    })
  } finally {
    clearTimeout(timer)
  }
}

/** JSON fetch + 统一错误处理 */
export async function xFetch<T>(
  path: string,
  userhash: string,
  gw: XdGateway | null,
): Promise<T> {
  const res = await xFetchRaw(path, userhash, gw)
  const text = await res.text()
  let data: unknown = null
  try {
    data = JSON.parse(text)
  } catch {
    // 非 JSON：HTTP 失败或裸字符串错误
    if (!res.ok) throw new Error(`X 岛请求失败（HTTP ${res.status}）`)
    throw new Error(text.slice(0, 120) || 'X 岛返回了无法解析的响应。')
  }
  if (!res.ok) {
    const msg =
      (data as { error?: string } | null)?.error ||
      (typeof data === 'string' ? data : `HTTP ${res.status}`)
    throw new Error(msg)
  }
  // 应用层错误：{ success:false, error } 或裸字符串
  if (data && typeof data === 'object' && (data as { success?: boolean }).success === false) {
    throw new Error((data as { error?: string }).error || 'X 岛返回错误。')
  }
  if (typeof data === 'string') throw new Error(data)
  return data as T
}

// ───────────────────────── 纯 fetcher（返回原始 HTML，不净化） ─────────────────────────

/** 版面分组列表（无缓存，调用方按需自加） */
export async function getForums(
  userhash: string,
  gw: XdGateway | null,
): Promise<XForumGroup[]> {
  const groups = await xFetch<XForumGroup[]>('getForumList', userhash, gw)
  return Array.isArray(groups) ? groups : []
}

/** 时间线分区列表（无缓存） */
export async function getTimelineList(gw: XdGateway | null): Promise<XTimeline[]> {
  const list = await xFetch<XTimeline[]>('getTimelineList', '', gw)
  return Array.isArray(list) ? list : []
}

/** 版面串列表（含最近回复预览；原始 HTML） */
export async function showForum(
  fid: string,
  page: number,
  userhash: string,
  gw: XdGateway | null,
): Promise<XPost[]> {
  const list = await xFetch<XPost[]>(
    `showf?id=${encodeURIComponent(fid)}&page=${Math.max(1, page | 0 || 1)}`,
    userhash,
    gw,
  )
  return Array.isArray(list) ? list : []
}

/** 时间线串列表（原始 HTML） */
export async function showTimeline(
  tid: string,
  page: number,
  userhash: string,
  gw: XdGateway | null,
): Promise<XPost[]> {
  const list = await xFetch<XPost[]>(
    `timeline?id=${encodeURIComponent(tid)}&page=${Math.max(1, page | 0 || 1)}`,
    userhash,
    gw,
  )
  return Array.isArray(list) ? list : []
}

/** 串详情（主楼 + 当页回复；原始 HTML） */
export async function getThread(
  id: string,
  page: number,
  userhash: string,
  gw: XdGateway | null,
): Promise<XPost> {
  return await xFetch<XPost>(
    `thread?id=${encodeURIComponent(id)}&page=${Math.max(1, page | 0 || 1)}`,
    userhash,
    gw,
  )
}

/** 单楼查询（>>No.xxx 引用预览；ref 只返回该楼本身，无 Replies；原始 HTML） */
export async function getRef(
  id: string,
  userhash: string,
  gw: XdGateway | null,
): Promise<XPost> {
  return await xFetch<XPost>(`ref?id=${encodeURIComponent(id)}`, userhash, gw)
}
