/**
 * X 岛串内容导出（浏览器端工具，组件内动态 import，不进服务端包）：
 * - 并发拉全部分页（每页 19 条回复，3 路并发，带去重）；
 * - 输出 Markdown / 自包含 HTML（打印友好，可直接另存 PDF）/ 纯文本 / JSON；
 * - 图片一律转成 X 岛官方图床绝对地址，文件脱离本站仍可阅读；
 * - 净化 HTML 里的 xdnmb: 内部协议在导出时还原为官方链接或楼内锚点。
 */
import type { XPost } from './xdnmb-types'

export type XExportFormat = 'md' | 'html' | 'txt' | 'json'

const IMG_BASE = 'https://image.nmb.best'
const WEB_BASE = 'https://nmbxd.com'
const PAGE_SIZE = 19

/** 拉取整串所有页（首页已知，从第 2 页起并发；按楼 ID 去重排序） */
export async function fetchFullThread(
  _id: string,
  replyCount: number,
  fetchPage: (page: number) => Promise<XPost>,
  onProgress?: (done: number, total: number) => void,
): Promise<{ thread: XPost; replies: XPost[] }> {
  const total = Math.max(1, Math.ceil((Number(replyCount) || 0) / PAGE_SIZE))
  const byId = new Map<number, XPost>()
  let thread: XPost | null = null

  async function ingest(page: number): Promise<XPost> {
    const t = await fetchPage(page)
    if (!thread && t && t.id) thread = t
    for (const r of t.Replies || []) if (r && typeof r.id === 'number') byId.set(r.id, r)
    return t
  }

  const pages: number[] = []
  for (let p = 1; p <= total; p++) pages.push(p)
  let cursor = 0
  let done = 0
  const worker = async () => {
    for (;;) {
      const p = pages[cursor++]
      if (p === undefined) return
      await ingest(p)
      done += 1
      onProgress?.(done, total)
    }
  }
  await Promise.all([worker(), worker(), worker()])
  if (!thread) throw new Error('导出失败：未取到串内容')

  // replyCount 缺失/被删楼导致末页不全时，顺序补探直到拿不到新楼（最多 5 页保护）
  let guard = 0
  while (guard < 5) {
    const next = total + guard + 1
    const before = byId.size
    const t = await ingest(next)
    done += 1
    onProgress?.(done, done)
    if (byId.size === before || !(t.Replies || []).length) break
    guard += 1
  }

  const replies = [...byId.values()].sort((a, b) => a.id - b.id)
  return { thread: thread as XPost, replies }
}

// ───────────────────────── 链接/图片协议还原 ─────────────────────────

/** 代理图片相对地址 → 官方图床绝对地址（kind=thumb 也升级为原图） */
function absImg(src: string): string {
  let m = /^\/api\/xdnmb\?action=img&kind=(?:thumb|image)&p=([^&]+)/.exec(src)
  if (m) return `${IMG_BASE}/image/${decodeURIComponent(m[1])}`
  if (src.startsWith('/')) return `${WEB_BASE}${src}`
  return src
}

function attachedImg(p: XPost): string {
  return p.img && p.ext ? `${IMG_BASE}/image/${p.img}${p.ext}` : ''
}

