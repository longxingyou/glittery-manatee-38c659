// 校验课内小节导航：渲染结果里的 h2–h5 是否都带 id、id 是否唯一、
// 且不含重音符（CSS.escape 与 #id 选择器都能正常工作）。
// h2/h3 是文章页正文口径；课程精讲用 renderMarkdown(src, 1) 渲染，
// 标题整体下移一级，大纲实际抓的是 h3–h5，所以这里一并覆盖到 h5。
// 同时统计每课的小节数，确认导航对最长的 Урок 10/12 也够用。
import fs from 'node:fs'
import path from 'node:path'
import { renderMarkdown } from '../src/lib/markdown'

const DIR = 'content/russian-lessons'
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.md')).sort()

let fail = 0
for (const f of files) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8')
  const html = renderMarkdown(src, 1)
  const tags = [...html.matchAll(/<h([2-5])([^>]*)>([\s\S]*?)<\/h\1>/g)]
  const ids: string[] = []
  let noId = 0
  let withStress = 0
  let emptyId = 0
  for (const t of tags) {
    const m = /id="([^"]*)"/.exec(t[2]!)
    if (!m) { noId++; continue }
    if (!m[1]) { emptyId++; continue }
    if (m[1].includes('\u0301')) withStress++
    ids.push(m[1])
  }
  const dup = ids.length - new Set(ids).size
  const ok = noId === 0 && emptyId === 0 && withStress === 0 && dup === 0
  if (!ok) fail++
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${f.padEnd(22)} h2-h5=${String(tags.length).padStart(3)} ` +
    `noId=${noId} emptyId=${emptyId} stressInId=${withStress} dupId=${dup}`,
  )
}
console.log(fail === 0 ? '\nTOC_OK=true' : `\nTOC_OK=false (${fail})`)
process.exit(fail === 0 ? 0 : 1)