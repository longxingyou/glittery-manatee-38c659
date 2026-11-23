// 从 Unihan 生成精简「汉字→拼音（数字声调）」映射，供 fetch-element-audio.mjs 同音字阶段使用。
// 收录全部 CJK 统一表意文字区（含扩展 B–H），以覆盖 𬬻/𬬭 等扩展区元素名。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const UNIHAN = path.join(os.tmpdir(), 'Unihan', 'Unihan_Readings.txt')
const OUT = path.join(process.cwd(), 'scripts', 'data', 'hanzi-pinyin.json')

const TONE = {
  ā: ['a', 1], á: ['a', 2], ǎ: ['a', 3], à: ['a', 4],
  ē: ['e', 1], é: ['e', 2], ě: ['e', 3], è: ['e', 4],
  ī: ['i', 1], í: ['i', 2], ǐ: ['i', 3], ì: ['i', 4],
  ō: ['o', 1], ó: ['o', 2], ǒ: ['o', 3], ò: ['o', 4],
  ū: ['u', 1], ú: ['u', 2], ǔ: ['u', 3], ù: ['u', 4],
  ǖ: ['v', 1], ǘ: ['v', 2], ǚ: ['v', 3], ǜ: ['v', 4], ü: ['v', 5],
  ń: ['n', 2], ň: ['n', 3], ǹ: ['n', 4], ḿ: ['m', 2],
}
function normPinyin(s) {
  let out = '', tone = 0
  for (const ch of String(s).toLowerCase().trim()) {
    if (TONE[ch]) { out += TONE[ch][0]; tone = TONE[ch][1] }
    else if (/[1-5]/.test(ch)) tone = Number(ch)
    else if (/[a-z]/.test(ch)) out += ch
  }
  if (!out || !tone) return ''
  return out + tone
}

const map = {}
for (const line of fs.readFileSync(UNIHAN, 'utf8').split('\n')) {
  if (!line || line[0] === '#') continue
  const [cp, field, val] = line.split('\t')
  if (!field || !field.startsWith('kMandarin') || !val) continue
  const code = parseInt(cp.replace('U+', ''), 16)
  // 排除 CJK 兼容表意文字（F900–FAFF 等）：同一字的另一种编码，重复无益
  if (code >= 0xf900 && code <= 0xfaff) continue
  const ch = String.fromCodePoint(code)
  if (map[ch]) continue // 已有 zh-Hans 优先
  const py = normPinyin(val.trim().split(/\s+/)[0])
  if (py) map[ch] = py
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(map))
const size = fs.statSync(OUT).size
console.log(`写入 ${OUT}: ${Object.keys(map).length} 字, ${(size / 1024).toFixed(0)} KB`)
// 抽查元素字
for (const ch of ['钠', '镁', '锰', '钴', '镍', '汞', '鿫', '𬬭']) console.log(`  ${ch} → ${map[ch] ?? '(未收录)'}`)
