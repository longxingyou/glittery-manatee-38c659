import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { unzipSync } from 'fflate'
import { ArrowLeft, ChevronLeft, ChevronRight, ExternalLink, FileDown, Loader2, Lock, RefreshCw } from 'lucide-react'
import { attachmentPreviewFn, attachmentPreviewRetryFn, AttachmentDownloadButton, type AttachmentPreviewInfo } from '@/components/public-fns'
import { useT } from '@/lib/i18n'
import { onAuthChange } from '@/lib/auth-client'
import { renderMarkdown } from '@/lib/markdown'
import { useMermaidLazy } from '@/lib/use-mermaid'
import { formatBytes } from '@/lib/utils'
import { fileExt, PREVIEW_CONVERT_MAX_BYTES, type PreviewKind } from '@/lib/preview'
// 西里尔文本专用：Inter Variable 自带 cyrillic 子集（@font-face 按 unicode-range 声明，
// 浏览器只在出现西里尔字符时下载分片）；预览栈中置于 prose 字体之前，
// 让俄语字母不吃中文字体里的西里尔字形（错位/全角化）
import '@fontsource-variable/inter'
// 仅类型引用，不产生运行时依赖（pdfjs 本体在 PdfJsView 里动态 import）
import type { PDFDocumentProxy } from 'pdfjs-dist'
// 仅类型引用（djvu-rs 本体在 DjvuView 里动态 import）
import type { WasmDocument } from 'djvu-rs'

export const Route = createFileRoute('/preview/$id')({
  validateSearch: z.object({
    token: z.string().max(1024).optional(),
    // PDF 渲染器强制覆盖：js=PDF.js canvas 兜底（调试用），native=iframe 原生查看器。
    // 缺省按 UA 判定（Android 走 js，其余 native）。
    renderer: z.enum(['js', 'native']).optional(),
  }),
  loaderDeps: ({ search }) => ({ token: search.token }),
  loader: async ({ params, deps }): Promise<AttachmentPreviewInfo> => {
    const id = Number(params.id)
    if (!Number.isInteger(id) || id <= 0) return { found: false }
    return attachmentPreviewFn({ data: { id, token: deps.token } })
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: loaderData?.filename ? `预览 · ${loaderData.filename}` : '附件预览' },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
  }),
  component: PreviewPage,
})

/** 把任意节点转成文本（Freeplane richcontent 时剥标签） */
function nodeText(node: Element): string {
  const direct = node.getAttribute('TEXT')
  if (direct && direct.trim()) return direct
  const rich = node.querySelector(':scope > richcontent[type="NODE"]') || node.querySelector('richcontent')
  if (rich) return (rich.textContent || '').replace(/\s+/g, ' ').trim()
  return ''
}

type MindNode = { title: string; note?: string; children: MindNode[] }

// ── 俄语重音渲染 ──
// 「元音 + U+0301 组合锐音符」在大量字体（Georgia / 中文字体内的西里尔字形等）
// 下定位错位、遮挡相邻字母。JS 把组合符剥掉，改由 CSS（.ru-stress::after）按
// 字形精确绘制锐音符；大写字母重音位置更高（.cap）。
const RU_STRESS_RE = /([АЕИОУЫЭЮЯаеиоуыэюя])\u0301/g
const RU_CAP_RE = /[АЕИОУЫЭЮЯ]/

/** 纯文本 → React 片段：重音元音替换为 CSS 绘制的 span（树/列表视图用） */
function ruStressNodes(text: string): ReactNode {
  if (!text.includes('\u0301')) return text
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(RU_STRESS_RE)) {
    const i = m.index!
    if (i > last) out.push(text.slice(last, i))
    const ch = m[1]!
    out.push(<span key={out.length} className={RU_CAP_RE.test(ch) ? 'ru-stress cap' : 'ru-stress'}>{ch}</span>)
    last = i + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** 文本 → HTML（markmap 节点内容按原始 HTML 注入，先转义再加重音） */
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function ruStressHtml(s: string): string {
  return s.replace(RU_STRESS_RE, (_, ch: string) =>
    `<span class="ru-stress${RU_CAP_RE.test(ch) ? ' cap' : ''}">${ch}</span>`)
}

/** Markdown 渲染结果：只在标签外、pre/code 外的文本上加重音（代码/公式/mermaid 源不动） */
function ruStressOutsideTags(html: string): string {
  return html
    .split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/gi)
    .map((part, i) => {
      if (i % 2 === 1) return part
      return part.split(/(<[^>]+>)/g).map((s, j) => (j % 2 === 1 ? s : ruStressHtml(s))).join('')
    })
    .join('')
}

/** FreeMind/Freeplane .mm：<node TEXT> 递归 */
function parseMm(xml: string): MindNode | null {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) return null
  const root = doc.querySelector('map > node')
  if (!root) return null
  const walk = (el: Element): MindNode => ({
    title: nodeText(el) || '（无标题）',
    note: el.querySelector(':scope > richcontent[type="NOTE"]')?.textContent?.trim() || undefined,
    children: Array.from(el.children).filter((c) => c.tagName === 'node').map(walk),
  })
  return walk(root)
}

/** OPML：<outline text> 递归 */
function parseOpml(xml: string): MindNode | null {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) return null
  const first = doc.querySelector('opml > body > outline, body > outline')
  if (!first) return null
  const walk = (el: Element): MindNode => ({
    title: el.getAttribute('text') || el.getAttribute('_text') || el.getAttribute('title') || '（无标题）',
    note: (el.getAttribute('_note') || '').trim() || undefined,
    children: Array.from(el.children).filter((c) => c.tagName === 'outline').map(walk),
  })
  return walk(first)
}

