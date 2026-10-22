// 聚焦验证：折叠块交互与打印展开。
// 上一轮巡检结束时停在「词表 · 按主题」（无折叠块），导致此项显示 0/null。
// 这里先切到 Урок 12（折叠块最多的一课）再测。
//
// 用法: node scripts/browser-verify-fold.mjs [origin]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ORIGIN = process.argv[2] || 'http://localhost:4173'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9300 + Math.floor(Math.random() * 90)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const userDir = path.join(os.tmpdir(), `cdp-fold-${process.pid}`)
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDir}`, 'about:blank'], { stdio: 'ignore' })
const cleanup = () => { try { edge.kill() } catch {} ; try { fs.rmSync(userDir, { recursive: true, force: true }) } catch {} }

let wsUrl = ''
for (let i = 0; i < 80; i++) { await sleep(300); try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; break } } catch {} }
if (!wsUrl) { console.error('no cdp'); cleanup(); process.exit(1) }

const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
let id = 0; const pending = new Map(); const errs = []
ws.addEventListener('message', async (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return }
  if (m.method === 'Runtime.exceptionThrown') errs.push(String(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text).split('\n')[0])
  if (m.method === 'Fetch.requestPaused') {
    const { requestId, request } = m.params
    if (/ru-share/i.test(request.url)) {
      send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
        body: Buffer.from(JSON.stringify({ ok: true })).toString('base64'),
      }, m.sessionId).catch(() => {})
    } else send('Fetch.continueRequest', { requestId }, m.sessionId).catch(() => {})
  }
})
const send = (method, params = {}, sid) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) })) })

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)
await send('Fetch.enable', { patterns: [{ urlPattern: '*ru-share*' }] }, sessionId)

const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, sessionId)
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).split('\n')[0] + ' <<< ' + e.slice(0, 90))
  return r.result?.value
}

const out = { errors: [] }
await send('Page.navigate', { url: `${ORIGIN}/share/russian` }, sessionId)
for (let i = 0; i < 140; i++) { await sleep(250); if (await ev('document.readyState') === 'complete') break }
await sleep(3000)
await ev(`(()=>{const b=Array.from(document.querySelectorAll('.ru-tab')).find(x=>x.textContent.trim()==='课程精讲');if(b)b.click()})()`)
await sleep(4500)

// 逐课清点折叠块。切课时 React 会短暂卸载再挂载 .ru-les-body，
// 因此这里既要等就绪，也要对 null 容错（读到 null 时重试几次）。
out.foldsPerLesson = []
const n = await ev(`document.querySelectorAll('.ru-mat-chip').length`)

const factsFor = (label) => `
  (()=>{const b=document.querySelector('.ru-les-body');
  if(!b) return null;
  return {chip:${JSON.stringify(label)},
    details:b.querySelectorAll('details.callout').length,
    open:b.querySelectorAll('details.callout[open]').length,
    divCallouts:b.querySelectorAll('div.callout').length}})()`

for (let i = 0; i < n; i++) {
  const label = await ev(`document.querySelectorAll('.ru-mat-chip')[${i}]?.textContent?.trim()`)
  await ev(`(()=>{const b=document.querySelectorAll('.ru-mat-chip')[${i}];if(b)b.click()})()`)
  let d = null
  for (let k = 0; k < 40 && !d; k++) { await sleep(300); d = await ev(factsFor(label)) }
  out.foldsPerLesson.push(d ?? { chip: label, details: -1, open: -1, divCallouts: -1 })
}

// ── 切到折叠块最多的一课，测交互 ──
const best = out.foldsPerLesson.filter((x) => x.details > 0).sort((a, b) => b.details - a.details)[0]
out.focus = best?.chip ?? null
await ev(`(()=>{const b=Array.from(document.querySelectorAll('.ru-mat-chip')).find(x=>x.textContent.trim()===${JSON.stringify(best?.chip ?? '')});if(b)b.click()})()`)
for (let k = 0; k < 40; k++) { await sleep(300); if (await ev(`!!document.querySelector('.ru-les-body')`)) break }
await sleep(1000)

// 从此刻起所有操作都容错：单个断言失败不应丢失整份报告。
const safe = async (label, fn) => {
  try { return await fn() } catch (e) {
    out.errors.push(`${label}: ${e.message}`)
    return null
  }
}

out.initialFolded = await safe('initialFolded', () => ev(`
  (()=>{const b=document.querySelector('.ru-les-body');
  if(!b) return {missing:true};
  return {details:b.querySelectorAll('details.callout').length,
          open:b.querySelectorAll('details.callout[open]').length}})()
