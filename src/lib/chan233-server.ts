/**
 * 233chan（里岛匿名版，x.1145141919810.org，Tinyboard/vichan 5.1.3 引擎）服务端客户端。
 *
 * 站点特点（实测）：
 * - 源站不稳定：约半数请求超时/部分网络不可达（"只有某些 WiFi 能访问"的根因），
 *   因此与 X 岛同构：网关优先、直连兜底；令牌复用 bili HMAC 域（载荷 c233. 命名空间）。
 * - vichan JSON API 已开放，但路径与标准 vichan 略有出入（实测）：
 *     <board>/threads.json / catalog.json / pages.json / <页码>.json   → 数组（分页 → {threads:[...]})
 *     <board>/res/<id>.json                                            → {posts:[...]}（串 JSON 不是 thread/<id>.json）
 *     <board>/src/<tim><ext> 与 <board>/thumb/<tim>.png                → 原图 / 缩略图（缩略图统一 .png 扩展名）
 *     assets/countryballs/<code>.png                                   → 波兰球国别旗帜
 * - 只读不发言：vichan 发帖需过验证码（captcha.php），网页端点没有可编程的发言通道。
 * - 帖子字段：id=8 位饼干 ID（每日变化、同 IP 同色）、country=波兰球、
 *   name 为随机化中文昵称（站方特性）、com 为服务端渲染的 HTML 片段。
 */
import { gatewayConfig, signGwToken } from './attachment-store.js'

export const C233_BASE = 'https://x.1145141919810.org'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

// ───────────────────────── 数据模型 ─────────────────────────

/** vichan 帖子字段（仅保留用到的） */
export interface VPost {
  no: number
  resto: number
  time?: number
  sub?: string
  /** 服务端净化后的正文 HTML（v:ref: 内部协议链接） */
  com?: string
  name: string
  trip?: string
  /** 8 位饼干 ID（每日轮换；同 IP 当日同 ID） */
  id?: string
  country?: string
  country_name?: string
  /** 附件 */
  filename?: string
  ext?: string
  tim?: string
  w?: number
  h?: number
  tn_w?: number
  tn_h?: number
  fsize?: number
  /** OP 专属 */
  sticky?: boolean
  locked?: boolean
  replies?: number
  images?: number
  last_modified?: number
}

/** 串列表卡片（catalog / 分页 JSON 归一化） */
export interface VThreadCard {
  tid: number
  sticky: boolean
  locked: boolean
  op: VPost
  /** 回复数（catalog 附带最近回复，回退计数） */
  replies: number
  images: number
  /** 最后活动时间（unix 秒） */
  lastAt: number
  /** 所属版面（仅 timeline 聚合时附带） */
  board?: string
}

/** 串详情 */
export interface VThread {
  op: VPost
  posts: VPost[]
}

/** 版面定义（静态结构，源自站 sidebar.html；nsfw 标记来自站方分组） */
export interface VBoard {
  id: string
  title: string
  nsfw?: boolean
}

export interface VBoardGroup {
  name: string
  boards: VBoard[]
}

/** 版面分组（与站方 boardlist 一致：顶层 mizuka/kagari + 5 个 sub 组；组名为自拟展示名） */
export const C233_BOARD_GROUPS: VBoardGroup[] = [
  {
    name: '主版',
    boards: [
      { id: 'mizuka', title: 'mizuka' },
      { id: 'kagari', title: '值班室' },
    ],
  },
  {
    name: '综合',
    boards: [
      { id: 'ayu', title: '公告 & 帮助' },
      { id: 'kotori', title: '综合2.1' },
      { id: 'news', title: '速报' },
      { id: 'akane', title: '弹幕网站' },
      { id: 'TK', title: '原·创' },
      { id: 'int', title: 'International' },
      { id: 'int22', title: 'International【NSFW】', nsfw: true },
    ],
  },
  {
    name: '兴趣',
    boards: [
      { id: 'komari', title: '二次元综合' },
      { id: 'pani', title: '西方动画' },
      { id: 'kud', title: 'VTuber' },
      { id: 'saya', title: '三次元欢乐' },
      { id: 'yumemi', title: '推歌' },
    ],
  },
  {
    name: '创作与思辨',
    boards: [
      { id: 'kyousuke', title: '原创·二创' },
      { id: 'lucia', title: '政治' },
      { id: 'makoto', title: '哲学' },
    ],
  },
  {
    name: '生活',
    boards: [
      { id: 'masato', title: '家长不宜【NSFW】', nsfw: true },
      { id: 'Yui', title: '媒体【试行/NSFW】', nsfw: true },
      { id: 'chihaya', title: '情感' },
      { id: 'pic', title: '摄影' },
      { id: 'giru', title: '角落' },
    ],
  },
  {
    name: '游戏',
    boards: [
      { id: 'shiori', title: '游戏综合' },
      { id: 'haruka', title: 'STG' },
      { id: 'mio', title: '卡牌游戏' },
    ],
  },
]

