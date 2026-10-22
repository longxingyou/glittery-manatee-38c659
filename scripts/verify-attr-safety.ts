// 风险校验：stressHtml 是对 renderMarkdown 产出的整段 HTML 做正则替换。
// 若 renderMarkdown 把「含重音符的标题文本」写进属性（如 heading id），
// 替换就会把 <span> 注入属性内部，破坏 HTML。
// 本脚本检出：渲染结果里任何「属性值内出现重音符」的情况。
import fs from 'node:fs'
import path from 'node:path'
import { renderMarkdown } from '../src/lib/markdown'

const DIR = 'content/russian-lessons'
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.md')).sort()

let attrHits = 0
let srcHeadingStressed = 0
for (const f of files) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8')
  const html = renderMarkdown(src, 1)

  // 源里带重音符的标题行
  for (const line of src.split('\n')) {
    if (/^#{1,6}\s/.test(line) && line.includes('\u0301')) {
      srcHeadingStressed++
      console.log(`HEADING-with-stress ${f}: ${line.trim().slice(0, 80)}`)
    }
  }

  // 属性值内含重音符 → 危险
  for (const m of html.matchAll(/[a-zA-Z-]+="([^"]*)"/g)) {
    if (m[1].includes('\u0301')) {
      attrHits++
      if (attrHits <= 25) {
        console.log(`ATTR-STRESS ${f}: ${m[0].slice(0, 120)}`)
      }
    }
  }
}

console.log(`\nstressed source headings = ${srcHeadingStressed}`)
console.log(`attributes containing U+0301 = ${attrHits}`)

// 同时确认 id 属性的实际形态（观察标题如何生成锚点）
const sample = renderMarkdown(fs.readFileSync(path.join(DIR, '10-urok-10.md'), 'utf8'), 1)
const ids = [...sample.matchAll(/<h[1-6][^>]*>/g)].slice(0, 12).map((m) => m[0])
console.log('\nsample heading tags:')
console.log(ids.join('\n'))

// 判定行必须放最后：一键脚本取 stdout 末行作为摘要，
// 若把样例标题留在末尾，摘要会显示成标题而看不出结论。
console.log(attrHits === 0
  ? `SAFE: stressHtml cannot corrupt attributes (attr=${attrHits}, stressedHeadings=${srcHeadingStressed})`
  : 'UNSAFE: fix needed')
process.exit(attrHits === 0 ? 0 : 1)