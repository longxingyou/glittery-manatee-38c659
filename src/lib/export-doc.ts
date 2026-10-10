import { extractHeadingsFromHtml, renderMarkdown } from './markdown'
import { getPublicOrigin } from './server-env'
import type { PostData } from './utils'

/** 导出专用排版 CSS（系统字体栈，无外部依赖）。
 *  变量挂在 .export-body 而非 :root，避免注入站内导出页时污染全站主题变量；
 *  站内跟随站点 data-theme，独立 HTML 文件无该属性时回退 prefers-color-scheme。 */
export const EXPORT_CSS = `
.export-body{--text:#111;--bg:#fff;--muted:#555;--line:#ddd;--accent:#0d9488;--callout-bg:#f0fdfa;--callout-bd:#e5e7eb;--code-bg:#f6f8fa;}
@media (prefers-color-scheme:dark){.export-body{--text:#e5e7eb;--bg:#0b0f19;--muted:#9ca3af;--line:#2d3748;--accent:#2dd4bf;--callout-bg:#111827;--callout-bd:#374151;--code-bg:#111827;}}
:root[data-theme="dark"] .export-body{--text:#e5e7eb;--bg:#0b0f19;--muted:#9ca3af;--line:#2d3748;--accent:#2dd4bf;--callout-bg:#111827;--callout-bd:#374151;--code-bg:#111827;}
:root[data-theme="light"] .export-body{--text:#111;--bg:#fff;--muted:#555;--line:#ddd;--accent:#0d9488;--callout-bg:#f0fdfa;--callout-bd:#e5e7eb;--code-bg:#f6f8fa;}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
.export-body{max-width:780px;margin:0 auto;padding:24px 24px 80px;min-height:100vh;background:var(--bg);color:var(--text);font:16px/1.75 -apple-system,"PingFang SC","Microsoft YaHei",ui-sans-serif,system-ui,sans-serif;box-shadow:0 0 0 100vmax var(--bg);clip-path:inset(0 -100vmax);}
.export-header{border-bottom:1px solid var(--line);padding-bottom:18px;margin-bottom:24px}
.export-header h1{margin:0 0 8px;font-size:clamp(28px,5vw,44px);line-height:1.15;letter-spacing:-.03em}
.export-header p{margin:0 0 6px;color:var(--muted);font-size:15px}
.export-header .meta{display:flex;flex-wrap:wrap;gap:10px 18px;color:var(--muted);font-size:13px}
.export-toc{background:var(--callout-bg);border:1px solid var(--callout-bd);border-radius:10px;padding:14px 18px;margin:0 0 24px}
.export-toc h3{margin:0 0 10px;font-size:15px}
.export-toc ol{margin:0;padding:0 0 0 18px}
.export-toc li{margin:4px 0}
.export-toc a{color:var(--accent);text-decoration:none}
.export-toc a:hover{text-decoration:underline}
.export-toc .lv3{margin-left:16px}
.export-toc .lv4{margin-left:32px}
.export-footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
.markdown-body h2,.markdown-body h3,.markdown-body h4{scroll-margin-top:14px}
.markdown-body h2{font-size:26px;margin:32px 0 14px;border-bottom:1px solid var(--line);padding-bottom:6px}
.markdown-body h3{font-size:20px;margin:24px 0 10px}
.markdown-body h4{font-size:17px;margin:18px 0 8px}
.markdown-body p{margin:0 0 14px}
.markdown-body ul,.markdown-body ol{padding-left:22px;margin:0 0 14px}
.markdown-body li{margin:3px 0}
.markdown-body blockquote{margin:0 0 14px;padding:8px 14px;border-left:3px solid var(--accent);color:var(--muted);background:var(--callout-bg);border-radius:0 8px 8px 0}
.markdown-body pre{background:var(--code-bg);border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow-x:auto;font-size:13px;line-height:1.6}
.markdown-body code{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:.92em;background:var(--code-bg);padding:2px 5px;border-radius:5px}
.markdown-body pre code{padding:0;background:none}
.markdown-body table{width:100%;border-collapse:collapse;font-size:14px;margin:0 0 14px}
.markdown-body th,.markdown-body td{border:1px solid var(--line);padding:8px 10px;text-align:left}
.markdown-body th{background:var(--callout-bg)}
.markdown-body img{max-width:100%;height:auto;border-radius:8px}
.markdown-body a{color:var(--accent);text-decoration:underline}
.markdown-body hr{border:0;border-top:1px solid var(--line);margin:24px 0}
.callout{padding:12px 14px;border-radius:10px;margin:0 0 14px;border:1px solid var(--callout-bd);background:var(--callout-bg)}
.callout-title{display:flex;align-items:center;gap:8px;font-weight:700;margin-bottom:6px}
.callout-icon{width:16px;height:16px;flex:none}
.callout-content>:last-child{margin-bottom:0}
.footnotes-section{margin-top:24px;padding-top:12px;border-top:1px solid var(--line)}
.footnote-item{font-size:13px}
.footnote-back{margin-left:6px}
.footnotes-section ol{padding-left:20px}
.markdown-tag{display:inline-block;background:#eef2ff;color:#3730a3;border-radius:999px;padding:1px 8px;font-size:12px;margin:0 4px 4px 0}
.align-left{text-align:left}.align-center{text-align:center}.align-right{text-align:right}
@media print{
  .export-toolbar{display:none!important}
  body{background:#fff!important}
  .export-body{background:#fff!important;color:#000!important;box-shadow:none!important;clip-path:none!important;max-width:none;min-height:0;padding:0}
  a{color:inherit!important;text-decoration:underline!important}
  pre,code{white-space:pre-wrap;word-break:break-word}
  .markdown-body h2,.markdown-body h3,.markdown-body h4{break-after:avoid}
  pre,table,tr,blockquote,.callout{break-inside:avoid}
}
`

