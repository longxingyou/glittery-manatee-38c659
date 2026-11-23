// 校验：构建产物中的重音符能否全部被 stressHtml 正确转为 <span class="stressed">
// 用法: node scripts/verify-ru-lessons.mjs
//
// ★ 扫描范围：**每一课/每一篇讲义的独立 chunk**。
// 早期 lessons.ts 是 `eager: true`，所有 md 打成一个 `russian-lessons-*.js`；
// 现在改成 `eager: false`（首屏只带元数据、正文按需加载），每份 md 各自成一个 chunk，
// 文件名就是 md 的文件名（如 `01-urok-1-XXXX.js`、`chem-05-zanyatie-5-XXXX.js`、
// `b03-urok-3-XXXX.js`）。所以旧的「只找 russian-lessons 前缀」会永远找不到文件，
// 报「请先 pnpm run build」——那是**检查器的假失败**，不是构建问题。
//
// 这里的判据改为：凡是「看起来像讲义 chunk」的都检查，来源有三类：
//   1) 俄语主教材        NN-urok-N-*.js
//   2) Базовый           bNN-urok-N-*.js
//   3) 化学讲义          chem-*.js
// 另外仍兼容旧的单一 chunk（russian-lessons*），以便回退到 eager 模式时照常工作。
import fs from 'node:fs'
import path from 'node:path'

const dir = 'dist/client/assets'
if (!fs.existsSync(dir)) {
  console.error('未找到 dist/client/assets，请先 pnpm run build')
  process.exit(1)
}

const all = fs.readdirSync(dir).filter((f) => f.endsWith('.js'))
const isLessonChunk = (f) =>
  f.startsWith('russian-lessons') || // 旧版单一 chunk（兼容）
  /^\d{2}-urok-\d+/.test(f) || // Э：01-urok-1-XXXX.js
  /^b\d{2}-urok-\d+/.test(f) || // Б：b01-urok-1-XXXX.js
  /^\d{2}-(words-by|key-compendium)/.test(f) || // Э 总表
  /^b\d{2}-(words-by|key-compendium|overview)/.test(f) || // Б 总表
  (f.startsWith('chem-') && f.length > 8) // 化学讲义

const files = all.filter(isLessonChunk)
if (files.length === 0) {
  console.error('未找到任何讲义 chunk，请先 pnpm run build')
  process.exit(1)
}
console.log(`扫描 ${files.length} 个讲义 chunk（共 ${all.length} 个 js 产物）`)

const VOW = 'АЕИОУЫЭЮЯаеиоуыэюяЁё'
const RU_STRESS_RE = /([АЕИОУЫЭЮЯаеиоуыэюяЁё])\u0301/g

let fail = 0
for (const f of files) {
  const raw = fs.readFileSync(path.join(dir, f), 'utf8')
  // 排除组件自身的替换模板字面量 `'<span class="stressed">$1</span>'`：
  // 它不是内容，但会干扰下面的 span 计数
  const TEMPLATE_LITERAL = '<span class="stressed">$1</span>'
  const s = raw.split(TEMPLATE_LITERAL).join('')

  // 1) 统计重音符总数与「贴在辅音上」的错标
  const pairRe = /([\u0400-\u04FF])\u0301/g
  let m
  let total = 0
  const odd = {}
  while ((m = pairRe.exec(s))) {
    total++
    if (!VOW.includes(m[1])) odd[m[1]] = (odd[m[1]] || 0) + 1
  }
  const oddCount = Object.values(odd).reduce((a, b) => a + b, 0)

  // 2) 模拟组件里的 stressHtml
  const html = s.replace(RU_STRESS_RE, '<span class="stressed">$1</span>')
  const spans = (html.match(/<span class="stressed">/g) || []).length
  const leftover = (html.match(/\u0301/g) || []).length

  // 3) 每个 span 内应恰好是一个元音
  const inner = html.match(/<span class="stressed">(.)/g) || []
  const badInner = inner.filter((x) => !VOW.includes(x.slice(-1))).length

  const ok = oddCount === 0 && leftover === 0 && spans === total && badInner === 0
  if (!ok) fail++
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${f}\n` +
    `       U+0301=${total}  consonant-attached=${oddCount}  spans=${spans}  leftover=${leftover}  bad-span=${badInner}`,
  )
  if (oddCount) console.log('       odd chars:', JSON.stringify(odd))
}

console.log(fail === 0 ? '\nALL_CLEAN=true' : `\nALL_CLEAN=false (${fail} failed)`)
process.exit(fail === 0 ? 0 : 1)