/** XMind：zip 内 content.json（新版）或 content.xml（旧版） */
function parseXmind(buf: ArrayBuffer): MindNode | null {
  let files: Record<string, Uint8Array> = {}
  try {
    files = unzipSync(new Uint8Array(buf))
  } catch {
    return null
  }
  const dec = (name: string) => {
    const hit = Object.keys(files).find((k) => k.endsWith(name))
    if (!hit) return ''
    return new TextDecoder('utf-8').decode(files[hit])
  }
  const jsonText = dec('content.json')
  if (jsonText) {
    try {
      const sheets = JSON.parse(jsonText) as Array<{ rootTopic?: XTopic }>
      const root = sheets.find((s) => s.rootTopic)?.rootTopic
      if (root) return walkXTopic(root)
    } catch { /* 落到 XML 旧格式 */ }
  }
  const xmlText = dec('content.xml')
  if (xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
    const root = doc.querySelector('sheet topic, topic')
    if (root) {
      const walk = (el: Element): MindNode => ({
        title: el.querySelector(':scope > title')?.textContent?.trim() || '（无标题）',
        children: Array.from(el.querySelectorAll(':scope > children > topics > topic')).map(walk),
      })
      return walk(root)
    }
  }
  return null
}

interface XTopic {
  title?: string
  notes?: { plain?: { content?: string } }
  children?: { attached?: XTopic[] }
}
function walkXTopic(t: XTopic): MindNode {
  return {
    title: t.title || '（无标题）',
    note: t.notes?.plain?.content?.trim() || undefined,
    children: (t.children?.attached || []).map(walkXTopic),
  }
}

function MindTree({ node, depth }: { node: MindNode; depth: number }) {
  return (
    <ul className={`pv-tree depth-${Math.min(depth, 8)}`}>
      <li>
        <details open={depth < 2}>
          <summary>
            <span className="pv-tree-node">{ruStressNodes(node.title)}</span>
            {node.note && <em className="pv-tree-note">{ruStressNodes(node.note)}</em>}
          </summary>
          {node.children.length > 0 && (
            <ul>
              {node.children.map((c, i) => (
                <li key={i}><MindTree node={c} depth={depth + 1} /></li>
              ))}
            </ul>
          )}
        </details>
      </li>
    </ul>
  )
}

/** 简易但正确的 CSV/TSV 解析（引号、转义、字段内换行） */
function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === sep) {
      row.push(field); field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      rows.push(row); row = []
    } else field += ch
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

/** 大表截断：五千行往上 DOM 渲染明显变重，先展示头部 + 提示（完整内容可下载） */
const CSV_MAX_ROWS = 5000