function escapeXml(str: string) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 后处理 renderMarkdown 产物，用于导出 */
export function buildExportBody(rawHtml: string, origin?: string): string {
  let html = rawHtml
  // 1) 站内相对路径（href="/x"、src='/x'）拼上源；绝对 URL、# 锚点、mailto: 等不动
  if (origin) {
    html = html.replace(/\b(href|src)=(["'])\//g, `$1=$2${origin}/`)
  }
  // 2) 折叠 callout 全部展开
  html = html.replace(/<details\b/g, '<details open')
  // 3) 剔除标题尾部自指锚点
  html = html.replace(/<a[^>]*class="anchor"[^>]*>[\s\S]*?<\/a>/g, '')
  return html
}

export interface StandaloneHtmlModel {
  title: string
  summary: string
  date: string
  categories: string
  bodyHtml: string
  origin: string
  url: string
}

export function buildStandaloneHtml(model: StandaloneHtmlModel): string {
  const headings = extractHeadingsFromHtml(model.bodyHtml)
  const tocHtml = headings.length >= 2
    ? `<nav class="export-toc" aria-label="目录">
      <h3>目录</h3>
      <ol>${headings.map(h => `<li class="lv${h.level}"><a href="#${escapeXml(h.id)}">${escapeXml(h.text || '…')}</a></li>`).join('')}</ol>
    </nav>`
    : ''
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeXml(model.title)}</title>
<style>${EXPORT_CSS}</style>
</head>
<body>
<div class="export-body">
<header class="export-header">
<h1>${escapeXml(model.title)}</h1>
<p>${escapeXml(model.summary)}</p>
<div class="meta">
  <span>${escapeXml(model.date)}</span>
  <span>${escapeXml(model.categories)}</span>
</div>
</header>
${tocHtml}
<article class="markdown-body">
${model.bodyHtml}
</article>
<footer class="export-footer">
  来源：<a href="${escapeXml(model.url)}">${escapeXml(model.url)}</a>
</footer>
</div>
</body>
</html>`
}

/** CRC32 表（用于 ZIP） */
function makeCrc32Table(): Uint32Array {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[i] = c >>> 0
  }
  return t
}
const CRC32_TABLE = makeCrc32Table()
function crc32(buf: Uint8Array): number {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = (CRC32_TABLE[(c ^ buf[i]) & 0xFF]! ^ (c >>> 1)) >>> 0
  return (c ^ 0xFFFFFFFF) >>> 0
}
function dword(n: number) {
  const a = new Uint8Array(4)
  a[0] = n & 0xFF; a[1] = (n >>> 8) & 0xFF; a[2] = (n >>> 16) & 0xFF; a[3] = (n >>> 24) & 0xFF
  return a
}
function word(n: number) {
  const a = new Uint8Array(2)
  a[0] = n & 0xFF; a[1] = (n >>> 8) & 0xFF
  return a
}

interface ZipEntry {
  name: Uint8Array
  data: Uint8Array
  crc: number
  localHeader: Uint8Array
  centralDir: Uint8Array
}

function makeZipEntry(name: string, data: Uint8Array, localOffset: number): ZipEntry {
  const nameBytes = new TextEncoder().encode(name)
  const crc = crc32(data)
  const extra = new Uint8Array(0)
  const local = new Uint8Array(30 + nameBytes.length)
  let p = 0
  const w = (a: Uint8Array) => { local.set(a, p); p += a.length }
  w(new Uint8Array([0x50, 0x4B, 0x03, 0x04])) // local file header sig
  w(new Uint8Array([20, 0])) // version needed
  w(new Uint8Array([0, 0])) // flags
  w(new Uint8Array([0, 0])) // compression = store
  w(new Uint8Array([0, 0])) // time
  w(new Uint8Array([0, 0])) // date
  w(dword(crc))
  w(dword(data.length))
  w(dword(data.length))
  w(word(nameBytes.length))
  w(word(extra.length))
  w(nameBytes)

  const central = new Uint8Array(46 + nameBytes.length)
  p = 0
  const w2 = (a: Uint8Array) => { central.set(a, p); p += a.length }
  w2(new Uint8Array([0x50, 0x4B, 0x01, 0x02])) // central dir sig
  w2(new Uint8Array([20, 0])) // version made by
  w2(new Uint8Array([20, 0])) // version needed
  w2(new Uint8Array([0, 0])) // flags
  w2(new Uint8Array([0, 0])) // compression
  w2(new Uint8Array([0, 0])) // time
  w2(new Uint8Array([0, 0])) // date
  w2(dword(crc))
  w2(dword(data.length))
  w2(dword(data.length))
  w2(word(nameBytes.length))
  w2(word(extra.length))
  w2(word(0)) // comment len
  w2(word(0)) // disk
  w2(word(0)) // internal attrs
  w2(dword(0)) // external attrs
  w2(dword(localOffset))
  w2(nameBytes)

  return { name: nameBytes, data, crc, localHeader: local, centralDir: central }
}

/** 纯 TS 生成 .docx（Word/WPS 打开即转换 altChunk HTML） */
export function buildDocx(html: string, title: string): Uint8Array<ArrayBuffer> {
  const utf8 = new TextEncoder()
  const htmlDoc = utf8.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${escapeXml(title)}</title>
<style>${EXPORT_CSS}</style>
</head><body><div class="export-body"><article class="markdown-body">${html}</article></div></body></html>`)
  const documentXml = utf8.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:altChunk r:id="htmlDoc"/>
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`)
  // 两个 .rels 职责不同：包根 _rels/.rels 指向主文档；
  // word/_rels/document.xml.rels 指向 altChunk 的 HTML 子文档（Target 相对 word/ 目录）
  const rootRels = utf8.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
  const docRels = utf8.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="htmlDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="htmlDoc.html"/>
</Relationships>`)
  const ct = utf8.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="html" ContentType="text/html"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`)

  const parts: Array<{ name: string; data: Uint8Array }> = [
    { name: '[Content_Types].xml', data: ct },
    { name: '_rels/.rels', data: rootRels },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/_rels/document.xml.rels', data: docRels },
    { name: 'word/htmlDoc.html', data: htmlDoc },
  ]

  let offset = 0
  const entries: ZipEntry[] = []
  for (const p of parts) {
    const e = makeZipEntry(p.name, p.data, offset)
    entries.push(e)
    offset += e.localHeader.length + p.data.length
  }

  const centralSize = entries.reduce((s, e) => s + e.centralDir.length, 0)
  const total = offset + centralSize + 22
  const out = new Uint8Array(total)
  let p = 0
  for (const e of entries) {
    out.set(e.localHeader, p); p += e.localHeader.length
    out.set(e.data, p); p += e.data.length
  }
  const centralStart = p
  for (const e of entries) {
    out.set(e.centralDir, p); p += e.centralDir.length
  }
  const eocd = new Uint8Array(22)
  p = 0
  const w3 = (a: Uint8Array) => { eocd.set(a, p); p += a.length }
  w3(new Uint8Array([0x50, 0x4B, 0x05, 0x06]))
  w3(new Uint8Array([0, 0]))
  w3(new Uint8Array([0, 0]))
  w3(new Uint8Array([entries.length & 0xFF, (entries.length >>> 8) & 0xFF]))
  w3(new Uint8Array([entries.length & 0xFF, (entries.length >>> 8) & 0xFF]))
  w3(dword(centralSize))
  w3(dword(centralStart))
  w3(new Uint8Array([0, 0]))
  out.set(eocd, p)
  return out
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.setTimeout(() => URL.revokeObjectURL(url), 3000)
}

export function downloadMarkdown(post: PostData) {
  const blob = new Blob([post.content], { type: 'text/markdown;charset=utf-8' })
  saveBlob(blob, `${post.slug}.md`)
}

export function downloadHtml(post: PostData, renderedContainer?: HTMLElement | null) {
  const origin = getPublicOrigin()
  const bodyHtml = buildExportBody(renderedContainer ? renderedContainer.innerHTML : renderMarkdown(post.content), origin)
  const html = buildStandaloneHtml({
    title: post.title,
    summary: post.summary,
    date: post.date,
    categories: post.categories.join(' · '),
    bodyHtml,
    origin,
    url: `${origin}/posts/${post.slug}`,
  })
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  saveBlob(blob, `${post.slug}.html`)
}

export function downloadDocx(post: PostData, renderedContainer?: HTMLElement | null) {
  try {
    const origin = getPublicOrigin()
    const bodyHtml = buildExportBody(renderedContainer ? renderedContainer.innerHTML : renderMarkdown(post.content), origin)
    const raw = buildDocx(bodyHtml, post.title)
    const blob = new Blob([raw], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
    saveBlob(blob, `${post.slug}.docx`)
  } catch (e) {
    console.error('downloadDocx error:', e)
    throw e
  }
}