/** 平铺版面 → 快速校验 slug（防把任意路径当版面透传上游） */
export function c233Board(id: string): VBoard | null {
  const lower = id.toLowerCase()
  for (const g of C233_BOARD_GROUPS) {
    for (const b of g.boards) if (b.id.toLowerCase() === lower) return b
  }
  return null
}

// ───────────────────────── 上游请求（网关优先，直连兜底） ─────────────────────────

/**
 * 拉取 vichan JSON（网关优先：站点对部分网络不可达且源站不稳定，网关出口更稳；
 * 网关 4xx 为业务响应（如 404 串不存在）直接交还；5xx/网关故障才回退直连）。
 */
async function c233FetchRaw(path: string): Promise<Response> {
  const gw = gatewayConfig()
  if (gw) {
    try {
      const token = await signGwToken('bili', `c233.api.${path}`, 5 * 60 * 1000)
      const r = await fetch(`${gw.url}/c233?k=api&p=${encodeURIComponent(path)}`, {
        headers: { 'x-sg-bili': token },
      })
      if (r.ok || (r.status >= 400 && r.status < 500)) return r
    } catch {
      // 网关不可达：走直连
    }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    return await fetch(`${C233_BASE}/${path}`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept': 'application/json, */*;q=0.8', 'Referer': `${C233_BASE}/` },
    })
  } finally {
    clearTimeout(timer)
  }
}

async function c233Fetch<T>(path: string): Promise<T> {
  const res = await c233FetchRaw(path)
  const text = await res.text()
  if (!res.ok) {
    let msg = `233chan 返回 HTTP ${res.status}`
    try {
      // vichan 404 页是 HTML，取 title 提示更友好
      const t = /<title>([^<]*)<\/title>/i.exec(text)
      if (t?.[1]) msg = t[1].trim()
    } catch { /* ignore */ }
    throw new Error(msg)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error('233chan 返回了无法解析的响应。')
  }
}

/** 拉取站点附件（网关优先绕开 Worker 出口对 Cloudflare 站点的不稳定性；失败直连兜底） */
export async function c233ImgUpstream(
  p: string,
): Promise<{ status: number; contentType: string; body: ReadableStream<Uint8Array> }> {
  const gw = gatewayConfig()
  if (gw) {
    try {
      const token = await signGwToken('bili', `c233.img.${p}`, 5 * 60 * 1000)
      const r = await fetch(`${gw.url}/c233?k=img&p=${encodeURIComponent(p)}`, {
        headers: { 'x-sg-bili': token },
      })
      if (r.ok && r.body) {
        return { status: r.status, contentType: r.headers.get('content-type') || 'image/png', body: r.body }
      }
    } catch {
      // 网关不可达：直连兜底
    }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20000)
  try {
    const r = await fetch(`${C233_BASE}/${p}`, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8',
        'Referer': `${C233_BASE}/`,
      },
    })
    if (!r.ok || !r.body) throw new Error(`附件上游返回 ${r.status}`)
    return { status: r.status, contentType: r.headers.get('content-type') || 'image/png', body: r.body }
  } finally {
    clearTimeout(timer)
  }
}

// ───────────────────────── 读取 API ─────────────────────────

type RawPost = Record<string, unknown>

const num = (v: unknown): number | undefined =>
  typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined
const bool = (v: unknown) => v === 1 || v === true || v === '1'
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function toVPost(raw: RawPost): VPost {
  return {
    no: num(raw.no) || 0,
    resto: num(raw.resto) || 0,
    time: num(raw.time),
    sub: str(raw.sub),
    com: str(raw.com),
    name: str(raw.name) || 'Anonymous',
    trip: str(raw.trip),
    id: str(raw.id),
    country: str(raw.country),
    country_name: str(raw.country_name),
    filename: str(raw.filename),
    ext: str(raw.ext),
    tim: str(raw.tim),
    w: num(raw.w),
    h: num(raw.h),
    tn_w: num(raw.tn_w),
    tn_h: num(raw.tn_h),
    fsize: num(raw.fsize),
    sticky: bool(raw.sticky),
    locked: bool(raw.locked),
    replies: num(raw.replies),
    images: num(raw.images),
    last_modified: num(raw.last_modified),
  }
}

/** catalog.json → 串卡片列表（catalog 是分页数组 [{threads:[op, ...]}, ...]，threads 每项是单串 OP，需摊平） */
export async function getCatalog(board: string): Promise<VThreadCard[]> {
  const raw = await c233Fetch<Array<{ threads?: RawPost[] }>>(`${board}/catalog.json`)
  const ops: RawPost[] = (Array.isArray(raw) ? raw : []).flatMap((pg) =>
    pg && typeof pg === 'object' && Array.isArray(pg.threads) ? pg.threads : [],
  )
  return ops.map((op) => threadToCard([op])).filter((t): t is VThreadCard => !!t)
}

