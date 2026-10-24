// 用真实的渲染管线（renderMarkdown + extractHeadingsFromHtml）离线验证：
// 全局词表是否也会生成足够的大纲条目（ArticleOutline 仅在 ≥2 个标题时渲染）。
// 这比再写一套 CDP 脚本可靠：纯字符串、SSR 口径、可重复。
import fs from 'node:fs'
import path from 'node:path'
import { renderMarkdown, extractHeadingsFromHtml } from '../src/lib/markdown.ts'

const DIR = process.argv[2] || path.resolve(process.cwd(), 'content/russian-lessons')
const BODY_MIN_LEVEL = 3
const BODY_MAX_LEVEL = 5

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.md')).sort()
const report = []
let bad = 0

for (const f of files) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8')
  // 与 russian-lessons.tsx 完全一致：renderMarkdown(src, 1)
  const html = renderMarkdown(src, 1)
  const hs = extractHeadingsFromHtml(html, BODY_MIN_LEVEL, BODY_MAX_LEVEL)
  const levels = [...new Set(hs.map((h) => h.level))].sort()
  const ok = hs.length >= 2 && hs.every((h) => h.level >= BODY_MIN_LEVEL && h.level <= BODY_MAX_LEVEL)
  if (!ok) bad++
  report.push({
    file: f,
    headings: hs.length,
    levels,
    renders: ok,
    first3: hs.slice(0, 3).map((h) => h.text),
  })
}

console.log(JSON.stringify({ total: files.length, notRendering: bad, files: report }, null, 2))
process.exit(bad === 0 ? 0 : 1)