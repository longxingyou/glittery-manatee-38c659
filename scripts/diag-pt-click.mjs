import { chromium } from 'playwright'

const URL = process.env.PT_URL || 'https://wow.xn--fpr224a.mom/periodic-table'
const b = await chromium.launch({ headless: true })
const p = await b.newPage({ viewport: { width: 375, height: 812 } })

const allConsole = []
const pageErrors = []
p.on('console', m => allConsole.push(`[${m.type()}] ${m.text()}`))
p.on('pageerror', e => pageErrors.push(String(e)))

const t0 = Date.now()
await p.goto(URL, { waitUntil: 'load', timeout: 90000 })
console.log(`load event: ${Date.now() - t0}ms`)

// 等水合完成：booted 标记（组件挂载后会设）+ 稳定 1s
await p.waitForTimeout(2500)
console.log(`post-wait: ${Date.now() - t0}ms`)

// 点击碳元素
let clickOk = false
try {
  await p.locator('.ru-el[data-z="6"]').click({ timeout: 10000 })
  await p.waitForSelector('.ru-el-detail-panel', { timeout: 8000 })
  clickOk = true
} catch (e) {
  console.log('点击失败:', e.message)
}
console.log(`点击碳元素: ${clickOk ? '✓' : '✗'}`)

// 看详情面板里是否有碳的符号
if (clickOk) {
  const sym = await p.locator('.ru-el-detail-sym').innerText().catch(() => '?')
  console.log(`详情面板符号: ${sym}`)
}

console.log(`\n=== 所有 console (${allConsole.length}) ===`)
for (const l of allConsole.slice(0, 30)) console.log(l)
console.log(`\n=== pageerror (${pageErrors.length}) ===`)
for (const e of pageErrors) console.log(e)

await b.close()