function CsvTable({ text, sep }: { text: string; sep: string }) {
  const t = useT()
  const rows = useMemo(() => parseDelimited(text, sep), [text, sep])
  if (rows.length === 0) return <p className="pv-empty">（空表格）</p>
  const [head, ...body] = rows
  const truncated = body.length > CSV_MAX_ROWS
  const shown = truncated ? body.slice(0, CSV_MAX_ROWS) : body
  return (
    <div className="pv-table-wrap">
      {truncated && (
        <div className="pv-table-note">{t('preview.csv.truncated', { shown: CSV_MAX_ROWS, total: body.length })}</div>
      )}
      <table className="pv-table">
        <thead><tr>{head!.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
        <tbody>
          {shown.map((r, ri) => (
            <tr key={ri}>{head!.map((_, ci) => <td key={ci}>{r[ci] ?? ''}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 跨域拉文本（网关 CORS 已放行站点源）；有 Content-Length 时经 onProgress 上报 0~1 进度 */
async function fetchText(url: string, onProgress?: (p: number) => void): Promise<string> {
  // 同源请求（/api/comments 等）需要带 cookie 才能通过登录门禁；
  // 跨域网关直链（gw.../dl）带签名 token，same-origin 对跨域等同于
  // omit 不发 cookie，所以这里统一 same-origin 是安全的。
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  if (!res.body || !onProgress) return res.text()
  const total = Number(res.headers.get('Content-Length') || 0)
  if (!(total > 0)) return res.text()
  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let received = 0
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value!.byteLength
    out += decoder.decode(value!, { stream: true })
    onProgress(Math.min(1, received / total))
  }
  out += decoder.decode()
  return out
}

/** 跨域拉二进制（DjVu / 电子书整文件解析）；有 Content-Length 时上报 0~1 进度 */
async function fetchBytes(url: string, onProgress?: (p: number) => void): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  if (!res.body || !onProgress) return new Uint8Array(await res.arrayBuffer())
  const total = Number(res.headers.get('Content-Length') || 0)
  if (!(total > 0)) return new Uint8Array(await res.arrayBuffer())
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value!)
    received += value!.byteLength
    onProgress(Math.min(1, received / total))
  }
  const out = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** 细进度条：p 为 null（无 Content-Length）时跑不定态动画 */
function ProgressLine({ p }: { p: number | null }) {
  return (
    <div className="pv-progress" aria-hidden="true">
      <div
        className="pv-progress-bar"
        style={p == null ? undefined : { width: `${Math.round(p * 100)}%` }}
        data-indeterminate={p == null ? '' : undefined}
      />
    </div>
  )
}

function MarkdownView({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => ruStressOutsideTags(renderMarkdown(text)), [text])
  useMermaidLazy(ref)
  // SPA 动态渲染后浏览器已错过 #hash 滚动时机，手动补齐锚点跳转
  useEffect(() => {
    const hash = decodeURIComponent(window.location.hash.slice(1))
    if (!hash) return
    const el = ref.current?.querySelector(`[id="${CSS.escape(hash)}"]`)
    if (el) el.scrollIntoView({ block: 'start' })
  }, [html])
  return <article ref={ref} className="markdown-body pv-md" dangerouslySetInnerHTML={{ __html: html }} />
}

type MmData = { content: string; children: MmData[] }
function toMmData(n: MindNode): MmData {
  // markmap 把 content 作为原始 HTML 注入 foreignObject：先转义再绘制重音
  return { content: ruStressHtml(escHtml(n.title)), children: n.children.map(toMmData) }
}

/** markmap 画布：动态 import（含 d3，不进主包）；加载/布局失败回调父级降级到列表视图 */
function MindmapCanvas({ tree, onFail }: { tree: MindNode; onFail: () => void }) {
  const svgRef = useRef<SVGSVGElement>(null)
  useEffect(() => {
    let alive = true
    let mm: { destroy?: () => void; fit?: () => void } | null = null
    ;(async () => {
      try {
        const { Markmap } = await import('markmap-view')
        const svg = svgRef.current
        if (!svg || !alive) return
        mm = Markmap.create(svg, { autoFit: true, duration: 200 }, toMmData(tree))
        void mm.fit?.()
      } catch {
        if (alive) onFail()
      }
    })()
    return () => {
      alive = false
      try { mm?.destroy?.() } catch { /* 已销毁 */ }
      while (svgRef.current?.firstChild) svgRef.current.removeChild(svgRef.current.firstChild)
    }
  }, [tree, onFail])
  return <svg ref={svgRef} className="pv-mind-svg" />
}

function MindmapView({ url, filename }: { url: string; filename: string }) {
  const [state, setState] = useState<{ loading: boolean; error: string; tree: MindNode | null }>({ loading: true, error: '', tree: null })
  const [view, setView] = useState<'map' | 'tree'>('map')
  const failToTree = useCallback(() => setView('tree'), [])
  useEffect(() => {
    let alive = true
    setState({ loading: true, error: '', tree: null })
    ;(async () => {
      try {
        const ext = fileExt(filename)
        if (ext === 'xmind') {
          const res = await fetch(url, { credentials: 'same-origin' })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const tree = parseXmind(await res.arrayBuffer())
          if (!tree) throw new Error('parse')
          if (alive) setState({ loading: false, error: '', tree })
        } else {
          const text = await fetchText(url)
          const tree = ext === 'opml' ? parseOpml(text) : parseMm(text)
          if (!tree) throw new Error('parse')
          if (alive) setState({ loading: false, error: '', tree })
        }
      } catch {
        if (alive) setState({ loading: false, error: 'parse-fail', tree: null })
      }
    })()
    return () => { alive = false }
  }, [url, filename])
  const t = useT()
  if (state.loading) return <FetchHint label={t('preview.loading')} />
  if (state.error || !state.tree) return <p className="pv-empty">{t('preview.mindmap.fail')}</p>
  return (
    <div className="pv-mind-wrap">
      <div className="pv-mind-toggle no-print">
        <button className={`row-action${view === 'map' ? ' primary' : ''}`} onClick={() => setView('map')}>{t('preview.mind.map')}</button>
        <button className={`row-action${view === 'tree' ? ' primary' : ''}`} onClick={() => setView('tree')}>{t('preview.mind.tree')}</button>
      </div>
      {view === 'map'
        ? <MindmapCanvas tree={state.tree} onFail={failToTree} />
        : <div className="pv-tree-wrap"><MindTree node={state.tree} depth={0} /></div>}
    </div>
  )
}

/** 带行号的文本视图：gutter sticky 左侧，横向滚动时行号固定（行号模式不换行） */
function CodeWithLines({ text }: { text: string }) {
  const lines = useMemo(() => text.split('\n'), [text])
  return (
    <div className="pv-code-wrap">
      <pre className="pv-code-gutter" aria-hidden="true">{Array.from({ length: lines.length }, (_, i) => `${i + 1}\n`).join('')}</pre>
      <pre className="pv-code-line">{text}</pre>
    </div>
  )
}

function TextBlobView({ url, kind, filename }: { url: string; kind: PreviewKind; filename: string }) {
  const t = useT()
  const [state, setState] = useState<{ loading: boolean; error: string; text: string; progress: number | null }>(
    { loading: true, error: '', text: '', progress: null },
  )
  useEffect(() => {
    let alive = true
    setState({ loading: true, error: '', text: '', progress: null })
    fetchText(url, (p) => { if (alive) setState((s) => ({ ...s, progress: p })) })
      .then((text) => { if (alive) setState({ loading: false, error: '', text, progress: 1 }) })
      .catch(() => { if (alive) setState({ loading: false, error: 'fetch-fail', text: '', progress: null }) })
    return () => { alive = false }
  }, [url])
  if (state.loading) {
    return (
      <div className="pv-fetch-col">
        <ProgressLine p={state.progress} />
        <FetchHint label={t('preview.loading')} hint={state.progress == null ? undefined : `${Math.round(state.progress * 100)}%`} />
      </div>
    )
  }
  if (state.error) return <p className="pv-empty">{t('preview.fetch.fail')}</p>
  const MAX = 2_000_000
  const text = state.text
  if (kind === 'md') return <MarkdownView text={text} />
  if (kind === 'csv') return <CsvTable text={text} sep={fileExt(filename) === 'tsv' ? '\t' : ','} />
  // 行号视图仅用于小文件（≤1MiB 且 ≤1 万行，再大 DOM 太重）；其余维持纯 pre + 截断
  if (text.length <= 1_048_576 && text.split('\n').length <= 10_000) return <CodeWithLines text={text} />
  return (
    <pre className="pv-code">{text.length > MAX ? `${text.slice(0, MAX)}\n\n…${t('preview.text.truncated')}` : text}</pre>
  )
}

/** srcDoc 沙盒文档运行在不透明源，相对路径默认解析不到文件所在目录——注入 <base> 修相对引用 */
function withBaseHref(html: string, url: string): string {
  const base = `<base href="${new URL('.', url).href}">`
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${base}`)
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}\n<head>${base}</head>`)
  return `${base}\n${html}`
}

function HtmlView({ url }: { url: string }) {
  const t = useT()
  const [state, setState] = useState<{ loading: boolean; error: boolean; html: string; progress: number | null }>(
    { loading: true, error: false, html: '', progress: null },
  )
  useEffect(() => {
    let alive = true
    fetchText(url, (p) => { if (alive) setState((s) => ({ ...s, progress: p })) })
      .then((html) => { if (alive) setState({ loading: false, error: false, html, progress: 1 }) })
      .catch(() => { if (alive) setState({ loading: false, error: true, html: '', progress: null }) })
    return () => { alive = false }
  }, [url])
  const doc = useMemo(() => (state.html ? withBaseHref(state.html, url) : ''), [state.html, url])
  if (state.loading) {
    return (
      <div className="pv-fetch-col">
        <ProgressLine p={state.progress} />
        <FetchHint label={t('preview.loading')} hint={state.progress == null ? undefined : `${Math.round(state.progress * 100)}%`} />
      </div>
    )
  }
  if (state.error) return <p className="pv-empty">{t('preview.fetch.fail')}</p>
  // 无 allow-same-origin：脚本在不透明源里运行，拿不到父页 cookie/storage
  return <iframe className="pv-html" title="html preview" srcDoc={doc} sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads" referrerPolicy="no-referrer" />
}

/** PDF.js 单页渲染：进入视口附近才绘制，绘制后 page.cleanup() 释放内存；
 *  占位高度用第 1 页宽高比估算（个别页尺寸不同时渲染完成后自然校正） */
function PdfJsPage({ doc, num, pageWidth, ratio, active }: {
  doc: PDFDocumentProxy
  num: number
  pageWidth: number
  ratio: number | null
  active: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [rendered, setRendered] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!active || rendered || failed || pageWidth <= 0) return
    let alive = true
    ;(async () => {
      try {
        const page = await doc.getPage(num)
        if (!alive) { page.cleanup(); return }
        const base = page.getViewport({ scale: 1 })
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        const viewport = page.getViewport({ scale: (pageWidth * dpr) / base.width })
        const canvas = canvasRef.current
        if (!canvas) { page.cleanup(); return }
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        // pdfjs v4 API：canvasContext + viewport（v6 才支持直接传 canvas）
        await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise
        if (!alive) return
        setRendered(true)
        page.cleanup()
      } catch {
        if (alive) setFailed(true)
      }
    })()
    return () => { alive = false }
  }, [doc, num, pageWidth, active, rendered, failed])
  return (
    <div
      className="pv-pdfjs-page"
      data-page={num}
      style={!rendered && !failed ? { aspectRatio: ratio ? String(ratio) : undefined, minHeight: 160 } : undefined}
    >
      {!rendered && <span className="pv-pdfjs-pagehint">{failed ? '⚠' : num}</span>}
      <canvas ref={canvasRef} style={{ display: rendered ? 'block' : 'none' }} />
    </div>
  )
}

/** PDF.js 兜底视图：Android Chrome / 微信 X5 的 iframe 不内嵌 PDF（只弹下载）。
 *  动态 import 不进主包；worker 为同源 ?url 资产；getDocument({ url }) 自动
 *  Range 分段流式拉取（网关支持 Accept-Ranges/206），GB 级文件按需取数。 */
function PdfJsView({ url, filename }: { url: string; filename: string }) {
  const t = useT()
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [progress, setProgress] = useState(0)
  const [width, setWidth] = useState(0)
  const [ratio, setRatio] = useState<number | null>(null)
  const [visible, setVisible] = useState<Set<number>>(() => new Set([1]))
  const pagesRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    let task: ReturnType<typeof import('pdfjs-dist').getDocument> | null = null
    ;(async () => {
      try {
        const [pdfjs, workerMod] = await Promise.all([
          import('pdfjs-dist'),
          import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
        ])
        // 动态 import 是异步的：cleanup 可能在 import 落地前已执行
        // （dev StrictMode 双挂载），此时必须直接退出，避免留下永不销毁的
        // 加载任务——它会持续顺序拉取整文件并与新实例抢带宽。
        if (cancelled) return
        pdfjs.GlobalWorkerOptions.workerSrc = workerMod.default
        task = pdfjs.getDocument({
          url,
          withCredentials: false,
          // GB 级附件：纯 Range 按需取数，不做整文件顺序预取，
          // 首屏只需文件头 + xref + 当前页对象（省手机流量/内存）。
          disableStream: true,
          disableAutoFetch: true,
        })
        task.onProgress = ({ loaded: n, total }: { loaded: number; total: number }) => {
          if (!cancelled && total > 0) setProgress(Math.min(1, n / total))
        }
        const loaded = await task.promise
        if (cancelled) { void task!.destroy(); return }
        setDoc(loaded)
        setPhase('ready')
      } catch {
        if (!cancelled) setPhase('error')
      }
    })()
    return () => {
      cancelled = true
      // 销毁入口在 loadingTask 上（会连带终止 worker 与已加载文档，v4/v6 一致）
      if (task) void task.destroy()
    }
  }, [url])

  // 容器宽度 → 页面渲染像素宽（页面列 max-width 860，由 CSS 控制）
  useEffect(() => {
    const el = pagesRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) setWidth(Math.min(860, Math.round(w)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [phase])

  // 第 1 页宽高比 → 其余页占位高度估算
  useEffect(() => {
    if (!doc) return
    let alive = true
    ;(async () => {
      try {
        const p1 = await doc.getPage(1)
        const v = p1.getViewport({ scale: 1 })
        if (alive) setRatio(v.width / v.height)
        p1.cleanup()
      } catch { /* 占位退化为 minHeight */ }
    })()
    return () => { alive = false }
  }, [doc])

  // 单一 IntersectionObserver 管全部页占位（几千页也只有 1 个 observer）
  useEffect(() => {
    const root = pagesRef.current
    if (!root || phase !== 'ready') return
    const io = new IntersectionObserver((entries) => {
      const hit = entries
        .filter((e) => e.isIntersecting)
        .map((e) => Number((e.target as HTMLElement).dataset.page))
        .filter((n) => n > 0)
      if (hit.length === 0) return
      setVisible((prev) => {
        const next = new Set(prev)
        let changed = false
        for (const n of hit) if (!next.has(n)) { next.add(n); changed = true }
        return changed ? next : prev
      })
    }, { rootMargin: '1000px 0px' })
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-page]'))) io.observe(el)
    return () => io.disconnect()
  }, [phase, doc])

  const pages = doc ? Array.from({ length: doc.numPages }, (_, i) => i + 1) : []
  return (
    <div className="pv-pdf-wrap">
      <div className="pv-pdf-bar">
        <a href={url} target="_blank" rel="noreferrer" className="pv-open-ext">
          <ExternalLink size={13} />{t('preview.pdf.newtab')}
        </a>
        <span className="pv-pdf-name">{filename}</span>
        {phase === 'loading' && progress > 0 && <span className="pv-pdf-progress">{Math.round(progress * 100)}%</span>}
      </div>
      {phase === 'loading' && <FetchHint label={t('preview.loading')} />}
      {phase === 'error' && <p className="pv-empty">{t('preview.fetch.fail')}</p>}
      {phase === 'ready' && doc && (
        <div className="pv-pdfjs-pages" ref={pagesRef}>
          {pages.map((n) => (
            <PdfJsPage key={n} doc={doc} num={n} pageWidth={width} ratio={ratio} active={visible.has(n)} />
          ))}
        </div>
      )}
    </div>
  )
}

function PdfView({ url, filename, forcedRenderer }: { url: string; filename: string; forcedRenderer?: 'js' | 'native' }) {
  const t = useT()
  // 渲染器选择：默认 PDF.js（Range 按需拉取，大 PDF 首屏秒出，全平台一致）；
  // 原生 iframe 仅在 ?renderer=native 强制覆盖或浏览器明确不支持 canvas 时使用。
  // 为什么不全 native：桌面 Chrome/Firefox 原生 PDF viewer 会一次性下完整文件才渲染，
  // 对 20MB+ PDF 首屏等待比 PDF.js Range 按需慢得多；手机端原生 iframe 还可能弹下载。
  const [mode, setMode] = useState<'js' | 'native'>(forcedRenderer ?? 'js')
  useEffect(() => {
    if (forcedRenderer) { setMode(forcedRenderer); return }
    setMode('js')
  }, [forcedRenderer])

  // 网关直链（绝对 http(s) URL）已以 application/pdf + Range 提供：
  // 直接交给浏览器原生查看器，既不走 CORS fetch，也能流式翻看数百 MB 的大 PDF。
  const isDirect = /^https?:\/\//.test(url)
  // 网关 /dl 默认 attachment（供下载按钮）；页内/新标签查看加 inline=1，
  // 否则浏览器在 iframe 里直接弹下载而不是渲染。
  const viewUrl = useMemo(() => (isDirect ? `${url}${url.includes('?') ? '&' : '?'}inline=1` : url), [url, isDirect])
  const [state, setState] = useState<{ loading: boolean; error: boolean; blobUrl: string }>(
    { loading: !isDirect, error: false, blobUrl: '' },
  )
  useEffect(() => {
    if (isDirect) return
    let alive = true
    let created = ''
    setState({ loading: true, error: false, blobUrl: '' })
    fetch(url, { credentials: 'omit' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const blob = await res.blob()
        if (!alive) return
        const pdfBlob = blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' })
        created = URL.createObjectURL(pdfBlob)
        setState({ loading: false, error: false, blobUrl: created })
      })
      .catch(() => { if (alive) setState({ loading: false, error: true, blobUrl: '' }) })
    return () => { alive = false; if (created) URL.revokeObjectURL(created) }
  }, [url, isDirect])

  if (mode === 'js') return <PdfJsView url={viewUrl} filename={filename} />
  const frameSrc = isDirect ? viewUrl : state.blobUrl
  return (
    <div className="pv-pdf-wrap">
      <div className="pv-pdf-bar">
        <a href={viewUrl} target="_blank" rel="noreferrer" className="pv-open-ext">
          <ExternalLink size={13} />{t('preview.pdf.newtab')}
        </a>
        <span className="pv-pdf-name">{filename}</span>
      </div>
      {state.loading && <FetchHint label={t('preview.loading')} />}
      {state.error && <p className="pv-empty">{t('preview.fetch.fail')}</p>}
      {frameSrc && <iframe className="pv-pdf" title={filename} src={frameSrc} />}
    </div>
  )
}

function FetchHint({ label, hint }: { label: string; hint?: string }) {
  return <div className="pv-fetch-hint"><Loader2 size={18} className="spin" /><span>{label}</span>{hint && <span className="pv-fetch-pct">{hint}</span>}</div>
}

/* ── DjVu：djvu-rs WASM（动态 import，不进主包）──
 * 单页翻页 + 按容器宽度选 dpi，避免几百页同时进 canvas 撑爆内存。 */
function DjvuView({ url, filename, fallback }: { url: string; filename: string; fallback: ReactNode }) {
  const t = useT()
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [progress, setProgress] = useState<number | null>(null)
  const [doc, setDoc] = useState<WasmDocument | null>(null)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [width, setWidth] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let alive = true
    setPhase('loading'); setProgress(null); setDoc(null); setTotal(0); setPage(0)
    ;(async () => {
      try {
        const bytes = await fetchBytes(url, (p) => { if (alive) setProgress(p) })
        if (!alive) return
        const djvu = await import('djvu-rs')
        // 默认导出才是 wasm-bindgen 的 init（按 SIMD 支持自动选 wasm 变体）
        await djvu.default()
        if (!alive) return
        const parsed = djvu.WasmDocument.from_bytes(bytes)
        if (!alive) { parsed.free(); return }
        setTotal(parsed.page_count())
        setDoc(parsed)
        setPhase('ready')
      } catch (err) {
        console.error('[preview] djvu failed', err)
        if (alive) setPhase('error')
      }
    })()
    return () => { alive = false }
  }, [url])

  // 文档释放（换文件 / 卸载）
  useEffect(() => () => { try { doc?.free() } catch { /* 已释放 */ } }, [doc])

  // 容器宽度 → 渲染 dpi（上限 1600px 宽，避免超大画布）
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) setWidth(Math.round(w))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [phase])

  useEffect(() => {
    if (!doc || phase !== 'ready') return
    let alive = true
    ;(async () => {
      try {
        const p = doc.page(page)
        try {
          const base = Math.max(1, p.width_at(96))
          const target = Math.min(1600, Math.max(320, width - 40))
          const dpi = Math.min(200, Math.max(72, Math.round((target / base) * 96)))
          const pixels = p.render(dpi)
          const canvas = canvasRef.current
          if (!alive || !canvas) return
          canvas.width = p.width_at(dpi)
          canvas.height = p.height_at(dpi)
          canvas.getContext('2d')?.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, canvas.width, canvas.height), 0, 0)
        } finally {
          p.free()
        }
      } catch {
        if (alive) setPhase('error')
      }
    })()
    return () => { alive = false }
  }, [doc, page, width, phase])

  // ←/→ 翻页（与 PDF 查看器习惯一致）
  useEffect(() => {
    if (phase !== 'ready' || total <= 0) return
    const onKey = (e: KeyboardEvent) => {
      // 页面里还有搜索框/评论框：可编辑元素里的方向键不应翻页
      const el = e.target as HTMLElement | null
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return
      if (e.key === 'ArrowLeft') setPage((p) => Math.max(0, p - 1))
      else if (e.key === 'ArrowRight') setPage((p) => Math.min(total - 1, p + 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, total])

  if (phase === 'error') {
    return (
      <div className="pv-gate">
        <p>{t('preview.djvu.fail')}</p>
        {fallback}
      </div>
    )
  }
  if (phase === 'loading') {
    return (
      <div className="pv-fetch-col">
        <ProgressLine p={progress} />
        <FetchHint label={t('preview.djvu.loading')} hint={progress == null ? undefined : `${Math.round(progress * 100)}%`} />
      </div>
    )
  }
  return (
    <div className="pv-djvu-wrap" ref={wrapRef}>
      <div className="pv-djvu-bar no-print">
        <button className="row-action" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
          <ChevronLeft size={14} />{t('preview.ebook.prev')}
        </button>
        <span className="pv-djvu-page">{t('preview.djvu.page', { page: page + 1, total })}</span>
        <button className="row-action" disabled={page >= total - 1} onClick={() => setPage((p) => Math.min(total - 1, p + 1))}>
          {t('preview.ebook.next')}<ChevronRight size={14} />
        </button>
        <a href={url} target="_blank" rel="noreferrer" className="pv-open-ext" title={filename}>
          <ExternalLink size={13} />{t('preview.pdf.newtab')}
        </a>
      </div>
      <div className="pv-djvu-stage">
        <canvas ref={canvasRef} className="pv-djvu-canvas" />
      </div>
    </div>
  )
}

/* ── 电子书：foliate-js（EPUB / MOBI / AZW3 / CBZ，动态 import）──
 * paginator 的 iframe 是 allow-same-origin + allow-scripts，书内脚本会以同源
 * 身份执行；因此渲染前剥离 <script>、内联事件与 javascript: URL，并额外注入
 * script-src 'none' 的 CSP meta（自闭合：XHTML 按 XML 解析，非自闭合会解析失败）。
 * EPUB 走 book.transformTarget；MOBI/KF8 没有该钩子，改为包装 section.load
 * 返回的 blob URL 做同样处理。 */
const EBOOK_CSP_META = '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'; object-src \'none\'" />'

function guardEbookHtml(html: string): string {
  const clean = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|xlink:href)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, '$1="#"')
  if (/<head[^>]*>/i.test(clean)) return clean.replace(/<head[^>]*>/i, (m) => `${m}${EBOOK_CSP_META}`)
  if (/<html[^>]*>/i.test(clean)) return clean.replace(/<html[^>]*>/i, (m) => `${m}<head>${EBOOK_CSP_META}</head>`)
  return `${EBOOK_CSP_META}${clean}`
}

