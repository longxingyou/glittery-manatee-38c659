import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ---- 前后台共享的可序列化类型（静态文章与数据库文章的统一形状）----
export type PostStatus = 'draft' | 'published'

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

export type CategoryInfo = {
  id: number
  name: string
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
}

export type AdminStatus = {
  authed: boolean
  email: string | null
  isAdmin: boolean
  adminConfigured: boolean
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

/** 计算 Markdown 阅读时长（分钟） */
export function estimateReadingTime(content: string) {
  const clean = content.replace(/[#*`>$\[\]()_-]/g, '')
  return Math.max(2, Math.ceil(clean.length / 500))
}

