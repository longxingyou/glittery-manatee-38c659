import { chromium } from 'playwright'

const URL = process.env.PT_URL || 'https://wow.xn--fpr224a.mom/periodic-table'
const b = await chromium.launch({ headless: true })
const p = await b.newPage({ viewport: { width: 375, height: 812 } })

const errors = []
const requests = []
p.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
p.on('request', r => requests.push({ url: r.url(), type: r.resourceType() }))

const t0 = Date.now()
const resp = await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
const tDom = Date.now() - t0

// 等待元素表出现
let tInteractive = null
try {
  await p.waitForSelector('.ru-el', { timeout: 30000 })
  tInteractive = Date.now() - t0
} catch (e) {
  errors.push('元素表未在 30s 内出现: ' + e.message)
}

// 尝试点击碳元素，检测是否可交互
let clickOk = false
try {
  await p.locator('.ru-el[data-z="6"]').click({ timeout: 10000 })
  await p.waitForSelector('.ru-el-detail-panel', { timeout: 5000 })
  clickOk = true
} catch (e) {
  errors.push('点击碳元素失败: ' + e.message)
}

// 资源统计
const resources = await p.evaluate(() => {
  const entries = performance.getEntriesByType('resource')
  return entries.map(e => ({
    name: e.name.split('/').pop().slice(0, 50),
    type: e.initiatorType,
    size: Math.round(e.transferSize / 1024),
    dur: Math.round(e.duration),
  })).sort((a, b) => b.dur - a.dur).slice(0, 15)
})

// 导航计时
const nav = await p.evaluate(() => {
  const n = performance.getEntriesByType('navigation')[0]
  return n ? {
    dns: Math.round(n.domainLookupEnd - n.domainLookupStart),
    tcp: Math.round(n.connectEnd - n.connectStart),
    ttfb: Math.round(n.responseStart - n.requestStart),
    download: Math.round(n.responseEnd - n.responseStart),
    domReady: Math.round(n.domContentLoadedEventEnd - n.startTime),
    load: Math.round(n.loadEventEnd - n.startTime),
  } : null
})

console.log(`DOMContentLoaded: ${tDom}ms`)
console.log(`元素表可交互: ${tInteractive}ms`)
console.log(`点击碳元素: ${clickOk ? '✓' : '✗'}`)
console.log(`\n导航计时:`, JSON.stringify(nav))
console.log(`\n最慢资源 Top 15:`)
for (const r of resources) console.log(`  ${r.dur}ms  ${r.size}KB  ${r.type}  ${r.name}`)
console.log(`\nConsole 错误 (${errors.length}):`)
for (const e of errors.slice(0, 10)) console.log(`  ${e.slice(0, 200)}`)

await b.close()