/** <页码>.json → 该页串卡片（每页是 [ [op, ...回复], ... ]） */
export async function getBoardPage(board: string, page: number): Promise<VThreadCard[]> {
  const raw = await c233Fetch<RawPost[][]>(`${board}/${Math.max(0, page | 0)}.json`)
  return (Array.isArray(raw) ? raw : [])
    .map((posts) => threadToCard(Array.isArray(posts) ? posts : []))
    .filter((t): t is VThreadCard => !!t)
}

// ── 综合时间线：25 版并发聚合，60s 实例内缓存 ──

export interface VTimeline {
  cards: VThreadCard[]
  /** 本次拉取失败的版面（上游抖动时跳过，下次刷新自愈） */
  partial: string[]
}

const TIMELINE_TTL = 60_000
let timelineCache: { at: number; data: VTimeline } | null = null

/** 全站最近活跃串（按 lastAt 降序截前 limit 条；sticky 串不特殊对待，纯按时间） */
export async function getTimeline(limit = 200): Promise<VTimeline> {
  if (timelineCache && Date.now() - timelineCache.at < TIMELINE_TTL) return timelineCache.data
  const boards = C233_BOARD_GROUPS.flatMap((g) => g.boards.map((b) => b.id))
  const settled = await Promise.allSettled(boards.map((b) => getCatalog(b)))
  const cards: VThreadCard[] = []
  const partial: string[] = []
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      for (const c of r.value) cards.push({ ...c, board: boards[i] })
    } else {
      partial.push(boards[i])
    }
  })
  cards.sort((a, b) => b.lastAt - a.lastAt)
  const data: VTimeline = { cards: cards.slice(0, Math.max(1, limit)), partial }
  // 全失败（上游整体不可达）不缓存，让下次请求重试
  if (partial.length < boards.length) timelineCache = { at: Date.now(), data }
  return data
}

/** res/<id>.json → 串详情（全量楼层） */
export async function getThread(board: string, id: string): Promise<VThread> {
  const raw = await c233Fetch<{ posts?: RawPost[] }>(`${board}/res/${id}.json`)
  const posts = (Array.isArray(raw?.posts) ? raw.posts : []).map(toVPost)
  if (!posts.length) throw new Error('串不存在或已被删除。')
  const [opRaw, ...rest] = posts
  const op = { ...opRaw, com: purifyVichanHtml(opRaw.com, opRaw.no) }
  return { op, posts: [op, ...rest.map((p) => ({ ...p, com: purifyVichanHtml(p.com, op.no) }))] }
}

/** 一串原始 posts → 卡片（净化 OP 正文） */
function threadToCard(posts: RawPost[]): VThreadCard | null {
  if (!posts.length) return null
  const op = toVPost(posts[0])
  const last = posts[posts.length - 1]
  const lastAt =
    num(last.time) || op.last_modified || op.time || 0
  const replies = op.replies ?? (posts.length > 1 ? posts.length - 1 : 0)
  return {
    tid: op.no,
    sticky: !!op.sticky,
    locked: !!op.locked,
    op: { ...op, com: purifyVichanHtml(op.com, op.no) },
    replies,
    images: op.images ?? 0,
    lastAt,
  }
}

// ───────────────────────── 附件地址 ─────────────────────────

/** vichan 原图 src/<tim><ext>；缩略图统一 thumb/<tim>.png（实测，与原文件扩展名无关） */
export function c233ImgPath(board: string, tim: string, ext: string, kind: 'thumb' | 'src'): string {
  if (!tim || !ext) return ''
  const b = board.replace(/^\/+|\/+$/g, '')
  return kind === 'src' ? `${b}/src/${tim}${ext}` : `${b}/thumb/${tim}.png`
}

/** 波兰球旗帜路径（站点按两位国家码存 png，实测大小写不敏感） */
export function c233FlagPath(code: string): string {
  return /^[\w]{1,12}$/.test(code) ? `assets/countryballs/${code.toLowerCase()}.png` : ''
}

// ───────────────────────── vichan HTML 净化 ─────────────────────────
//
// vichan 的 com 是服务端渲染的规范 HTML（属性带引号），比 X 岛脏 HTML 干净得多：
// - 引用链接 <a onclick="highlightReply(...)" href="/<board>/res/<tid>.html#<no>">&gt;&gt;no</a>
//   → href 重写为 v:ref:<no>@<tid> 协议（前端弹预览/定位），内部文本原样保留
// - <span class="quote">（绿色引用）、<span class="spoiler">（防剧透）保留
// - 附件图在 JSON 字段里不在 com 里；com 内 <img>/<video> 等媒体标签一律丢弃