function linkUrl(href: string, localIds: Set<number>): string | null {
  let m = /^xdnmb:thread:(\d+)/.exec(href)
  if (m) return `${WEB_BASE}/t/${m[1]}`
  m = /^xdnmb:forum:(.+)$/.exec(href)
  if (m) return `${WEB_BASE}/f/${encodeURIComponent(m[1])}`
  m = /^xdnmb:ref:(\d+)/.exec(href)
  if (m) {
    // 本串引用：导成页内锚点；跨串引用无法直达，返回 null 退化为纯文本
    return localIds.has(Number(m[1])) ? `#r${m[1]}` : null
  }
  if (/^https?:\/\//i.test(href) || href.startsWith('mailto:')) return href
  return null
}

// ───────────────────────── DOM 遍历（净化 HTML 是白名单标签，结构简单） ─────────────────────────

type Ctx = { localIds: Set<number> }

function nodeToMd(node: Node, ctx: Ctx, depth = 0): string {
  if (node.nodeType === 3) return node.textContent || ''
  if (node.nodeType !== 1) return ''
  const el = node as Element
  const tag = el.tagName.toLowerCase()
  const inner = (sep = '') => [...el.childNodes].map((c) => nodeToMd(c, ctx, depth + 1)).join(sep)

  switch (tag) {
    case 'br': return '\n'
    case 'p': return `${inner()}\n\n`
    case 'blockquote': {
      const lines = inner().trim().split('\n').map((l) => `> ${l}`).join('\n')
      return `\n${lines}\n\n`
    }
    case 'b': case 'strong': return `**${inner()}**`
    case 'i': case 'em': return `*${inner()}*`
    case 's': return `~~${inner()}~~`
    case 'h1': case 'h2': case 'h3': return `\n\n${'#'.repeat(Number(tag[1]))} ${inner()}\n\n`
    case 'ul': case 'ol': return `\n${inner()}\n`
    case 'li': return `- ${inner()}\n`
    case 'a': {
      const href = el.getAttribute('href') || ''
      const url = linkUrl(href, ctx.localIds)
      const text = inner().trim()
      if (!url) return text
      if (text === url) return url
      return `[${text}](${url})`
    }
    case 'img': {
      const src = absImg(el.getAttribute('src') || '')
      if (!src) return ''
      return `\n\n![图片](${src})\n\n`
    }
    case 'font': case 'span': case 'small': case 'sub': case 'sup': return inner()
    default: return inner()
  }
}

function nodeToTxt(node: Node): string {
  if (node.nodeType === 3) return node.textContent || ''
  if (node.nodeType !== 1) return ''
  const el = node as Element
  const tag = el.tagName.toLowerCase()
  const inner = () => [...el.childNodes].map(nodeToTxt).join('')
  switch (tag) {
    case 'br': return '\n'
    case 'p': return `${inner()}\n\n`
    case 'blockquote': return `\n${inner().trim().split('\n').map((l) => `  > ${l}`).join('\n')}\n\n`
    case 'li': return `- ${inner()}\n`
    case 'img': {
      const src = absImg(el.getAttribute('src') || '')
      return src ? `[图片] ${src}\n` : ''
    }
    case 'a': {
      const text = inner().trim()
      const href = el.getAttribute('href') || ''
      const m = /^xdnmb:ref:(\d+)/.exec(href)
      if (m) return `>>No.${m[1]}`
      if (/^xdnmb:/.test(href)) return text
      return text && text !== href ? `${text} (${href})` : href
    }
    default: return inner()
  }
}

function parseBody(html: string): Element {
  const doc = new DOMParser().parseFromString(`<div id="__xroot">${html}</div>`, 'text/html')
  return doc.getElementById('__xroot') as Element
}

const tidyMd = (s: string) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
const tidyTxt = (s: string) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

function mdOf(p: XPost, ctx: Ctx, floor: string): string {
  const body = tidyMd(nodeToMd(parseBody(p.content || ''), ctx))
  const img = attachedImg(p)
  return [
    `### ${floor} No.${p.id}`,
    `${p.now || ''}　ID: ${p.user_hash || ''}${p.sage ? '　[SAGE]' : ''}${p.admin ? '　[ADMIN]' : ''}`,
    '',
    body,
    img ? `\n![图片](${img})` : '',
  ].filter(Boolean).join('\n')
}

function txtOf(p: XPost, floor: string): string {
  const body = tidyTxt(nodeToTxt(parseBody(p.content || '')))
  const img = attachedImg(p)
  return [
    `${floor} No.${p.id}  ${p.now || ''}  ID: ${p.user_hash || ''}${p.sage ? ' [SAGE]' : ''}${p.admin ? ' [ADMIN]' : ''}`,
    '─'.repeat(28),
    body,
    img ? `[图片] ${img}` : '',
  ].filter(Boolean).join('\n')
}

function htmlBodyOf(p: XPost, ctx: Ctx): string {
  // 复用净化后的片段，仅替换协议与图片地址
  const root = parseBody(p.content || '')
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || ''
    const m = /^xdnmb:ref:(\d+)/.exec(href)
    if (m) {
      if (ctx.localIds.has(Number(m[1]))) a.setAttribute('href', `#r${m[1]}`)
      else { a.removeAttribute('href'); a.classList.add('x-ref-plain') }
      return
    }
    const mm = /^xdnmb:thread:(\d+)/.exec(href)
    if (mm) { a.setAttribute('href', `${WEB_BASE}/t/${mm[1]}`); a.setAttribute('target', '_blank'); (a as HTMLAnchorElement).rel = 'noopener'; return }
    const mf = /^xdnmb:forum:(.+)$/.exec(href)
    if (mf) { a.setAttribute('href', `${WEB_BASE}/f/${encodeURIComponent(mf[1])}`); a.setAttribute('target', '_blank'); (a as HTMLAnchorElement).rel = 'noopener'; return }
  })
  root.querySelectorAll('img[src]').forEach((im) => im.setAttribute('src', absImg(im.getAttribute('src') || '')))
  const img = attachedImg(p)
  return `${root.innerHTML}${img ? `<p class="x-att"><img src="${img}" alt=""/></p>` : ''}`
}

