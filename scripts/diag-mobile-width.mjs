// 手机视口下找出「比视口宽」的元素（定位横向溢出/裁切来源）。
// 用法: node scripts/diag-mobile-width.mjs [origin]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 俄语工具箱已从后台迁到主站公开路由 /russian；旧的 /share/russian 已不存在。
const PAGE_PATH = process.argv[3] || '/russian'
const ORIGIN = process.argv[2] || 'http://localhost:4173'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9700 + Math.floor(Math.random() * 60)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userDir = path.join(os.tmpdir(), `cdp-diag-${process.pid}`)
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDir}`, 'about:blank'], { stdio: 'ignore' })
const cleanup = () => { try { edge.kill() } catch {} ; try { fs.rmSync(userDir, { recursive: true, force: true }) } catch {} }

let wsUrl = ''
for (let i = 0; i < 80; i++) { await sleep(300); try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; break } } catch {} }
if (!wsUrl) { console.error('CDP 未就绪'); cleanup(); process.exit(1) }

const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
let id = 0; const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return }
  if (m.method === 'Fetch.requestPaused') {
    const { requestId, request } = m.params
    if (/ru-share/i.test(request.url)) {
      send('Fetch.fulfillRequest', { requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
        body: Buffer.from(JSON.stringify({ ok: true })).toString('base64') }, m.sessionId).catch(() => {})
    } else send('Fetch.continueRequest', { requestId }, m.sessionId).catch(() => {})
  }
})
const send = (method, params = {}, sid) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) })) })

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)
await send('Network.enable', {}, sessionId)
await send('Fetch.enable', { patterns: [{ urlPattern: '*ru-share*' }] }, sessionId)
// 站点注册了 /sw.js，会缓存旧 HTML 外壳（引用的 assets/index-<hash>.js 可能是已删除的
// 上一次构建产物）⇒ 应用不水合、所有尺寸探测读到的是空壳。诊断前先清 SW/Cache 并绕过。
await send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'service_workers,cache_storage' }, sessionId)
await send('Network.setBypassServiceWorker', { bypass: true }, sessionId)
await sleep(500)
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, sessionId)
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).split('\n')[0])
  return r.result?.value
}

await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, sessionId)
await send('Page.navigate', { url: `${ORIGIN}${PAGE_PATH}` }, sessionId)
for (let i = 0; i < 160; i++) { await sleep(250); if (await ev('document.readyState') === 'complete') break }
await sleep(3000)

const clickTab = (name) => ev(`(()=>{const b=Array.from(document.querySelectorAll('.ru-tab')).find(x=>x.textContent.trim()===${JSON.stringify(name)});if(b){b.click();return true}return false})()`)

// 找出所有「右边界超出视口」或「自身宽度大于视口」的元素
const offenders = `
  (()=>{const vw=window.innerWidth;const out=[];
  document.querySelectorAll('*').forEach(e=>{const r=e.getBoundingClientRect();
    if(r.width===0&&r.height===0)return;
    if(r.width>vw+2||r.right>vw+2){
      out.push({tag:e.tagName,cls:(e.className&&typeof e.className==='string'?e.className:'').slice(0,60),
        id:e.id||'',w:Math.round(r.width),right:Math.round(r.right),
        oy:getComputedStyle(e).overflowY,ox:getComputedStyle(e).overflowX,
        parentCls:(e.parentElement?.className&&typeof e.parentElement.className==='string'?e.parentElement.className:'').slice(0,40)});
    }});
  return{vw,scrollWidth:document.documentElement.scrollWidth,count:out.length,top:out.slice(0,25)}})()`

for (const tab of ['课程精讲', '语法手册', '词汇点读']) {
  await clickTab(tab)
  await sleep(3500)
  const rootSel = tab === '课程精讲' ? '.ru-les-body' : '.ru-mat-panel'
  const chain = await ev(`
    (()=>{const sels=['.admin-dashboard','.panel','.ru-mat-print','.ru-mat-nav','.ru-mat-row','.ru-mat-panel','.ru-les-body','.ru-lex-layout'];
    const out={};for(const s of sels){const e=document.querySelector(s);out[s]=e?Math.round(e.getBoundingClientRect().width):null}
    const b=document.querySelector('${rootSel}');out['${rootSel}']=b?Math.round(b.getBoundingClientRect().width):null;
    out['document']=document.documentElement.scrollWidth;out['viewport']=window.innerWidth;return out})()`)
  const off = await ev(offenders)
  console.log(`\n=== ${tab} ===`)
  console.log('widths:', JSON.stringify(chain))
  console.log('overflowing:', JSON.stringify(off))
}

ws.close(); cleanup(); process.exit(0)