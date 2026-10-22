// 结构校验：stressHtml 会在 <code>/<pre>/<table> 等任何文本节点内注入
// <span class="stressed">。本脚本用 HTMLParser 检查渲染结果的标签是否成对闭合，
// 以确认注入没有破坏文档结构（尤其「span 插进 code 内部」这类情况）。
import fs from 'node:fs'
import path from 'node:path'
import { renderMarkdown } from '../src/lib/markdown'

const DIR = 'content/russian-lessons'
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.md')).sort()
const RU_STRESS_RE = /([АЕИОУЫЭЮЯаеиоуыэюяЁё])\u0301/g
const stressHtml = (h: string) => h.replace(RU_STRESS_RE, '<span class="stressed">$1</span>')

// 简易栈式校验（只关心本脚本注入的 span 是否配对，以及整体 div/details 平衡）
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'path', 'circle', 'line', 'polyline', 'polygon', 'rect', 'use', 'stop', 'col'])

function check(html: string, label: string) {
  const stack: string[] = []
  const bad: string[] = []
  const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g
  let m
  while ((m = re.exec(html))) {
    const closing = m[1] === '/'
    const tag = m[2]!.toLowerCase()
    const selfClose = m[4] === '/'
    if (VOID.has(tag) || selfClose) continue
    if (!closing) stack.push(tag)
    else {
      const top = stack.pop()
      if (top !== tag) bad.push(`</${tag}> closed <${top ?? 'nothing'}>`)
    }
  }
  const unclosed = stack.filter((t) => t !== 'body')
  const ok = bad.length === 0 && unclosed.length === 0
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label.padEnd(24)} unclosed=${unclosed.length} mismatch=${bad.length}`)
  if (!ok) {
    if (unclosed.length) console.log('   unclosed:', unclosed.slice(0, 8).join(','))
    if (bad.length) console.log('   mismatch:', bad.slice(0, 5).join(' | '))
  }
  return ok
}

let all = true
for (const f of files) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8')
  const html = stressHtml(renderMarkdown(src, 1))
  all = check(html, f) && all
}
console.log(all ? '\nSTRUCTURE_OK=true' : '\nSTRUCTURE_OK=false')
process.exit(all ? 0 : 1)