type FoliateBook = {
  transformTarget?: EventTarget
  sections?: Array<{ load?: () => Promise<string> }>
  destroy?: () => void
}

type FoliateViewEl = HTMLElement & {
  open: (input: Blob) => Promise<void>
  init: (opts?: { showTextStart?: boolean }) => Promise<void>
  goLeft: () => unknown
  goRight: () => unknown
  renderer?: { setStyles?: (styles: string) => void }
  book?: FoliateBook
}

/** 书页在 iframe 里没有继承站点主题；按当前主题补一层基础配色，避免黑字压暗底 */
function ebookCss(): string {
  const dark = typeof document !== 'undefined' && document.documentElement.dataset.theme !== 'light'
  return dark
    ? 'html{background:#1e1e1e}body{color:#d4d4d4}a:link,a:visited{color:#6cb6ff}img,video{max-width:100%;height:auto}'
    : 'html{background:#fff}body{color:#222}a:link,a:visited{color:#0969da}img,video{max-width:100%;height:auto}'
}

function EbookView({ url, filename, fallback }: { url: string; filename: string; fallback: ReactNode }) {
  const t = useT()
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<FoliateViewEl | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [progress, setProgress] = useState<number | null>(null)
  const [fraction, setFraction] = useState(0)

  useEffect(() => {
    let alive = true
    const host = hostRef.current
    if (!host) return
    setPhase('loading'); setProgress(null); setFraction(0)
    let view: FoliateViewEl | null = null
    let created: string[] = []

    ;(async () => {
      try {
        const bytes = await fetchBytes(url, (p) => { if (alive) setProgress(p) })
        if (!alive) return
        await import('foliate-js/view.js')
        if (!alive) return
        const file = new File([bytes], filename || 'book', { type: 'application/octet-stream' })
        view = document.createElement('foliate-view') as FoliateViewEl
        view.className = 'pv-ebook-view'
        host.append(view)
        viewRef.current = view
        await view.open(file)
        if (!alive) return
        const book = view.book
        if (book?.transformTarget) {
          book.transformTarget.addEventListener('data', (ev) => {
            const detail = (ev as CustomEvent<{ data: unknown; type?: string }>).detail
            if (!detail || !/html|xhtml|xml/i.test(detail.type || '')) return
            detail.data = Promise.resolve(detail.data).then((v) => (typeof v === 'string' ? guardEbookHtml(v) : v))
          })
        } else if (book?.sections) {
          for (const section of book.sections) {
            const orig = section.load?.bind(section)
            if (!orig) continue
            section.load = async () => {
              const src = await orig()
              if (typeof src !== 'string' || !src.startsWith('blob:')) return src
              try {
                const html = await (await fetch(src)).text()
                const next = URL.createObjectURL(new Blob([guardEbookHtml(html)], { type: 'text/html' }))
                created.push(next)
                return next
              } catch {
                return src
              }
            }
          }
        }
        view.addEventListener('relocate', (ev) => {
          const detail = (ev as CustomEvent<{ fraction?: number }>).detail
          if (alive && typeof detail?.fraction === 'number') setFraction(detail.fraction)
        })
        view.renderer?.setStyles?.(ebookCss())
        await view.init({ showTextStart: true })
        if (alive) setPhase('ready')
      } catch (err) {
        console.error('[preview] ebook failed', err)
        if (alive) setPhase('error')
      }
    })()

    return () => {
      alive = false
      viewRef.current = null
      for (const u of created) URL.revokeObjectURL(u)
      created = []
      try { view?.book?.destroy?.() } catch { /* 已销毁 */ }
      try { view?.remove() } catch { /* 已移除 */ }
    }
  }, [url, filename])

  return (
    <div className="pv-ebook-wrap">
      {phase === 'ready' && (
        <div className="pv-ebook-bar no-print">
          <button className="row-action" onClick={() => void viewRef.current?.goLeft()}>
            <ChevronLeft size={14} />{t('preview.ebook.prev')}
          </button>
          <span className="pv-ebook-pct">{t('preview.ebook.pct', { pct: Math.round(fraction * 100) })}</span>
          <button className="row-action" onClick={() => void viewRef.current?.goRight()}>
            {t('preview.ebook.next')}<ChevronRight size={14} />
          </button>
          <a href={url} target="_blank" rel="noreferrer" className="pv-open-ext">
            <ExternalLink size={13} />{t('preview.pdf.newtab')}
          </a>
        </div>
      )}
      <div className="pv-ebook-stage">
        <div className="pv-ebook-host" ref={hostRef} />
        {phase === 'loading' && (
          <div className="pv-ebook-overlay">
            <ProgressLine p={progress} />
            <FetchHint label={t('preview.ebook.loading')} hint={progress == null ? undefined : `${Math.round(progress * 100)}%`} />
          </div>
        )}
        {phase === 'error' && (
          <div className="pv-gate">
            <p>{t('preview.ebook.fail')}</p>
            {fallback}
          </div>
        )}
      </div>
    </div>
  )
}

