// 用站点真实的 renderMarkdown 渲染 15 份课程精讲，检验：
//   1) 不抛错（callout / 表格 / 标题 全部可解析）
//   2) 重音符（U+0301）能被 stressHtml 的规则全部转换，无残留
//   3) callout 数量与源文一致（答案折叠依赖 .callout / .callout-title-text）
//   4) 标题层级不与页面 h1 冲突（headingShift=1）
// 用法: node_modules/.bin/tsx scripts/verify-ru-render.ts
import fs from 'node:fs'
import path from 'node:path'
import { renderMarkdown } from '../src/lib/markdown'

const DIR = 'content/russian-lessons'
const RU_STRESS_RE = /([АЕИОУЫЭЮЯаеиоуыэюяЁё])\u0301/g
const stressHtml = (h: string) => h.replace(RU_STRESS_RE, '<span class="stressed">$1</span>')

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.md')).sort()
let fail = 0

for (const f of files) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8')
  let html = ''
  let err = ''
  try {
    html = renderMarkdown(src, 1)
  } catch (e) {
    err = (e as Error).message
  }
  if (err) {
    fail++
    console.log(`FAIL ${f}  render threw: ${err}`)
    continue
  }

  const out = stressHtml(html)
  const srcMarks = (src.match(/\u0301/g) || []).length
  const leftover = (out.match(/\u0301/g) || []).length
  const spans = (out.match(/<span class="stressed">/g) || []).length

  // 源里的 callout 头数量 vs 渲染出的 callout 块数量
  // 每个 callout 渲染为 `class="callout callout-<type> callout-size-<size>"`，
  // 内部还嵌套 callout-title / callout-icon / callout-content 等，故须精确匹配块容器
  const srcCallouts = (src.match(/^>\s*\[!\w+\]/gm) || []).length
  const outCallouts = (html.match(/class="callout callout-\w+ callout-size-\w+"/g) || []).length
  const srcFolded = (src.match(/^>\s*\[!\w+\][+-]/gm) || []).length
  const outFolded = (html.match(/<details class="callout /g) || []).length
  // 折叠逻辑依赖这个标题元素
  const titleEls = (html.match(/callout-title-text/g) || []).length

  // 表格
  const srcTables = (src.match(/^\|/gm) || []).length
  const outTables = (html.match(/<table>/g) || []).length

  // 标题不得出现 h1（headingShift=1 应把 # → h2）
  const h1 = (html.match(/<h1[ >]/g) || []).length

  // 表格结构：源里每行的竖线数必须与表头一致。
  // 单元格内出现未转义的 | 会把该行截断，导致后半段文字被吞掉（曾丢一个重音符）。
  const lines = src.split('\n')
  const ragged: number[] = []
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim()
    if (!t.startsWith('|')) continue
    const prev = (lines[i - 1] || '').trim()
    if (!prev.startsWith('|')) continue
    const bars = (t.match(/\|/g) || []).length
    const prevBars = (prev.match(/\|/g) || []).length
    // 表头分隔行（|---|）与表头竖线数一致，正常；仅在「数据行竖线多于表头」时报错
    if (bars > prevBars && !/^\|[\s:|-]+\|$/.test(prev)) ragged.push(i + 1)
  }

  const ok =
    leftover === 0 &&
    spans === srcMarks &&
    srcCallouts === outCallouts &&
    titleEls === outCallouts &&
    srcFolded === outFolded &&
    h1 === 0 &&
    ragged.length === 0
  if (!ok) fail++

  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${f.padEnd(22)} marks=${String(srcMarks).padStart(5)} spans=${String(spans).padStart(5)} ` +
    `leftover=${leftover} callout ${srcCallouts}->${outCallouts} (titleEl=${titleEls}) ` +
    `folded ${srcFolded}->${outFolded} tableRows=${srcTables} tables=${outTables} h1=${h1} ragged=${ragged.length}`,
  )
  if (ragged.length) console.log('       ragged table lines:', ragged.join(', '))
}

console.log(fail === 0 ? '\nALL_CLEAN=true' : `\nALL_CLEAN=false (${fail} failed)`)
process.exit(fail === 0 ? 0 : 1)