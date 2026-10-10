/**
 * 附件预览格式矩阵（前后端/Worker 同构，无任何专有运行时依赖）。
 *
 * 两类预览：
 * - 浏览器直渲：pdf / md / 文本 / csv / html / 图片 / 音视频 / 思维导图
 *   （xmind/mm/opml），文件字节仍走网关直连，不占 Worker。
 * - 服务端转换：Office 系（ppt/doc/xls/vsd…）由网关机 LibreOffice 转成
 *   PDF 后再用同一套 PDF 查看器渲染。
 */

export type PreviewKind =
  | 'pdf'
  | 'md'
  | 'text'
  | 'csv'
  | 'html'
  | 'image'
  | 'audio'
  | 'video'
  | 'mindmap'
  /** 需 LibreOffice 转 PDF（见网关 converter 服务） */
  | 'office'

/** 浏览器整文件拉取后渲染的类型（媒体走流地址、PDF 走 Range，不在此列） */
export type BlobPreviewKind = 'md' | 'text' | 'csv' | 'html' | 'mindmap'

/** 浏览器拉整文件解析的大小上限（超过则提示下载查看；30MiB） */
export const PREVIEW_BLOB_MAX_BYTES = 30 * 1024 * 1024

/** LibreOffice 转换源文件大小上限（80MiB；891MB 内存机器的安全线） */
export const PREVIEW_CONVERT_MAX_BYTES = 80 * 1024 * 1024

const EXT_OFFICE = new Set([
  // 演示
  'ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'odp',
  // 文档
  'doc', 'docx', 'docm', 'odt', 'rtf',
  // 表格（csv 走浏览器直渲）
  'xls', 'xlsx', 'xlsm', 'ods',
  // 绘图 / Visio（converter 镜像装 libvisio）
  'vsd', 'vsdx',
])

const EXT_MINDMAP = new Set(['xmind', 'mm', 'opml'])

const EXT_IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])
const EXT_AUDIO = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac'])
const EXT_VIDEO = new Set(['mp4', 'webm', 'ogv', 'm4v', 'mov'])
const EXT_HTML = new Set(['htm', 'html', 'xhtml'])
const EXT_CSV = new Set(['csv', 'tsv'])
const EXT_MD = new Set(['md', 'markdown', 'mdx'])
const EXT_TEXT = new Set([
  'txt', 'text', 'log', 'ini', 'conf', 'cfg', 'toml', 'env', 'gitignore',
  'json', 'jsonl', 'xml', 'yml', 'yaml', 'sql',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'css', 'scss', 'less',
  'py', 'rb', 'php', 'java', 'kt', 'swift',
  'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'go', 'rs',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'lua', 'pl', 'r', 'scala', 'clj', 'ex', 'exs', 'dart', 'vue', 'svelte',
  'dockerfile', 'makefile', 'license', 'readme',
])

export function fileExt(filename: string): string {
  const base = filename.split(/[\\/]/).pop() || filename
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** 按文件名推断预览类型；不支持返回 null */
export function previewKind(filename: string): PreviewKind | null {
  const ext = fileExt(filename)
  if (!ext) return null
  if (ext === 'pdf') return 'pdf'
  if (EXT_MD.has(ext)) return 'md'
  if (EXT_HTML.has(ext)) return 'html'
  if (EXT_CSV.has(ext)) return 'csv'
  if (EXT_MINDMAP.has(ext)) return 'mindmap'
  if (EXT_IMAGE.has(ext)) return 'image'
  if (EXT_AUDIO.has(ext)) return 'audio'
  if (EXT_VIDEO.has(ext)) return 'video'
  if (EXT_OFFICE.has(ext)) return 'office'
  if (EXT_TEXT.has(ext)) return 'text'
  return null
}

/** 浏览器直接渲染（无需服务端转换）的类型 */
export function isDirectPreviewKind(kind: PreviewKind | null): kind is Exclude<PreviewKind, 'office'> {
  return kind !== null && kind !== 'office'
}

/**
 * 是否允许进 LibreOffice 转换队列。
 * 仅 tg1 清单（网关可直接整流回源）、大小在线内的 office 附件。
 * mt1 / 旧 base64 / 超大文件不进队（前端不显示预览入口）。
 */
export function isConvertibleForPreview(args: {
  filename: string
  storageKey?: string | null
  sizeBytes: number
}): boolean {
  if (previewKind(args.filename) !== 'office') return false
  if (!args.storageKey?.startsWith('tg1:')) return false
  if (!Number.isFinite(args.sizeBytes) || args.sizeBytes <= 0) return false
  if (args.sizeBytes > PREVIEW_CONVERT_MAX_BYTES) return false
  return true
}

/** 预览按钮在前端的展示决策 */
export type PreviewUiState = 'ready' | 'pending' | 'failed' | 'none'

/**
 * @param kind       previewKind(filename)
 * @param previewState  DB 中的转换状态（null/undefined = 未入过队）
 * @param sizeBytes  文件大小（blob 类超大文件不显示）
 */
export function previewUiState(
  kind: PreviewKind | null,
  previewState: string | null | undefined,
  sizeBytes: number,
): PreviewUiState {
  if (!kind) return 'none'
  if (kind === 'office') {
    if (previewState === 'ready') return 'ready'
    if (previewState === 'pending' || previewState === 'processing') return 'pending'
    if (previewState === 'failed') return 'failed'
    return 'none'
  }
  if ((kind === 'md' || kind === 'text' || kind === 'csv' || kind === 'html' || kind === 'mindmap')
    && sizeBytes > PREVIEW_BLOB_MAX_BYTES) {
    return 'none'
  }
  return 'ready'
}
