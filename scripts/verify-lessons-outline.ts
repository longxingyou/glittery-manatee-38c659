// 校验课程精讲的大纲提取口径：正文用 renderMarkdown(src, 1) 渲染，
// 标题整体下移一级（源 ## → h3）。若按文章页默认的 h2–h4 提取，
// 每课的一级小节（源 ##）会被整体漏掉、大纲只剩二级条目。
// 这里对每个文件断言：h3–h5 口径取到的**最浅一层恰好对应源 ## 的小节数**。
import fs from 'node:fs'
import path from 'node:path'
import { renderMarkdown, extractHeadingsFromHtml } from '../src/lib/markdown'

const DIR = 'content/russian-lessons'
const BODY_MIN = 3
const BODY_MAX = 5
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.md')).sort()

let fail = 0
for (const f of files) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8')
  // 与组件同口径：组件用 renderMarkdown(src, 1) 渲染后再 stressHtml 转重音 span。
  // 重音 span 只影响标题内部文本的标签，不影响 id 与纯文本（extractHeadingsFromHtml
  // 会剥掉标签），故此处只跑 markdown 渲染即可验证提取口径。
  const html = renderMarkdown(src, 1)
  const body = extractHeadingsFromHtml(html, BODY_MIN, BODY_MAX)

  // 源文件里 ## 小节数 —— 这是大纲「一级条目」应有的个数
  const srcSections = (src.match(/^## /gm) ?? []).length
  const topCount = body.filter((h) => h.level === BODY_MIN).length

  const problems: string[] = []
  // 所有内容文件都应有 ≥2 个小节，否则大纲按钮不会出现
  if (body.length < 2) problems.push(`sections=${body.length}(<2)`)
  // 每个 id 必须真实存在于 HTML，否则跳转会落空
  const missing = body.filter((h) => !html.includes(`id="${h.id}"`)).length
  if (missing) problems.push(`missingId=${missing}`)
  // 层级必须落在 h3–h5 内
  const levels = [...new Set(body.map((h) => h.level))].sort()
  if (levels.length && (levels[0]! < BODY_MIN || levels[levels.length - 1]! > BODY_MAX)) {
    problems.push(`levels=[${levels}]`)
  }
  // 关键断言：最浅一层 = 源 ## 小节数（漏掉一级小节时这里会立刻掉下来）
  if (topCount !== srcSections) problems.push(`topLevel=${topCount}(≠src##${srcSections})`)

  const ok = problems.length === 0
  if (!ok) fail++
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${f.padEnd(22)} outline=${String(body.length).padStart(3)} ` +
    `levels=[${levels}] src##=${String(srcSections).padStart(2)} top=${topCount} ${problems.join(' ')}`,
  )
}
console.log(fail === 0 ? '\nLESSONS_OUTLINE_OK=true' : `\nLESSONS_OUTLINE_OK=false (${fail})`)
process.exit(fail === 0 ? 0 : 1)