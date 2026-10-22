// 风险校验：stressHtml 会替换整段 HTML 里的「元音+U+0301」。
// 若 <code>/<pre>（代码或字面文本）内含重音符，也会被注入 <span>，
// 使「字面显示」的文本被加上下划线高亮 —— 需确认是否存在这种情况。
import fs from 'node:fs'
import path from 'node:path'
import { renderMarkdown } from '../src/lib/markdown'

const DIR = 'content/russian-lessons'
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.md')).sort()

let inCode = 0
let inMath = 0
for (const f of files) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8')
  const html = renderMarkdown(src, 1)

  // 行内/块级代码里的重音符
  for (const m of html.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)) {
    if (m[1].includes('\u0301')) { inCode++; if (inCode <= 8) console.log(`CODE ${f}: ${m[1].slice(0, 90)}`) }
  }
  for (const m of html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)) {
    if (m[1].includes('\u0301')) { inCode++; if (inCode <= 8) console.log(`PRE  ${f}: ${m[1].slice(0, 90)}`) }
  }
  // KaTeX 输出里出现西里尔重音（说明数学块里写了俄语）
  if (/\$[^$]*\u0301[^$]*\$/.test(src)) inMath++
}

console.log(`\nstress marks inside <code>/<pre> = ${inCode}`)
console.log(`source lines with $-math containing stress = ${inMath}`)
console.log(inCode === 0 ? 'SAFE: no code block affected' : 'NOTE: review the above')
// 全站范围也看一眼（不止课程精讲）
let siteCode = 0
const walk = (d: string) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.mdx?$/.test(e.name)) {
      try {
        const h = renderMarkdown(fs.readFileSync(p, 'utf8'), 1)
        for (const m of h.matchAll(/<(?:code|pre)[^>]*>([\s\S]*?)<\/(?:code|pre)>/g)) {
          if (m[1].includes('\u0301')) { siteCode++; console.log(`SITE ${p}`) }
        }
      } catch { /* ignore */ }
    }
  }
}
walk('content')
console.log(`\nsite-wide rendered code blocks with U+0301 = ${siteCode}`)