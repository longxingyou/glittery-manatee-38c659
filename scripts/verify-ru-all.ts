// 课程精讲：一键跑完全部校验。
// 用法: node_modules/.bin/tsx scripts/verify-ru-all.ts
//
// 覆盖 6 类风险：
//   1. render  —— 15 份 .md 能否被站点渲染器正确渲染（callout/表格/标题层级/重音符不丢）
//   2. lessons —— 构建产物里重音符能否全部转成 <span class="stressed">（无残留、无辅音错标）
//   3. toc     —— 课内导航的标题 id 是否齐备、唯一、不含重音符
//   4. lessons-outline —— 课程精讲大纲的提取层级（renderMarkdown(src,1) 后实际在 h3–h5，
//                        若按文章页的 h2–h4 抓会整体漏掉一级小节）
//   5. structure —— 注入 span 后 HTML 标签是否仍然配对
//   6. callout-regression —— markdown.ts 正则改动对全站其它 Markdown 的影响
import { spawnSync } from 'node:child_process'

// Windows 上 .CMD 批处理无法直接 spawn（EINVAL），必须经 shell 启动；
// 且经 shell 时不能用带正斜杠的路径（cmd 会把它当命令名解析失败），
// 因此用反斜杠 + .CMD。
const TSX = process.platform === 'win32' ? 'node_modules\\.bin\\tsx.CMD' : 'node_modules/.bin/tsx'
const runTsx = (script: string) =>
  spawnSync(TSX, [script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: true })

const CHECKS: Array<[string, string]> = [
  ['render', 'scripts/verify-ru-render.ts'],
  ['structure', 'scripts/verify-structure.ts'],
  ['toc', 'scripts/verify-toc.ts'],
  ['lessons-outline', 'scripts/verify-lessons-outline.ts'],
  ['attr-safety', 'scripts/verify-attr-safety.ts'],
  ['codeblock-safety', 'scripts/verify-codeblock-safety.ts'],
  ['callout-regression', 'scripts/verify-callout-regression.ts'],
]

let failed = 0
for (const [name, script] of CHECKS) {
  const r = runTsx(script)
  const ok = r.status === 0
  if (!ok) failed++
  const tail = (r.stdout || '').trim().split('\n').slice(-1)[0] || ''
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(20)} ${tail}`)
  if (!ok) console.log((r.stdout || '').split('\n').filter((l) => l.startsWith('FAIL')).join('\n'))
}

// render 脚本全绿时还会打印 ALL_CLEAN=true，单独确认一次
const r = runTsx('scripts/verify-ru-render.ts')
const renderClean = (r.stdout || '').includes('ALL_CLEAN=true')
if (!renderClean) failed++
console.log(`${renderClean ? 'PASS' : 'FAIL'}  render ALL_CLEAN flag`)

// 构建产物侧的校验（js，不是 ts）
const r2 = spawnSync(process.execPath, ['scripts/verify-ru-lessons.mjs'], { encoding: 'utf8' })
const buildOk = r2.status === 0
if (!buildOk) failed++
console.log(`${buildOk ? 'PASS' : 'FAIL'}  ${'built-assets'.padEnd(20)} ${(r2.stdout || '').trim().split('\n').slice(-1)[0] || ''}`)

console.log(failed === 0 ? '\n=== ALL CHECKS PASSED ===' : `\n=== ${failed} CHECK(S) FAILED ===`)
process.exit(failed === 0 ? 0 : 1)