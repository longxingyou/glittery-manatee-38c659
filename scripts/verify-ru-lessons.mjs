// 校验：构建产物中的重音符能否全部被 stressHtml 正确转为 <span class="stressed">
// 用法: node scripts/verify-ru-lessons.mjs
import fs from 'node:fs'
import path from 'node:path'

const dir = 'dist/client/assets'
const files = fs.readdirSync(dir).filter((f) => f.startsWith('russian-lessons') && f.endsWith('.js'))
if (files.length === 0) {
  console.error('未找到 russian-lessons 构建产物，请先 pnpm run build')
  process.exit(1)
}

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