const esc = (s: string) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function buildMarkdown(thread: XPost, replies: XPost[], localIds: Set<number>): string {
  const ctx = { localIds }
  const title = thread.title && thread.title !== '无标题' ? thread.title : `No.${thread.id}`
  const head = [
    `# ${title}`,
    '',
    `> X 岛匿名版串 No.${thread.id}　共 ${Number(thread.ReplyCount ?? replies.length)} 条回应`,
    `> 导出时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    '---',
    '',
    mdOf(thread, ctx, '【主楼】'),
  ]
  const body = replies
    .filter((r) => r.user_hash !== 'Tips')
    .map((r, i) => mdOf(r, ctx, `【${i + 1}楼】`))
  const tips = replies.filter((r) => r.user_hash === 'Tips').map((r) => tidyMd(nodeToMd(parseBody(r.content || ''), ctx)))
  return [...head, '', ...body, ...(tips.length ? ['', '> 系统提示：', ...tips.map((x) => `> ${x}`)] : []), ''].join('\n\n')
}

function buildText(thread: XPost, replies: XPost[]): string {
  const title = thread.title && thread.title !== '无标题' ? thread.title : `No.${thread.id}`
  const head = [
    title,
    '='.repeat(32),
    `X 岛匿名版  No.${thread.id}  共 ${Number(thread.ReplyCount ?? replies.length)} 条回应`,
    `导出时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    txtOf(thread, '【主楼】'),
  ]
  const body = replies
    .filter((r) => r.user_hash !== 'Tips')
    .map((r, i) => txtOf(r, `【${i + 1}楼】`))
  return [...head, '', ...body, ''].join('\n\n')
}

