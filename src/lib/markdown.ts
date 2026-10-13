import katex from 'katex'
// mhchem 必须与主 katex 是同一实例：走 package exports 的 import 条件解析到
// dist/contrib/mhchem.mjs（其内部 import '../katex.mjs'）。若直接引
// dist/contrib/mhchem.js（UMD），Vite 打包后会 require 另一个 katex.js 实例，
// \ce 宏注册到未被使用的实例上 → 渲染时 \ce 变成未知命令（红色文本）。
import 'katex/contrib/mhchem'
import { Marked, type Token } from 'marked'
import { renderStickerShortcode } from './stickers'
import { pickupCodeFromUrl } from './utils'

const escapeHtml = (value: string) =>
  value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character]!)

// ──────────────────────────────────────────────
// Callout 配置（对标 Obsidian：类型全集 + 别名归一 + Lucide 风格图标）
// ──────────────────────────────────────────────
const CALLOUT_TYPES = [
  'note', 'abstract', 'info', 'todo', 'tip', 'success',
  'important', 'question', 'warning', 'failure', 'danger', 'bug', 'example', 'quote',
] as const
type CalloutType = (typeof CALLOUT_TYPES)[number]

/** Obsidian 别名 → 站点规范类型（颜色组） */
const CALLOUT_ALIASES: Record<string, CalloutType> = {
  summary: 'abstract', tldr: 'abstract',
  hint: 'tip',
  check: 'success', done: 'success',
  help: 'question', faq: 'question',
  caution: 'warning', attention: 'warning',
  fail: 'failure', missing: 'failure',
  error: 'danger',
  cite: 'quote',
}

