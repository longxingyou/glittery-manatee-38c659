// 回归校验：markdown.ts 的 callout 头正则改动会影响全站所有 Markdown。
// 对比「改动前」与「改动后」两种正则，列出会被解析为折叠块的行，
// 确认差异只发生在「] 与 +/- 之间有空格」的写法上，且这些行都属于标题而非折叠标记。
// 用法: node_modules/.bin/tsx scripts/verify-callout-regression.ts
import fs from 'node:fs'
import path from 'node:path'
import { renderMarkdown } from '../src/lib/markdown'

const OLD = /^> \[!(\w+)(?:\|(\w+))?\][ \t]*([+-])?[ \t]*([^\n]*)\n?/
const NEW = /^> \[!(\w+)(?:\|(\w+))?\](?:([+-])(?=[ \t]|$))?[ \t]*([^\n]*)\n?/

const roots = ['content']
const files: string[] = []
const walk = (d: string) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.mdx?$/.test(e.name)) files.push(p)
  }
}
roots.forEach(walk)

let diffs = 0
let checked = 0
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8')
  for (const line of s.split('\n')) {
    if (!line.startsWith('>')) continue
    const o = OLD.exec(line)
    const n = NEW.exec(line)
    if (!o && !n) continue
    checked++
    const oFold = o?.[3] ?? null
    const nFold = n?.[3] ?? null
    const oTitle = o?.[4] ?? ''
    const nTitle = n?.[4] ?? ''
    if (oFold !== nFold || oTitle !== nTitle) {
      diffs++
      console.log(`DIFF ${f}`)
      console.log(`   line : ${line.trim()}`)
      console.log(`   old  : fold=${JSON.stringify(oFold)} title=${JSON.stringify(oTitle)}`)
      console.log(`   new  : fold=${JSON.stringify(nFold)} title=${JSON.stringify(nTitle)}`)
    }
  }
}
console.log(`\ncallout-looking lines checked = ${checked}, behaviour changed = ${diffs}`)

// 被新正则判定为「标题以 -/+ 开头」的都应是词素类标题，不是折叠意图
console.log('\n--- lines now treated as plain titles (were mis-parsed as folded) ---')
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8')
  for (const line of s.split('\n')) {
    const o = OLD.exec(line)
    const n = NEW.exec(line)
    if (o?.[3] && !n?.[3]) console.log(`  ${f}: ${line.trim()}`)
  }
}
// 渲染冒烟：确保不抛错
for (const f of files.slice(0, 400)) {
  renderMarkdown(fs.readFileSync(f, 'utf8'), 1)
}
console.log('\nrender smoke on', Math.min(files.length, 400), 'files: no throw')