const V_TAG_ALLOW = new Set([
  'a', 'b', 'i', 's', 'u', 'strong', 'em', 'br', 'p', 'span', 'blockquote',
  'small', 'sub', 'sup', 'ul', 'ol', 'li', 'code', 'pre',
])
// 这些标签连同内容整体丢弃（img/br/hr/input 等 void 标签直接跳过，不入栈）
const V_TAG_DROP_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'form', 'table', 'video', 'audio'])
const V_TAG_VOID = new Set(['img', 'br', 'hr', 'input', 'area', 'source', 'wbr'])

export function purifyVichanHtml(raw: string | undefined, curTid: number): string {
  if (!raw) return ''
  let out = ''
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g
  let last = 0
  let m: RegExpExecArray | null
  const strip: string[] = []
  let inQuoteLink = false // 当前位于 v-ql 锚点内：内部文本原样保留，避免二次套链
  while ((m = re.exec(raw))) {
    out += strip.length ? '' : inQuoteLink ? escLt(raw.slice(last, m.index)) : linkifyVText(raw.slice(last, m.index), curTid)
    last = re.lastIndex
    const closing = m[1] === '/'
    const tag = m[2].toLowerCase()
    const attrs = m[3] || ''
    if (strip.length) {
      if (closing && strip[strip.length - 1] === tag) strip.pop()
      continue
    }
    if (V_TAG_VOID.has(tag)) continue // void 标签一律丢弃（com 里的附件图等）
    if (V_TAG_DROP_CONTENT.has(tag)) {
      if (!closing) strip.push(tag)
      continue
    }
    if (!V_TAG_ALLOW.has(tag)) continue // 剥离未知标签但保留内容

    if (closing) {
      if (tag === 'a') inQuoteLink = false
      out += `</${tag}>`
      continue
    }
    let kept = ''
    if (tag === 'a') {
      const cls = vLinkClass(attrValue(attrs, 'href'))
      if (cls === 'ql') {
        const href = vRefHref(attrValue(attrs, 'href'), curTid)
        kept = ` href="${href}" class="v-ql"`
        inQuoteLink = true
      } else if (cls === 'ext') {
        const href = escAttr(attrValue(attrs, 'href'))
        if (!href) {
          last = re.lastIndex
          continue
        }
        kept = ` href="${href}" target="_blank" rel="noopener noreferrer nofollow"`
      } else {
        last = re.lastIndex
        continue // 无效链接：剥标签留文本
      }
    } else if (tag === 'span') {
      const cls = attrValue(attrs, 'class')
      if (cls === 'quote' || cls === 'spoiler') kept = ` class="${cls}"`
      else {
        last = re.lastIndex
        continue
      }
    }
    const voided = tag === 'br'
    out += `<${tag}${kept}${voided ? ' /' : ''}>`
  }
  out += strip.length ? '' : inQuoteLink ? escLt(raw.slice(last)) : linkifyVText(raw.slice(last), curTid)
  return out
}

/** 从 quotelink href（/<board>/res/<tid>.html#<no>）提取 v:ref:<no>@<tid> 协议地址 */
function vRefHref(href: string, curTid: number): string {
  const m = /\/res\/(\d+)\.html(?:#(\d+))?/i.exec(href)
  if (!m) return `v:ref:0@${curTid}`
  return `v:ref:${m[2] || m[1]}@${m[1]}`
}

/** 判断 a 标签类别：站内串引用 → 'ql'；https 外链 → 'ext'；其余丢弃 */
function vLinkClass(href: string): 'ql' | 'ext' | '' {
  const h = (href || '').trim()
  if (!h) return ''
  if (/\/res\/\d+\.html/i.test(h)) return 'ql'
  if (/^(https?:)?\/\//i.test(h)) {
    const abs = h.startsWith('//') ? `https:${h}` : h
    return /^https:\/\//i.test(abs) ? 'ext' : ''
  }
  return ''
}

/** 文本节点：裸 >>123 引用补链（vichan 通常已 linkify，此处兜底） */
function linkifyVText(text: string, curTid: number): string {
  return escLt(text).replace(/&gt;&gt;\s*(\d{1,12})/g, (_, no: string) => `&gt;&gt;<a href="v:ref:${no}@${curTid}" class="v-ql">${no}</a>`)
}

// 只转义新增的裸 <（不触碰已有的合法标签——本函数仅处理标签之间的文本）
function escLt(s: string): string {
  return s.replace(/</g, '&lt;')
}

function attrValue(attrs: string, name: string): string {
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const m = re.exec(attrs)
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : ''
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