`))

out.manualToggle = await safe('manualToggle', () => ev(`
  (()=>{const d=document.querySelector('.ru-les-body details.callout');if(!d)return null;
  const before=d.open;
  d.querySelector('summary').click();
  const mid=d.open;
  d.querySelector('summary').click();
  const back=d.open;
  return{before,afterFirstClick:mid,afterSecondClick:back,
         expandedOnClick:before===false&&mid===true, collapsedOnSecond:mid===true&&back===false}})()
`))

out.printExpand = await safe('printExpand', () => ev(`
  (()=>{const b=document.querySelector('.ru-les-body');
  if(!b) return {missing:true};
  const all=[...b.querySelectorAll('details.callout')];
  all.forEach(d=>{d.open=false});
  const base=all.filter(d=>d.open).length;
  window.dispatchEvent(new Event('beforeprint'));
  const during=all.filter(d=>d.open).length;
  window.dispatchEvent(new Event('afterprint'));
  const after=all.filter(d=>d.open).length;
  return{total:all.length,base,during,after,allOpenedOnPrint:during===all.length,restored:after===base}})()
`))

// 按钮路径：调用真实的「打印」按钮（window.print 在无头环境是空操作，
// 但 beforeprint/afterprint 由页面逻辑自己派发或由浏览器派发，这里验证
// 按钮点击后确实进入「展开」态，且 afterprint 能还原）。
out.buttonPath = await safe('buttonPath', () => ev(`
  (()=>{const b=document.querySelector('.ru-les-body');
  if(!b) return {missing:true};
  const all=[...b.querySelectorAll('details.callout')];
  all.forEach(d=>{d.open=false});
  const btn=[...document.querySelectorAll('.ru-mat-btn')].find(x=>/打印/.test(x.textContent));
  if(!btn) return {found:false};
  const printing=()=>document.body.classList.contains('ru-mat-printing');
  btn.click();
  const afterClick={open:all.filter(d=>d.open).length,printing:printing()};
  window.dispatchEvent(new Event('afterprint'));
  const afterRestore={open:all.filter(d=>d.open).length,printing:printing()};
  return {found:true,total:all.length,afterClick,afterRestore,
          expandedOnClick:afterClick.open===all.length,
          restored:afterRestore.open===0&&!afterRestore.printing}})()
`))

// Ctrl+P 路径（只派发 beforeprint，不经过按钮）
out.ctrlPPath = await safe('ctrlPPath', () => ev(`
  (()=>{const b=document.querySelector('.ru-les-body');
  if(!b) return {missing:true};
  const all=[...b.querySelectorAll('details.callout')];
  all.forEach(d=>{d.open=false});
  window.dispatchEvent(new Event('beforeprint'));
  const during=all.filter(d=>d.open).length;
  const printing=document.body.classList.contains('ru-mat-printing');
  window.dispatchEvent(new Event('afterprint'));
  const after=all.filter(d=>d.open).length;
  return {total:all.length,during,printingDuring:printing,after,
          expanded:during===all.length,restored:after===0&&!document.body.classList.contains('ru-mat-printing')}})()
`))

// 先手动展开一个，再测打印后能否还原到「展开前」的状态
out.printRestoresPartial = await safe('printRestoresPartial', () => ev(`
  (()=>{const b=document.querySelector('.ru-les-body');
  if(!b) return {missing:true};
  const all=[...b.querySelectorAll('details.callout')];
  all.forEach(d=>{d.open=false});
  if(all[0])all[0].open=true;
  const base=all.filter(d=>d.open).length;
  window.dispatchEvent(new Event('beforeprint'));
  const during=all.filter(d=>d.open).length;
  window.dispatchEvent(new Event('afterprint'));
  const after=all.filter(d=>d.open).length;
  return{total:all.length,base,during,after,restoredExactly:after===1&&all[0].open===true}})()
`))

// summary 标题是否完整（此前有过「首字符被吃掉」的问题）
out.summaryTitles = await safe('summaryTitles', () => ev(`
  (()=>{const b=document.querySelector('.ru-les-body');
  if(!b) return null;
  return [...b.querySelectorAll('details.callout summary')].map(s=>s.textContent.trim()).slice(0,20)})()
`))

out.consoleErrors = errs
// 无论断言是否失败都落盘，避免丢失整份报告
const OUT = process.argv[3] || path.join(os.tmpdir(), 'ru-fold-report.json')
try { fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8') } catch {}
console.log(JSON.stringify(out, null, 2))
ws.close(); cleanup(); process.exit(out.errors.length ? 2 : 0)