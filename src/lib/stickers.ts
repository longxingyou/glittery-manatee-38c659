import qingbaoManifest from '../../public/stickers/qingbao/manifest.json'
import httpcatManifest from '../../public/stickers/httpcat/manifest.json'

export interface StickerDef {
  id: string
  desc: string
  /** 图片 URL（相对路径或绝对 URL） */
  url: string
}

export type StickerSet = 'qingbao' | 'httpcat'

export const STICKER_SETS: { key: StickerSet; label: string; stickers: StickerDef[] }[] = [
  {
    key: 'qingbao',
    label: '晴宝',
    stickers: (qingbaoManifest as { id: string; desc: string; file: string }[]).map((e) => ({
      id: e.id,
      desc: e.desc,
      url: `/stickers/qingbao/${encodeURIComponent(e.file)}`,
    })),
  },
  {
    key: 'httpcat',
    label: 'HTTP Cat',
    stickers: (httpcatManifest as { id: string; desc: string; url: string }[]).map((e) => ({
      id: e.id,
      desc: e.desc,
      url: e.url,
    })),
  },
]

const STICKER_MAP = new Map<string, StickerDef>()
/** shortcode（不含冒号，如 `qingbao-01`）→ 表情定义，供常用表情缓存解析 */
const STICKER_BY_SHORTCODE = new Map<string, StickerDef>()
for (const set of STICKER_SETS) {
  for (const s of set.stickers) {
    STICKER_MAP.set(`${set.key}:${s.id}`, s)
    STICKER_BY_SHORTCODE.set(`${set.key}-${s.id}`, s)
  }
}

/* ===================== 常用表情（本地缓存） =====================
 * 数据保存在浏览器 localStorage，按「使用次数降序、同频次按最近使用降序」排列。
 * 所有读写均做 SSR 与隐私模式（iOS Safari 无痕浏览等会抛异常）降级处理，
 * 桌面端与移动端、各主流浏览器行为一致。 */

const FREQ_STORAGE_KEY = 'sticker-freq'
/** 本地最多保留的记录条数（超出后按频次/时间裁剪） */
const FREQ_MAX_ENTRIES = 100

interface FreqEntry {
  /** 使用次数 */
  c: number
  /** 最近一次使用时间戳 */
  t: number
}
type FreqStore = Record<string, FreqEntry>

function readFreqStore(): FreqStore {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(FREQ_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const store: FreqStore = {}
    for (const [code, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        entry && typeof entry === 'object' &&
        Number.isFinite((entry as FreqEntry).c) && Number.isFinite((entry as FreqEntry).t)
      ) {
        store[code] = { c: (entry as FreqEntry).c, t: (entry as FreqEntry).t }
      }
    }
    return store
  } catch {
    return {}
  }
}

function writeFreqStore(store: FreqStore): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(FREQ_STORAGE_KEY, JSON.stringify(store))
  } catch {
    // 隐私模式 / 存储配额不足 / 被禁用时静默降级，不影响表情插入
  }
}

/** 记录一次表情使用；shortcode 形如 `:qingbao-01:`，会自动剥离冒号 */
export function recordStickerUse(shortcode: string): void {
  const code = shortcode.replace(/^:+|:+$/g, '')
  if (!STICKER_BY_SHORTCODE.has(code)) return
  const store = readFreqStore()
  const prev = store[code]
  store[code] = { c: (prev?.c ?? 0) + 1, t: Date.now() }

  const entries = Object.entries(store)
  if (entries.length <= FREQ_MAX_ENTRIES) {
    writeFreqStore(store)
    return
  }
  // 超量时按频次降序、同频次按最近使用降序裁剪
  entries.sort((a, b) => b[1].c - a[1].c || b[1].t - a[1].t)
  const kept: FreqStore = {}
  for (const [code, entry] of entries.slice(0, FREQ_MAX_ENTRIES)) kept[code] = entry
  writeFreqStore(kept)
}

export interface FrequentSticker {
  /** 不含冒号的 shortcode */
  shortcode: string
  def: StickerDef
  count: number
}

/** 读取常用表情：频次降序 + 最近使用降序，自动过滤已下架的表情 */
export function getFrequentStickers(limit = 24): FrequentSticker[] {
  const store = readFreqStore()
  const result: (FrequentSticker & { lastUsed: number })[] = []
  for (const [code, entry] of Object.entries(store)) {
    const def = STICKER_BY_SHORTCODE.get(code)
    if (!def) continue
    result.push({ shortcode: code, def, count: entry.c, lastUsed: entry.t })
  }
  return result
    .sort((a, b) => b.count - a.count || b.lastUsed - a.lastUsed)
    .slice(0, limit)
    .map(({ shortcode, def, count }) => ({ shortcode, def, count }))
}

/** 将 shortcode :set-id: 转为 <img> HTML */
export function renderStickerShortcode(text: string): string {
  return text.replace(/:(qingbao|httpcat)-(\w+):/g, (match, set: string, id: string) => {
    const sticker = STICKER_MAP.get(`${set}:${id}`)
    if (!sticker) return match
    const escaped = sticker.desc.replace(/"/g, '&quot;')
    return `<img src="${sticker.url}" alt="${escaped}" class="sticker" loading="lazy" />`
  })
}

/** 判断文本中是否包含表情包 shortcode */
export function hasStickerShortcode(text: string): boolean {
  return /:(qingbao|httpcat)-\w+:/.test(text)
}