function OfficeStatusView({ info, token, renderer }: { info: AttachmentPreviewInfo; token?: string; renderer?: 'js' | 'native' }) {
  const t = useT()
  const navigate = useNavigate()
  const [live, setLive] = useState<AttachmentPreviewInfo>(info)
  const [retrying, setRetrying] = useState(false)
  const state = live.previewState
  const busy = state === 'pending' || state === 'processing'
  const failed = state === 'failed'
  const tooBig = (live.sizeBytes || 0) > PREVIEW_CONVERT_MAX_BYTES

  const refresh = useCallback(async () => {
    const next = await attachmentPreviewFn({ data: { id: live.id!, token } })
    setLive(next)
  }, [live.id, token])

  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => { void refresh() }, 4000)
    return () => clearInterval(timer)
  }, [busy, refresh])

  const retry = async () => {
    setRetrying(true)
    try {
      const r = await attachmentPreviewRetryFn({ data: { id: live.id!, token } })
      if (r.ok) await refresh()
    } finally {
      setRetrying(false)
    }
  }

  // 轮询到转换完成：直接在本组件切到 PDF（父级 info 仍是旧状态，不会自动重挂载）
  if (live.previewState === 'ready' && live.pdfUrl) {
    return (
      <div className="pv-office-ready">
        <div className="pv-office-note no-print">{t('preview.office.nomedia')}</div>
        <PdfView url={live.pdfUrl} filename={`${live.filename || 'document'}.pdf`} forcedRenderer={renderer} />
      </div>
    )
  }

  return (
    <div className="pv-office-status">
      {busy && <Loader2 size={28} className="spin" />}
      <h2>{live.filename}</h2>
      <p className="pv-office-sub">
        {formatBytes(live.sizeBytes || 0)} · {t('preview.office.format')}
      </p>
      {busy && <p className="pv-office-wait">{state === 'processing' ? t('preview.office.processing') : t('preview.office.queued')}</p>}
      {failed && <p className="pv-office-wait err">{t('preview.office.failed')}</p>}
      {(state === 'unsupported' || !state) && !busy && (
        <p className="pv-office-wait err">{tooBig ? t('preview.office.toobig') : t('preview.office.unavailable')}</p>
      )}
      <div className="pv-office-actions">
        {busy && <button className="row-action" onClick={() => void refresh()}><RefreshCw size={13} />{t('preview.office.refresh')}</button>}
        {failed && !tooBig && (
          <button className="row-action primary" disabled={retrying} onClick={() => void retry()}>
            <RefreshCw size={13} />{retrying ? t('preview.office.retrying') : t('preview.office.retry')}
          </button>
        )}
        <DownloadFallback info={live} token={token} navigate={navigate} />
      </div>
    </div>
  )
}

