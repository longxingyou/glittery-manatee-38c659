/**
 * P3 同位素表格渲染验证脚本。
 * 验证：碳（2 稳定核素）、铀（3 放射性核素 + 半衰期 + 衰变方式）、窄屏 375px 不溢出。
 */
import { chromium } from 'playwright'

const URL = process.env.PT_URL || 'http://localhost:3000/periodic-table'
let pass = 0, fail = 0
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); pass++ }
  else { console.log(`  ✗ ${name} ${detail}`); fail++ }
}

async function run() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })

  console.log('加载周期表页面...')
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForSelector('.ru-el', { timeout: 15000 })
  const elCount = await page.locator('.ru-el').count()
  check('周期表元素格数量 > 100', elCount > 100, `实际 ${elCount}`)

  // 点击碳（C，z=6）
  console.log('\n点击碳 (C)...')
  await page.locator('.ru-el[data-z="6"]').click()
  await page.waitForSelector('.ru-iso-table', { timeout: 5000 })

  const cHeaders = await page.locator('.ru-iso-table thead th').allTextContents()
  check('表头存在', cHeaders.length === 5, `实际 ${cHeaders.length}: ${cHeaders.join('|')}`)

  const cRows = await page.locator('.ru-iso-table tbody tr').count()
  check('碳有 2 行同位素', cRows === 2, `实际 ${cRows}`)

  const cFirstRow = await page.locator('.ru-iso-table tbody tr').first().innerText()
  check('碳-12 行包含 ¹²C 与 98.94', cFirstRow.includes('12') && cFirstRow.includes('98.94'), `内容: ${cFirstRow.replace(/\n/g, ' | ')}`)

  const cStableCells = await page.locator('.ru-iso-table tbody tr td:nth-child(4)').allTextContents()
  check('碳的两行都标为稳定', cStableCells.every(t => t.includes('稳定') || t.includes('stable') || t.includes('стабилен')), `实际: ${cStableCells.join(' / ')}`)

  const cDecayCells = await page.locator('.ru-iso-table tbody tr td:nth-child(5)').allTextContents()
  check('碳的衰变方式列为 —', cDecayCells.every(t => t.trim() === '—'), `实际: ${cDecayCells.join(' / ')}`)

  // 点击铀（U，z=92）
  console.log('\n点击铀 (U)...')
  await page.locator('.ru-el[data-z="92"]').click()
  await page.waitForTimeout(800)

  const uRows = await page.locator('.ru-iso-table tbody tr').count()
  check('铀有 3 行同位素', uRows === 3, `实际 ${uRows}`)

  const uAll = await page.locator('.ru-iso-table tbody').innerText()
  check('铀包含 U-234/235/238', uAll.includes('234') && uAll.includes('235') && uAll.includes('238'), `内容摘要: ${uAll.slice(0, 120).replace(/\n/g, ' | ')}`)
  check('铀含 α 衰变标记', uAll.includes('α'), `内容: ${uAll.replace(/\n/g, ' | ')}`)
  check('铀含半衰期单位 Ga', uAll.includes('Ga') || uAll.includes('十亿年') || uAll.includes('млрд'), `内容: ${uAll.replace(/\n/g, ' | ')}`)

  // 窄屏 375px 不溢出
  console.log('\n窄屏 375px 验证...')
  await page.setViewportSize({ width: 375, height: 812 })
  await page.keyboard.press('Escape') // 关闭铀详情面板
  await page.waitForTimeout(300)
  await page.locator('.ru-el[data-z="6"]').click({ force: true })
  await page.waitForTimeout(500)
  const wrapScrollW = await page.locator('.ru-iso-table-wrap').evaluate(el => el.scrollWidth)
  const wrapClientW = await page.locator('.ru-iso-table-wrap').evaluate(el => el.clientWidth)
  check('同位素表在 375px 下可横向滚动（不撑破布局）', wrapScrollW >= wrapClientW, `scroll=${wrapScrollW}, client=${wrapClientW}`)

  await browser.close()
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

run().catch(e => { console.error(e); process.exit(1) })