function buildHtml(thread: XPost, replies: XPost[], localIds: Set<number>): string {
  const ctx = { localIds }
  const title = thread.title && thread.title !== '无标题' ? esc(thread.title) : `No.${thread.id}`
  const plainPreview = (p: XPost): string =>
    esc((p.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 48))
  const floor = (p: XPost, label: string, anchorId: string) => `
  <article class="floor" id="${anchorId}">
    <header>
      <span class="floorno">${label}</span>
      <a class="no" href="#${anchorId}">No.${p.id}</a>
      <span class="now">${esc(p.now || '')}</span>
      <span class="hash">ID: ${esc(p.user_hash || '')}</span>
      ${p.sage ? '<span class="badge sage">SAGE</span>' : ''}
      ${p.admin ? '<span class="badge admin">ADMIN</span>' : ''}
    </header>
    <div class="content">${htmlBodyOf(p, ctx)}</div>
  </article>`
  const realReplies = replies.filter((r) => r.user_hash !== 'Tips')
  const floors = [
    floor(thread, '主楼', `r${thread.id}`),
    ...realReplies.map((r, i) => floor(r, `${i + 1}楼`, `r${r.id}`)),
  ].join('\n')
  // 长串浏览：折叠目录（楼号 + 正文预览 → 楼内锚点），≤30 楼默认展开；
  // 超过 100 楼时提供过滤输入框，避免 2000+ 条目难以浏览
  const tocRows = [
    `<a href="#r${thread.id}" data-text="主楼 No.${thread.id} ${plainPreview(thread)}"><b>主楼</b>　No.${thread.id}　${plainPreview(thread)}</a>`,
    ...realReplies.map((r, i) =>
      `<a href="#r${r.id}" data-text="${i + 1}楼 No.${r.id} ${plainPreview(r)}"><b>${i + 1}楼</b>　No.${r.id}　${plainPreview(r)}</a>`),
  ].join('\n')
  const needFilter = realReplies.length > 100
  const toc = `
  <details class="toc"${realReplies.length <= 30 ? ' open' : ''}>
    <summary>目录 · 共 ${realReplies.length + 1} 楼（点击条目跳转）</summary>
    ${needFilter ? '<input class="toc-filter" type="search" placeholder="输入楼号 / No. / 关键词过滤…" autocomplete="off"/>' : ''}
    <nav>${tocRows}</nav>
  </details>`
  const tocScript = needFilter ? `
<script>
(function(){
  var f=document.querySelector('.toc-filter'),nav=document.querySelector('.toc nav');
  if(!f||!nav)return;
  var links=nav.querySelectorAll('a');
  f.addEventListener('input',function(){
    var q=f.value.trim().toLowerCase();
    for(var i=0;i<links.length;i++){
      var a=links[i];
      a.style.display=(!q||(a.getAttribute('data-text')||'').toLowerCase().indexOf(q)>=0)?'':'none';
    }
  });
})();
</script>` : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title} - X 岛串导出</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body { margin: 0; background: #f5f6f8; color: #1f2430; font: 15px/1.75 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  .wrap { max-width: 820px; margin: 0 auto; padding: 24px 16px 80px; }
  .doc-head { background: #fff; border: 1px solid #e3e6ec; border-radius: 12px; padding: 18px 20px; margin-bottom: 18px; }
  .doc-head h1 { margin: 0 0 6px; font-size: 22px; }
  .doc-head .meta { color: #6b7280; font-size: 13px; }
  .doc-head a { color: #2563eb; }
  .toc { background: #fff; border: 1px solid #e3e6ec; border-radius: 12px; padding: 10px 14px; margin-bottom: 18px; position: sticky; top: 12px; z-index: 5; box-shadow: 0 2px 10px rgb(0 0 0 / .06); }
  .toc summary { cursor: pointer; font-weight: 600; font-size: 14px; color: #1f2430; user-select: none; list-style: none; }
  .toc summary::-webkit-details-marker { display: none; }
  .toc summary::before { content: '▸'; display: inline-block; margin-right: 6px; transition: transform .15s; color: #0f9d76; }
  .toc[open] summary::before { transform: rotate(90deg); }
  .toc-filter { display: block; width: 100%; margin: 10px 0 6px; padding: 7px 10px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 13px; outline: none; }
  .toc-filter:focus { border-color: #0f9d76; box-shadow: 0 0 0 2px rgb(15 157 118 / .15); }
  .toc nav { display: block; max-height: 44vh; overflow-y: auto; margin-top: 6px; padding-right: 4px; }
  .toc nav a { display: block; color: #2563eb; text-decoration: none; font-size: 12.5px; padding: 4px 8px; border-radius: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .toc nav a b { color: #0f9d76; font-weight: 600; }
  .toc nav a:hover { background: #f1f5f9; }
  .totop {
    position: fixed; right: 16px; bottom: 22px; z-index: 9;
    display: inline-block; padding: 9px 14px; border-radius: 999px;
    background: #fff; border: 1px solid #e3e6ec; color: #1f2430;
    font-size: 13px; text-decoration: none; box-shadow: 0 4px 14px rgb(0 0 0 / .12);
  }
  .totop:hover { color: #0f9d76; border-color: #0f9d76; }
  .floor { background: #fff; border: 1px solid #e3e6ec; border-radius: 12px; padding: 14px 18px; margin: 0 0 14px; scroll-margin-top: 12px; }
  .floor#r${thread.id} { border-left: 4px solid #0f9d76; }
  .floor header { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; font-size: 13px; color: #6b7280; margin-bottom: 8px; }
  .floorno { background: #0f9d76; color: #fff; border-radius: 6px; padding: 1px 8px; font-weight: 600; }
  .floor .no { color: #2563eb; font-weight: 600; text-decoration: none; }
  .badge { border-radius: 4px; padding: 0 6px; font-size: 12px; }
  .badge.sage { background: #eef2ff; color: #4f46e5; }
  .badge.admin { background: #fee2e2; color: #b91c1c; }
  .content { overflow-wrap: anywhere; }
  .content img { max-width: 100%; border-radius: 8px; margin: 6px 0; }
  .content a { color: #2563eb; }
  .content blockquote { margin: 6px 0; padding: 4px 12px; border-left: 3px solid #cbd5e1; color: #475569; background: #f8fafc; }
  .x-ref-plain { color: inherit; text-decoration: none; }
  @media print {
    body { background: #fff; font-size: 12px; }
    .wrap { max-width: none; padding: 0; }
    .doc-head, .floor { border: none; border-radius: 0; padding: 8px 0; }
    .floor { page-break-inside: avoid; border-bottom: 1px dashed #ccc; }
    .toc, .totop { display: none; }
    a { color: inherit; text-decoration: none; }
  }
</style>
</head>
<body>
<div class="wrap" id="top">
  <section class="doc-head">
    <h1>${title}</h1>
    <div class="meta">
      X 岛匿名版 · <a href="${WEB_BASE}/t/${thread.id}">No.${thread.id}</a> · 共 ${Number(thread.ReplyCount ?? replies.length)} 条回应<br/>
      导出时间：${esc(new Date().toLocaleString('zh-CN'))}
    </div>
  </section>
${toc}
${floors}
</div>
<a class="totop" href="#top">↑ 回到顶部</a>
${tocScript}
</body>
</html>`
}

function buildJson(thread: XPost, replies: XPost[]): string {
  const strip = (p: XPost) => ({
    id: p.id,
    fid: p.fid ?? null,
    title: p.title || '',
    content: tidyTxt(nodeToTxt(parseBody(p.content || ''))),
    img: attachedImg(p) || null,
    now: p.now,
    user_hash: p.user_hash,
    sage: !!p.sage,
    admin: !!p.admin,
    reply_count: typeof p.ReplyCount === 'number' ? p.ReplyCount : null,
    url: `${WEB_BASE}/t/${thread.id}`,
  })
  return JSON.stringify(
    {
      source: 'X 岛匿名版 (nmbxd)',
      exportedAt: new Date().toISOString(),
      threadUrl: `${WEB_BASE}/t/${thread.id}`,
      thread: strip(thread),
      replies: replies.filter((r) => r.user_hash !== 'Tips').map(strip),
    },
    null,
    2,
  )
}

export function buildExport(format: XExportFormat, thread: XPost, replies: XPost[]): string {
  const localIds = new Set<number>([thread.id, ...replies.map((r) => r.id)])
  switch (format) {
    case 'md': return buildMarkdown(thread, replies, localIds)
    case 'html': return buildHtml(thread, replies, localIds)
    case 'txt': return buildText(thread, replies)
    case 'json': return buildJson(thread, replies)
  }
}

export function exportMime(format: XExportFormat): string {
  return { md: 'text/markdown', html: 'text/html', txt: 'text/plain', json: 'application/json' }[format]
}

export function safeFileName(thread: XPost, format: XExportFormat): string {
  const raw = thread.title && thread.title !== '无标题' ? thread.title : `No.${thread.id}`
  const name = raw.replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/\s+/g, ' ').slice(0, 60).trim() || `No.${thread.id}`
  return `X岛串-No${thread.id}-${name}.${format === 'md' ? 'md' : format}`
}

export function downloadTextFile(filename: string, mime: string, content: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}
