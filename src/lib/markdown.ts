import katex from 'katex'
import { marked, Renderer } from 'marked'

const escapeHtml = (value: string) =>
  value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character]!)

const renderer = new Renderer()

renderer.html = ({ text }) => escapeHtml(text)
renderer.image = ({ text }) => `<span class="markdown-image-alt">[图片：${escapeHtml(text)}]</span>`
renderer.link = ({ href, title, tokens }) => {
  const safeHref = /^(https?:|mailto:|\/|#)/i.test(href) ? href : '#'
  const label = renderer.parser.parseInline(tokens)
  const titleAttribute = title ? ` title="${escapeHtml(title)}"` : ''
  return `<a href="${escapeHtml(safeHref)}"${titleAttribute} rel="noreferrer">${label}</a>`
}

export function renderMarkdown(source: string) {
  const mathBlocks: string[] = []
  const withPlaceholders = source
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, expression: string) => {
      const index = mathBlocks.push(katex.renderToString(expression.trim(), {
        displayMode: true,
        throwOnError: false,
        strict: false,
      })) - 1
      return `\n\nMATHBLOCK${index}ENDMATH\n\n`
    })
    .replace(/(?<!\$)\$([^\n$]+?)\$(?!\$)/g, (_, expression: string) => {
      const index = mathBlocks.push(katex.renderToString(expression.trim(), {
        displayMode: false,
        throwOnError: false,
        strict: false,
      })) - 1
      return `MATHINLINE${index}ENDMATH`
    })

  let html = marked.parse(withPlaceholders, { renderer, gfm: true, breaks: true }) as string
  html = html
    .replace(/MATHBLOCK(\d+)ENDMATH/g, (_, index) => mathBlocks[Number(index)] ?? '')
    .replace(/MATHINLINE(\d+)ENDMATH/g, (_, index) => mathBlocks[Number(index)] ?? '')

  return html
}