const svgIcon = (paths: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`

const CALLOUT_ICONS: Record<string, string> = {
  note: svgIcon('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>'),
  abstract: svgIcon('<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>'),
  info: svgIcon('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
  todo: svgIcon('<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'),
  tip: svgIcon('<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>'),
  success: svgIcon('<path d="M20 6 9 17l-5-5"/>'),
  important: svgIcon('<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>'),
  question: svgIcon('<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'),
  warning: svgIcon('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
  failure: svgIcon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  danger: svgIcon('<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>'),
  bug: svgIcon('<path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/>'),
  example: svgIcon('<path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/>'),
  quote: svgIcon('<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>'),
}
const CALLOUT_LABELS: Record<string, string> = {
  note: 'Note', abstract: 'Abstract', info: 'Info', todo: 'Todo', tip: 'Tip', success: 'Success',
  important: 'Important', question: 'Question', warning: 'Warning', failure: 'Failure',
  danger: 'Danger', bug: 'Bug', example: 'Example', quote: 'Quote',
}

// ──────────────────────────────────────────────
// 辅助函数
// ──────────────────────────────────────────────
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section'
}

function tokensToText(tokens: Token[]): string {
  return (tokens || []).map(t => {
    const raw = (t as { raw?: string }).raw ?? ''
    const text = (t as { text?: string }).text ?? ''
    const subTokens = (t as { tokens?: Token[] }).tokens
    if (subTokens && subTokens.length > 0) return tokensToText(subTokens)
    return raw || text
  }).join('')
}

export interface MarkdownHeading {
  id: string
  text: string
  level: number
}

/** 还原 escapeHtml 的常见实体（与浏览器 textContent 解码口径对齐） */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * 从 renderMarkdown 产物中提取 h2-h4 大纲（与 article-outline 的 DOM 提取同口径：
 * 剔除尾部 # 锚点链接、实体解码）。纯字符串解析，SSR 阶段可用——
 * 让大纲按钮直接进入首屏 HTML，不依赖客户端水合才出现（弱网下水合可能延迟或失败）。
 */
export function extractHeadingsFromHtml(html: string): MarkdownHeading[] {
  const out: MarkdownHeading[] = []
  for (const m of html.matchAll(/<h([2-4])\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g)) {
    // 剥离尾部 <a class="anchor">#</a> 与其余标签，得到纯文本
    const inner = m[3].replace(/<a[^>]*class="anchor"[^>]*>[\s\S]*?<\/a>/, '')
    const text = decodeEntities(inner.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
    out.push({ id: decodeEntities(m[2]), text, level: Number(m[1]) })
  }
  return out
}

/**
 * 月品木子取件卡片：?q= 二字口令链接不是可直连的图片/文件，
 * 渲染为取件卡片；点击行为由 PickupPreviewHost 事件委托接管（站内预览弹层），
 * 无 JS 时 <a href> 正常跳转降级。图标用内联 SVG 继承 currentColor，深浅主题自动适配。
 */
const PICKUP_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>'

function pickupCardHtml(href: string, code: string, note?: string): string {
  const noteHtml = note && note.trim() && note.trim() !== code
    ? `<span class="pickup-note">${escapeHtml(note.trim())}</span>` : ''
  return `<a class="pickup-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer" data-pickup-code="${escapeHtml(code)}">`
    + `<span class="pickup-icon" aria-hidden="true">${PICKUP_ICON_SVG}</span>`
    + `<span class="pickup-body"><b class="pickup-code">${escapeHtml(code)}</b>${noteHtml}`
    + `<span class="pickup-sub">月品木子 · 点击预览 / 取件</span></span>`
    + `<span class="pickup-go" aria-hidden="true">↗</span></a>`
}

// ──────────────────────────────────────────────
// 主渲染函数
// ──────────────────────────────────────────────
export function renderMarkdown(source: string, headingShift = 0) {
  // ── 预处理 0：剥离 Obsidian frontmatter（粘贴即所得；站点元数据走编辑器字段） ──
  source = source.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, (m) => (m.includes(':') ? '' : m))

  // ── 预处理 1：剥离 %%…%% 注释 ──
  source = source.replace(/%%[\s\S]*?%%/g, '')

  // ── 预处理 2：提取脚注定义 ──
  const footnoteDefs = new Map<string, string>()
  source = source.replace(
    /^\[\^([^\]]+)\]: ?[ \t]?(.*)(?:\n((?:[ \t]+.*(?:\n|$))*))/gm,
    (_m, id: string, line: string, cont?: string) => {
      const def = (line + (cont ? '\n' + cont.replace(/^[ \t]+/gm, '') : '')).trim()
      footnoteDefs.set(id, def)
      return ''
    },
  )

  // ── 预处理 3：Obsidian 嵌入 ![[...]]（必须在 KaTeX 占位前，否则改动不会进入 withPlaceholders） ──
  // http 图片直链 → 标准图片语法；其余本地引用 → 嵌入徽章占位
  //（本地文件不存在于站点，徽章比破碎的图片/链接更贴近 Obsidian 观感）
  const wikiEmbeds: string[] = []
  source = source.replace(/!\[\[([^\]]+)\]\]/g, (_m, raw: string) => {
    const target = raw.trim().replace(/\^[\w-]+$/, '')
    if (/^https?:\/\//i.test(target)) {
      if (/\.(?:png|jpe?g|gif|webp|svg|avif|bmp)(?:\?\S*)?$/i.test(target)) return `![](${target})`
      const name = target.split('/').pop() || target
      return `[${name}](${target})`
    }
    const index = wikiEmbeds.push(target) - 1
    return `WIKIEMBED${index}ENDWIKIEMBED`
  })

  // ── 预处理 4：Obsidian 标签 #tag（跳过围栏代码块与行内代码；前置字符排除字母/#&/\、[ ] ( )，
  // 避开 C#、URL 锚点、HTML 实体、[[#本页锚]]、[文本](#站内锚点)） ──
  const codeStash: string[] = []
  source = source
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g, (m) => `\u0000${codeStash.push(m) - 1}\u0000`)
    .replace(/(^|[^\p{L}\p{N}#&/\\[\]()])#([\p{L}\p{N}][\p{L}\p{N}_/-]*)/gmu, (_m, pre: string, tag: string) => `${pre}MDTAG${encodeURIComponent(tag)}ENDMDTAG`)
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codeStash[Number(i)])

  // ── 预处理 5：KaTeX 与研究报告标记 ──
  // KaTeX 支持四组定界符：$$…$$（块）、\[…\]（块，LaTeX/MathJax 标准）、$…$（行内）、\(…\)（行内）。
  // AI 检索报告（如文献综述）常见两类标记也在此渲染：
  //   [cite:N] / [cite:N 备注] —— 引用标记：列表行首的是来源条目锚点，其余是上标引用；
  //   [CONFIRMED] / [MAJORITY] / [unverified] 等 —— 置信标签 → 彩色徽章。
  // 数学与标记处理前先把行内代码/围栏代码块 stash（如示例 `$\ce{…}$` 是展示源码，
  // 不应被渲染），全部占位替换完成后再还原代码。
  const mathStash: string[] = []
  const mathBlocks: string[] = []
  const citeDefs = new Set<string>()
  const citeRefs: { id: string; note: string }[] = []
  const confBadges: string[] = []
  const stashCode = (m: string) => `\u0000M${mathStash.push(m) - 1}M\u0000`
  const renderDisplay = (expression: string) => {
    const index = mathBlocks.push(katex.renderToString(expression.trim(), {
      displayMode: true,
      throwOnError: false,
      strict: false,
    })) - 1
    return `\n\nMATHBLOCK${index}ENDMATH\n\n`
  }
  const renderInline = (expression: string) => {
    const index = mathBlocks.push(katex.renderToString(expression.trim(), {
      displayMode: false,
      throwOnError: false,
      strict: false,
    })) - 1
    return `MATHINLINE${index}ENDMATH`
  }
  const withPlaceholders = source
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g, stashCode)
    // 来源条目（列表行首的 [cite:N]）→ 锚点占位，链接目标 <span id="cite-N">
    .replace(/^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[cite:(\d+)\]/gm,
      (_m, prefix: string, id: string) => {
        citeDefs.add(id)
        return `${prefix}CITEDEF${id}ENDCITEDEF`
      })
    // 正文引用 [cite:N] / [cite:N 备注] → 上标占位
    .replace(/\[cite:(\d+)(?:\s+([^\]\n]+))?\]/g,
      (_m, id: string, note?: string) => {
        const index = citeRefs.push({ id, note: (note || '').trim() }) - 1
        return `CITEREF${index}ENDCITEREF`
      })
    // 置信标签 → 徽章占位（白名单匹配，避免误伤普通方括号文本）
    .replace(/\[(CONFIRMED|MAJORITY|SINGLE-SOURCE|UNVERIFIED|INSUFFICIENT DATA|DISPUTED[^\]\n]{0,30})\]/gi,
      (_m, raw: string) => {
        const index = confBadges.push(raw.trim()) - 1
        return `CONFBADGE${index}ENDCONFBADGE`
      })
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, expression: string) => renderDisplay(expression))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, expression: string) => renderInline(expression))
    .replace(/\$\$([\s\S]+?)\$\$/g, (_m, expression: string) => renderDisplay(expression))
    .replace(/(?<!\$)\$([^\n$]+?)\$(?!\$)/g, (_m, expression: string) => renderInline(expression))
    .replace(/\u0000M(\d+)M\u0000/g, (_m, i: string) => mathStash[Number(i)])

  // ── 每次 renderMarkdown 调用独立的闭包状态 ──
  const footnoteRefs: string[] = []
  const refOccurrences = new Map<string, number>()
  const slugCounts = new Map<string, number>()

  // ── 创建 Marked 实例 ──
  const marked = new Marked({
    gfm: true,
    breaks: true,
    renderer: {
      html: ({ text }: { text: string }) => escapeHtml(text),

      image: ({ href, title, text }: { href: string; title: string | null; text: string }) => {
        // 月品木子取件链接是 HTML 页面而非图片直链，渲染为取件卡片
        const pickup = /^https:\/\//i.test(href) ? pickupCodeFromUrl(href) : null
        if (pickup) {
          const caption = text && text.trim() ? `<figcaption>${escapeHtml(text)}</figcaption>` : ''
          return `<figure class="markdown-image pickup-figure">${pickupCardHtml(href, pickup, text)}${caption}</figure>`
        }
        if (/^https:\/\//i.test(href)) {
          // 可选尺寸标注，用于消除图片加载导致的布局偏移（CLS）：
          //   ![说明|800x600](url)        ← alt 内管道写法（推荐）
          //   ![说明](url "800x600")      ← title 写法
          // 解析到尺寸则注入 width/height 属性，配合 CSS（max-width:100%;
          // height:auto）浏览器按比例预留占位框，加载后零偏移。
          let captionText = text || ''
          let dims: { w: number; h: number } | null = null
          let titleAttr = ''
          if (title) {
            const tm = title.match(/^(\d+)x(\d+)$/)
            if (tm) dims = { w: parseInt(tm[1], 10), h: parseInt(tm[2], 10) }
            else titleAttr = ` title="${escapeHtml(title)}"`
          }
          if (!dims) {
            const am = captionText.match(/^(.*?)\|(\d+)x(\d+)$/)
            if (am) { captionText = am[1]; dims = { w: parseInt(am[2], 10), h: parseInt(am[3], 10) } }
          }
          const sizeAttr = dims ? ` width="${dims.w}" height="${dims.h}"` : ''
          const alt = escapeHtml(captionText)
          const caption = captionText.trim()
            ? `<figcaption>${escapeHtml(captionText)}</figcaption>` : ''
          return `<figure class="markdown-image"><img src="${escapeHtml(href)}" alt="${alt}"${titleAttr}${sizeAttr} loading="lazy" decoding="async" />${caption}</figure>`
        }
        return `<span class="markdown-image-alt">[图片：${escapeHtml(text || '')}]</span>`
      },

      link(this: unknown, { href, title, tokens }: { href: string; title?: string | null; tokens: Token[] }) {
        // 月品木子取件链接渲染为取件卡片
        const pickup = /^https:\/\//i.test(href) ? pickupCodeFromUrl(href) : null
        if (pickup) {
          const parser0 = (this as { parser: { parseInline: (t: Token[]) => string } }).parser
          return pickupCardHtml(href, pickup, parser0.parseInline(tokens).replace(/<[^>]+>/g, ''))
        }
        const safeHref = /^(https?:|mailto:|\/|#)/i.test(href) ? href : '#'
        const parser = (this as { parser: { parseInline: (t: Token[]) => string } }).parser
        const label = parser.parseInline(tokens)
        const titleAttribute = title ? ` title="${escapeHtml(title)}"` : ''
        return `<a href="${escapeHtml(safeHref)}"${titleAttribute} rel="noreferrer">${label}</a>`
      },

      heading(this: unknown, { tokens, depth }: { tokens: Token[]; depth: number }) {
        const parser = (this as { parser: { parseInline: (t: Token[]) => string } }).parser
        const rendered = parser.parseInline(tokens)
        const slug = slugify(tokensToText(tokens))
        const n = (slugCounts.get(slug) ?? 0) + 1
        slugCounts.set(slug, n)
        const finalSlug = n === 1 ? slug : `${slug}-${n}`
        // headingShift：评论等嵌入场景把 # 抬到 h3 起步，避免与宿主页面 h1/h2 冲突
        const level = Math.min(6, depth + headingShift)
        return `<h${level} id="${finalSlug}">${rendered} <a href="#${finalSlug}" class="anchor" aria-hidden="true">#</a></h${level}>\n`
      },

      code: ({ text, lang }: { text: string; lang?: string }) => {
        const code = escapeHtml(text.replace(/\n$/, ''))
        if (lang && lang.toLowerCase() === 'mermaid') {
          return `<div class="mermaid-source" data-mermaid-graph="1">${code}</div>\n`
        }
        const langStr = (lang || '').match(/^\S*/)?.[0] || ''
        return langStr
          ? `<pre><code class="language-${escapeHtml(langStr)}">${code}</code></pre>\n`
          : `<pre><code>${code}</code></pre>\n`
      },
    },

    // ── marked 扩展 ──
    extensions: [
      // 1. 高亮 ==text==
      {
        name: 'highlight',
        level: 'inline',
        start(src: string) { return src.match(/==/)?.index },
        tokenizer(src: string) {
          const m = /^==([^=\n]+?)==/.exec(src)
          if (!m) return
          const token = {
            type: 'highlight', raw: m[0], text: m[1], tokens: [] as Token[],
          }
          this.lexer.inlineTokens(m[1], token.tokens)
          return token
        },
        renderer(token: Token) {
          const t = token as Token & { tokens: Token[] }
          return `<mark class="markdown-highlight">${this.parser.parseInline(t.tokens)}</mark>`
        },
      },

      // 2. 脚注引用 [^id]
      {
        name: 'footnoteRef',
        level: 'inline',
        start(src: string) { return src.match(/\[\^/)?.index },
        tokenizer(src: string) {
          const m = /^\[\^([^\]]+)\](?!\:)/.exec(src)
          if (!m) return
          const id = m[1]
          if (!footnoteDefs.has(id)) return
          if (!footnoteRefs.includes(id)) footnoteRefs.push(id)
          const num = footnoteRefs.indexOf(id) + 1
          const occ = (refOccurrences.get(id) ?? 0) + 1
          refOccurrences.set(id, occ)
          return {
            type: 'footnoteRef', raw: m[0], id, num, occ,
          }
        },
        renderer(token: Token) {
          const t = token as Token & { id: string; num: number; occ: number }
          const refId = t.occ > 1 ? `fnref-${t.id}-${t.occ}` : `fnref-${t.id}`
          return `<sup class="footnote-ref" id="${refId}"><a href="#fn-${escapeHtml(t.id)}" class="footnote-link">${t.num}</a></sup>`
        },
      },

      // 3. 内部链接 [[slug]] / [[slug#标题]] / [[#标题]] / [[slug|别名]]（Obsidian 语法；^block 引用剥离）
      {
        name: 'internalLink',
        level: 'inline',
        start(src: string) { return src.match(/\[\[/)?.index },
        tokenizer(src: string) {
          const m = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(src)
          if (!m) return
          const rawTarget = m[1].trim().replace(/\^[\w-]+$/, '')
          const hashIndex = rawTarget.indexOf('#')
          const slug = hashIndex >= 0 ? rawTarget.slice(0, hashIndex).trim() : rawTarget
          const anchor = hashIndex >= 0 ? rawTarget.slice(hashIndex + 1).trim() : ''
          const title = (m[2] || (anchor && !slug ? anchor : rawTarget)).trim()
          return {
            type: 'internalLink', raw: m[0], slug, anchor, title,
          }
        },
        renderer(token: Token) {
          const t = token as Token & { slug: string; anchor: string; title: string }
          // [[#标题]] → 当前页锚点；[[slug#标题]] → 文章页 + 标题 slug（与站内 heading id 同一 slugify 口径）
          const href = t.slug
            ? `/posts/${encodeURIComponent(t.slug)}${t.anchor ? `#${slugify(t.anchor)}` : ''}`
            : `#${slugify(t.anchor)}`
          return `<a href="${escapeHtml(href)}" class="internal-link" data-internal-slug="${escapeHtml(t.slug)}">${escapeHtml(t.title)}</a>`
        },
      },

      // 4. Callout 块 > [!type|size](+/-) Title
      {
        name: 'callout',
        level: 'block',
        start(src: string) { return src.match(/^> \[!/m)?.index },
        tokenizer(src: string) {
          const head = /^> \[!(\w+)(?:\|(\w+))?\][ \t]*([+-])?[ \t]*([^\n]*)\n?/.exec(src)
          if (!head) return
          const rawType = head[1].toLowerCase()
          const type = CALLOUT_ALIASES[rawType] ?? rawType
          if (!CALLOUT_TYPES.includes(type as CalloutType)) return
          const size = (head[2] || 'normal').toLowerCase()
          const fold = head[3] || null
          const title = head[4].trim()
          const bodyMatch = /^((?:> ?[^\n]*\n?)+)/.exec(src.slice(head[0].length))
          const bodyRaw = bodyMatch ? bodyMatch[1] : ''
          const inner = bodyRaw.split('\n').map(l => l.replace(/^> ?/, '')).join('\n').replace(/\n+$/, '\n')
          const token = {
            type: 'callout', raw: head[0] + bodyRaw,
            calloutType: type, size, fold, title,
            text: inner, tokens: [] as Token[],
          }
          this.lexer.blockTokens(inner, token.tokens)
          return token
        },
        renderer(token: Token) {
          const t = token as Token & { calloutType: string; size: string; fold: string | null; title: string; tokens: Token[] }
          const icon = `<span class="callout-icon" data-callout-type="${t.calloutType}">${CALLOUT_ICONS[t.calloutType]}</span>`
          const label = t.title ? escapeHtml(t.title) : CALLOUT_LABELS[t.calloutType]
          const titleInner = `${icon}<span class="callout-title-text">${label}</span>`
          const content = `<div class="callout-content">${this.parser.parse(t.tokens)}</div>`
          if (t.fold) {
            return `<details class="callout callout-${t.calloutType} callout-size-${t.size}"${t.fold === '+' ? ' open' : ''}><summary class="callout-title">${titleInner}</summary>${content}</details>`
          }
          return `<div class="callout callout-${t.calloutType} callout-size-${t.size}"><div class="callout-title">${titleInner}</div>${content}</div>`
        },
      },

      // 5. 对齐块 ::: left|center|right
      {
        name: 'align',
        level: 'block',
        start(src: string) { return src.match(/^:::/m)?.index },
        tokenizer(src: string) {
          const m = /^::: (left|center|right)\n([\s\S]*?)\n:::(?:\n|$)/.exec(src)
          if (!m) return
          const token = {
            type: 'align', raw: m[0],
            align: m[1], text: m[2], tokens: [] as Token[],
          }
          this.lexer.blockTokens(m[2], token.tokens)
          return token
        },
        renderer(token: Token) {
          const t = token as Token & { align: string; tokens: Token[] }
          return `<div class="align-${t.align}">${this.parser.parse(t.tokens)}</div>`
        },
      },

      // 6. Obsidian 嵌入徽章 ![[本地文件]]（预处理占位）
      {
        name: 'wikiEmbed',
        level: 'inline',
        start(src: string) { return src.match(/WIKIEMBED/)?.index },
        tokenizer(src: string) {
          const m = /^WIKIEMBED(\d+)ENDWIKIEMBED/.exec(src)
          if (!m || !wikiEmbeds[Number(m[1])]) return
          return { type: 'wikiEmbed', raw: m[0], target: wikiEmbeds[Number(m[1])] }
        },
        renderer(token: Token) {
          const t = token as Token & { target: string }
          const name = (t.target.split('/').pop() || t.target).trim()
          return `<span class="wiki-embed" title="${escapeHtml(t.target)}">${svgIcon('<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>')}<code>${escapeHtml(name)}</code></span>`
        },
      },

      // 7. Obsidian 标签 #tag（预处理占位；站点暂无标签页，渲染为样式徽章而非链接）
      {
        name: 'mdTag',
        level: 'inline',
        start(src: string) { return src.match(/MDTAG/)?.index },
        tokenizer(src: string) {
          const m = /^MDTAG([\s\S]+?)ENDMDTAG/.exec(src)
          if (!m) return
          return { type: 'mdTag', raw: m[0], tag: decodeURIComponent(m[1]) }
        },
        renderer(token: Token) {
          const t = token as Token & { tag: string }
          return `<span class="markdown-tag">#${escapeHtml(t.tag)}</span>`
        },
      },
    ],
  })

  // ── 解析 ──
  let html = marked.parse(withPlaceholders, { async: false }) as string

  // ── 恢复数学公式占位符（不变）──
  html = html
    .replace(/MATHBLOCK(\d+)ENDMATH/g, (_, index) => mathBlocks[Number(index)] ?? '')
    .replace(/MATHINLINE(\d+)ENDMATH/g, (_, index) => mathBlocks[Number(index)] ?? '')

  // ── 恢复引用标记与置信徽章占位符 ──
  html = html
    // 来源条目锚点：跳转目标（scroll-margin 由 CSS 兜底，避免被吸顶栏遮挡）
    .replace(/CITEDEF(\d+)ENDCITEDEF/g, (_m, id: string) =>
      `<span id="cite-${id}" class="cite-def">[${id}]</span>`)
    // 正文上标引用：有对应来源条目时链接到锚点，备注进 title
    .replace(/CITEREF(\d+)ENDCITEREF/g, (_m, index: string) => {
      const ref = citeRefs[Number(index)]
      if (!ref) return ''
      const title = ref.note ? ` title="${escapeHtml(ref.note)}"` : ''
      const inner = citeDefs.has(ref.id)
        ? `<a href="#cite-${ref.id}"${title}>${ref.id}</a>`
        : String(ref.id)
      return `<sup class="cite-ref"${title}>${inner}</sup>`
    })
    // 置信徽章：按语义上色（confirmed=accent、majority=purple、single-source=orange、
    // unverified/insufficient=muted、disputed=red）
    .replace(/CONFBADGE(\d+)ENDCONFBADGE/g, (_m, index: string) => {
      const raw = confBadges[Number(index)]
      if (!raw) return ''
      const key = raw.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-+|-+$/g, '')
      const mod = key.startsWith('disputed') ? 'disputed' : key
      return `<span class="conf-badge conf-${mod}">${escapeHtml(raw)}</span>`
    })

  // ── 后处理：追加脚注章节 ──
  if (footnoteRefs.length > 0) {
    const items = footnoteRefs.map((id) => {
      const def = footnoteDefs.get(id) || ''
      const defHtml = marked.parse(def, { async: false }) as string
      const inner = defHtml.replace(/^<p>([\s\S]*)<\/p>\n?$/, '$1')
      return `<li id="fn-${escapeHtml(id)}" class="footnote-item">${inner}<a href="#fnref-${escapeHtml(id)}" class="footnote-back" aria-label="返回正文">↩</a></li>`
    }).join('\n')
    html += `<section class="footnotes-section"><hr><ol>${items}</ol></section>`
  }

  // ── 表情包 shortcode（不变）──
  html = renderStickerShortcode(html)

  return html
}