function DownloadFallback({ info, token, navigate }: { info: AttachmentPreviewInfo; token?: string; navigate?: ReturnType<typeof useNavigate> }) {
  const t = useT()
  const att = {
    id: info.id!,
    postSlug: info.postSlug || '',
    filename: info.filename || '',
    mimeType: info.mimeType || 'application/octet-stream',
    sizeBytes: info.sizeBytes || 0,
    downloads: 0,
    createdAt: '',
    locked: false,
    // 仅用于渲染下载按钮；实际门禁由 action=file 服务端按登录态/guestVisible/token 再次校验
    guestVisible: false,
    gwDl: info.fileUrl || null,
  }
  return (
    <AttachmentDownloadButton
      att={att}
      token={token}
      className="row-action primary"
      label={t('attach.download')}
      onError={() => { if (navigate) void navigate({ to: '/preview/$id', params: { id: String(info.id!) }, search: { token } }) }}
    />
  )
}

function LockView({ info }: { info: AttachmentPreviewInfo }) {
  const t = useT()
  const navigate = useNavigate()
  const [pwd, setPwd] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const unlock = async () => {
    if (!pwd) { setErr(t('attach.err.pwd.empty')); return }
    setBusy(true); setErr('')
    try {
      const res = await fetch(`/api/comments?action=token&id=${info.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || t('attach.err.pwd.wrong'))
      await navigate({ to: '/preview/$id', params: { id: String(info.id!) }, search: { token: data.token as string } })
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('attach.err.check'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="pv-gate">
      <Lock size={28} />
      <h2>{info.filename}</h2>
      <p>{t('preview.locked.p')}</p>
      <div className="pv-gate-row">
        <input type="password" placeholder={t('attach.pwd.ph')} value={pwd} onChange={(e) => setPwd(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void unlock() }} />
        <button className="row-action primary" disabled={busy} onClick={() => void unlock()}>{busy ? t('attach.checking') : t('attach.unlock.download')}</button>
      </div>
      {err && <div className="banner error small">{err}</div>}
    </div>
  )
}

function PreviewBody({ info, token, renderer }: { info: AttachmentPreviewInfo; token?: string; renderer?: 'js' | 'native' }) {
  const fileUrl = info.fileUrl || info.sameOriginUrl || ''
  const navigate = useNavigate()
  const fallback = <DownloadFallback info={info} token={token} navigate={navigate} />
  switch (info.kind) {
    case 'pdf':
      return info.pdfUrl ? <PdfView url={info.pdfUrl} filename={info.filename || 'document.pdf'} forcedRenderer={renderer} /> : <FetchHint label="" />
    case 'djvu':
      return <DjvuView url={fileUrl} filename={info.filename || ''} fallback={fallback} />
    case 'ebook':
      return <EbookView url={fileUrl} filename={info.filename || ''} fallback={fallback} />
    case 'office':
      return info.previewState === 'ready' && info.pdfUrl
        ? <PdfView url={info.pdfUrl} filename={`${info.filename || 'document'}.pdf`} forcedRenderer={renderer} />
        : <OfficeStatusView info={info} token={token} renderer={renderer} />
    case 'md':
    case 'text':
    case 'csv':
      return <TextBlobView url={fileUrl} kind={info.kind} filename={info.filename || ''} />
    case 'html':
      return <HtmlView url={fileUrl} />
    case 'mindmap':
      return <MindmapView url={fileUrl} filename={info.filename || ''} />
    case 'image':
      return (
        <div className="pv-image-wrap">
          <img className="pv-image" src={fileUrl} alt={info.filename || ''} />
        </div>
      )
    case 'audio':
      return (
        <div className="pv-media-wrap">
          <audio className="pv-audio" src={fileUrl} controls preload="metadata" />
        </div>
      )
    case 'video':
      return (
        <div className="pv-media-wrap">
          <video className="pv-video" src={fileUrl} controls preload="metadata" />
        </div>
      )
    default:
      return null
  }
}

function PreviewPage() {
  const t = useT()
  const { token, renderer } = Route.useSearch()
  const info = Route.useLoaderData()
  const navigate = useNavigate()

  useEffect(() => {
    document.body.classList.add('preview-mode')
    const unsub = onAuthChange((user) => { if (user) window.location.reload() })
    // 从 bfcache 恢复（后退/前进）时，登录态与转换状态可能已过期（如登出态门禁页、
    // failed→ready 的轮询页）：统一整页重载拿最新 SSR 结果。
    const onPageShow = (e: PageTransitionEvent) => { if (e.persisted) window.location.reload() }
    window.addEventListener('pageshow', onPageShow)
    return () => {
      document.body.classList.remove('preview-mode')
      unsub()
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [])

  let body: ReactNode
  if (info.authRequired) {
    body = (
      <div className="pv-gate">
        <Lock size={28} />
        <h2>{t('preview.auth.title')}</h2>
        <p>{t('preview.auth.p')}</p>
        <button className="row-action primary" onClick={() => window.dispatchEvent(new Event('open-auth'))}>{t('attach.login.btn')}</button>
      </div>
    )
  } else if (!info.found) {
    body = <div className="pv-gate"><h2>404</h2><p>{t('preview.notfound')}</p></div>
  } else if (info.locked) {
    body = <LockView info={info} />
  } else if (!info.kind) {
    body = (
      <div className="pv-gate">
        <FileDown size={26} />
        <h2>{info.filename}</h2>
        <p>{t('preview.unsupported')}</p>
        <DownloadFallback info={info} token={token} navigate={navigate} />
      </div>
    )
  } else {
    body = <PreviewBody info={info} token={token} renderer={renderer} />
  }

  return (
    <div className="preview-shell">
      <header className="preview-topbar no-print">
        <div className="preview-topbar-inner">
          {info.postSlug
            ? <Link to="/posts/$slug" params={{ slug: info.postSlug }} className="preview-back"><ArrowLeft size={14} />{t('preview.back')}</Link>
            : <a href="/" className="preview-back"><ArrowLeft size={14} />{t('preview.back')}</a>}
          <span className="preview-file-title" title={info.filename}>{info.filename}</span>
          {!info.authRequired && info.found && !info.locked && info.sizeBytes
            ? <span className="preview-file-size">{formatBytes(info.sizeBytes)}</span>
            : null}
        </div>
      </header>
      <main className="preview-main">{body}</main>
    </div>
  )
}
