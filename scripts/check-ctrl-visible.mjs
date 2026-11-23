import { chromium } from 'playwright'

const b = await chromium.launch({ headless: true })
const p = await b.newPage({ viewport: { width: 375, height: 812 } })
await p.goto('http://localhost:3000/periodic-table', { waitUntil: 'networkidle' })
await p.waitForSelector('.ru-el')
await p.evaluate(() => { localStorage.setItem('sg_lang', 'ru'); localStorage.setItem('sg-pt-el-lang', 'ru') })
await p.reload({ waitUntil: 'networkidle' })
await p.waitForSelector('.ru-el')

// 检查所有控制按钮是否在视口内（right <= 375）
const btnInfo = await p.evaluate(() => {
  const vw = window.innerWidth
  const btns = [...document.querySelectorAll('.ru-el-controls button')]
  return btns.map(btn => {
    const r = btn.getBoundingClientRect()
    return {
      text: btn.textContent.trim().slice(0, 20),
      left: Math.round(r.left),
      right: Math.round(r.right),
      visible: r.right <= vw + 1 && r.left >= -1,
    }
  })
})

let allVisible = true
for (const b of btnInfo) {
  const mark = b.visible ? '✓' : '✗'
  if (!b.visible) allVisible = false
  console.log(`  ${mark} "${b.text}" left=${b.left} right=${b.right}`)
}
console.log(`\n所有控制按钮可见: ${allVisible ? '✓' : '✗'}`)
await b.close()
process.exit(allVisible ? 0 : 1)
