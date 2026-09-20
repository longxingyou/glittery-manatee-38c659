import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ---- 前后台共享的可序列化类型（静态文章与数据库文章的统一形状）----
export type PostStatus = 'draft' | 'published'

export type PostLanguage = 'zh' | 'en' | 'ru'
export const POST_LANGUAGES: PostLanguage[] = ['zh', 'en', 'ru']
export function isPostLanguage(v: unknown): v is PostLanguage {
  return v === 'zh' || v === 'en' || v === 'ru'
}

export type PostData = {
  id: number | null
  slug: string
  title: string
  summary: string
  content: string
  categories: string[]
  date: string
  readingTime: number
  status: PostStatus
  source: 'static' | 'db'
  updatedAt: string | null
  language: PostLanguage
  /** 同一篇文章的多语言版本共享此键（通常取原文 slug）；null 表示独立文章 */
  translationKey: string | null
}

/** 列表折叠时的语言优先级：当前语言 → 英语 → 任一 */
const LANG_FALLBACK: Record<PostLanguage, PostLanguage[]> = {
  zh: ['zh', 'en', 'ru'],
  en: ['en', 'zh', 'ru'],
  ru: ['ru', 'en', 'zh'],
}

/**
 * 同一 translationKey 的多语言版本在列表中只保留一条：
 * 优先当前语言，其次英语，最后组内任意一条；translationKey 为 null 的文章始终保留。
 */
export function foldPostsForLang(posts: PostData[], lang: PostLanguage): PostData[] {
  const groups = new Map<string, PostData[]>()
  const standalone: PostData[] = []
  for (const p of posts) {
    if (!p.translationKey) {
      standalone.push(p)
      continue
    }
    const arr = groups.get(p.translationKey)
    if (arr) arr.push(p)
    else groups.set(p.translationKey, [p])
  }
  const picked = [...groups.values()].map((arr) => {
    for (const l of LANG_FALLBACK[lang]) {
      const hit = arr.find((p) => p.language === l)
      if (hit) return hit
    }
    return arr[0]!
  })
  return [...standalone, ...picked]
}

/** 某篇文章的全部语言版本（含自身；无翻译组时仅自身），按 zh/en/ru 排序 */
export function getPostSiblings(posts: PostData[], slug: string): PostData[] {
  const current = posts.find((p) => p.slug === slug)
  if (!current) return []
  if (!current.translationKey) return [current]
  return posts
    .filter((p) => p.translationKey === current.translationKey)
    .sort((a, b) => POST_LANGUAGES.indexOf(a.language) - POST_LANGUAGES.indexOf(b.language))
}

export type AttachmentPublic = {
  id: number
  postSlug: string
  filename: string
  mimeType: string
  sizeBytes: number
  downloads: number
  createdAt: string
  locked: boolean
}

/** 分类的三语名称：name 为权威中文名，nameEn/nameRu 为可空译名 */
export type CategoryLabel = {
  name: string
  nameEn: string | null
  nameRu: string | null
}

export type CategoryInfo = CategoryLabel & {
  id: number
  dbCount: number
  staticCount: number
  builtin: boolean
}

export type SiteSettings = {
  siteTitle: string
  siteDescription: string
  customCss: string
}

export type AdminSettings = SiteSettings & {
  adminEmails: string
  /** 违禁词表（逗号或换行分隔），叠加内置基础词表生效 */
  bannedWords: string
}

export type AdminStatus = {
  authed: boolean
  email: string | null
  isAdmin: boolean
  adminConfigured: boolean
}

// ──────────────────────────────────────────────
// 月品木子（二字口令网盘/图床）接入
// 文件在该站上传后加密为「二字口令」，https://…/?q=口令 即取件链接；
// 站方为纯静态加密，无公开上传 API，故博客侧只做取件展示与编辑辅助。
// ──────────────────────────────────────────────
/** 取件链接基址（q 参数 = 二字口令） */
export const PICKUP_URL_BASE = 'https://xn--cnqs3e5vdw9icjz2q1eaa.xyz/?q='

/** 取件域名（punycode 与 unicode 两种形态） */
const PICKUP_HOST_RE = /^(xn--cnqs3e5vdw9icjz2q1eaa|清冷仙子哦齁齁齁)\.xyz$/

/** 从完整 URL 中提取二字口令；非取件链接返回 null */
export function pickupCodeFromUrl(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' || !PICKUP_HOST_RE.test(u.hostname)) return null
    const q = u.searchParams.get('q')
    return q && q.trim() ? q.trim().slice(0, 64) : null
  } catch {
    return null
  }
}

/** 编辑器输入解析：接受完整取件链接或直接给口令（≤64 字符） */
export function pickupCodeFromInput(input: string): string | null {
  const s = input.trim()
  if (!s) return null
  if (/^https:/i.test(s)) return pickupCodeFromUrl(s)
  return /^[\p{L}\p{N}]{1,64}$/u.test(s) ? s : null
}

/** 生成取件 Markdown 链接（空标签；渲染端自动显示口令取件卡片） */
export function pickupMarkdown(code: string): string {
  return `[](${PICKUP_URL_BASE}${encodeURIComponent(code)})`
}

export const DEFAULT_SITE_TITLE = 'ThoracicTag4669 · 可运行的文字'
export const DEFAULT_SITE_DESCRIPTION = '随性记录。'

// ---- 前后台共享工具 ----
export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++ }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function slugify(input: string) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 160)
}

/** 附件下载/解锁 URL（全部复用 /api/comments 路由以避免新建文件） */
export function attachmentDownloadUrl(id: number, token?: string) {
  const qs = new URLSearchParams({ action: 'file', id: String(id) })
  if (token) qs.set('token', token)
  return `/api/comments?${qs.toString()}`
}
export function attachmentTokenUrl(id: number) {
  return `/api/comments?action=token&id=${encodeURIComponent(id)}`
}
export function attachmentUploadUrl() {
  return '/api/comments?action=upload'
}

/** 反馈附件：上传（POST multipart）与下载（GET，服务端校验本人/管理员） */
export function feedbackUploadUrl() {
  return '/api/comments?action=feedbackUpload'
}
export function feedbackFileUrl(id: number) {
  return `/api/comments?action=feedbackFile&id=${encodeURIComponent(id)}`
}

/** 计算 Markdown 阅读时长（分钟） */
export function estimateReadingTime(content: string) {
  const clean = content.replace(/[#*`>$\[\]()_-]/g, '')
  return Math.max(2, Math.ceil(clean.length / 500))
}

