// 定位课程精讲正文里「min-content 宽于视口」的元素 —— 它会把外层 grid 轨道撑宽。
// 做法：把 .ru-les-body 克隆到离屏容器（宽 = 视口），再找宽度超出容器的子元素；
// 纯只读探测，不影响线上页面。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ORIGIN = process.argv[2] || 'http://localhost:4173'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9750 + Math.floor(Math.random() * 60)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userDir = path.join(os.tmpdir(), `cdp-minc-${process.pid}`)
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
// 站点注册了 /sw.js，会缓存旧 HTML 外壳（其中引用的 assets/index-<hash>.js 可能是
// 上一次构建已删除的文件）⇒ 应用不水合、探测读到空壳。先清 SW/Cache 并绕过。
await send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'service_workers,cache_storage' }, sessionId)
await send('Network.setBypassServiceWorker', { bypass: true }, sessionId)
await sleep(500)
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, sessionId)
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).split('\n')[0])
  return r.result?.value
}

await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, sessionId)
await send('Page.navigate', { url: `${ORIGIN}/share/russian` }, sessionId)
for (let i = 0; i < 160; i++) { await sleep(250); if (await ev('document.readyState') === 'complete') break }
await sleep(3000)
await ev(`(()=>{const b=Array.from(document.querySelectorAll('.ru-tab')).find(x=>x.textContent.trim()==='课程精讲');if(b)b.click()})()`)
for (let k = 0; k < 60; k++) { await sleep(300); if (await ev(`!!document.querySelector('.ru-les-body')`)) break }
await sleep(1500)

// 逐个课程在「手机视口」下实测真实宽度：找出把外层撑到 > 视口 的元素。
// 注意：不动 DOM、只读测量（此前用离屏克隆+强制宽度会把问题掩盖掉）。
const probe = `
  (()=>{const body=document.querySelector('.ru-les-body');if(!body)return null;
  const vw=window.innerWidth;
  const W=(e)=>Math.round(e.getBoundingClientRect().width);
  const chain={};
  for(const s of ['.admin-dashboard','.panel','.ru-mat-print','.ru-mat-nav','.ru-mat-panel','.ru-les-body'])
    {const e=document.querySelector(s);chain[s]=e?W(e):null}
  // 找出「自身宽度 ≥ 视口+2」且文本非空的最深元素（越深越接近真正的元凶）
  const wide=[];
  body.querySelectorAll('*').forEach(e=>{
    const w=W(e);if(w<vw+2)return;
    const txt=(e.textContent||'').replace(/\\s+/g,' ').trim();
    wide.push({tag:e.tagName,cls:(typeof e.className==='string'?e.className:'').slice(0,44),w,
      depth:(()=>{let d=0,n=e;while(n&&n!==body){d++;n=n.parentElement}return d})(),
      hasElemKids:e.children.length,ws:getComputedStyle(e).whiteSpace,
      disp:getComputedStyle(e).display,ox:getComputedStyle(e).overflowX,
      scrollW:e.scrollWidth,clientW:e.clientWidth,
      txt:txt.slice(0,60)})});
  wide.sort((a,b)=>b.depth-a.depth);
  // 自身溢出的元素（scrollWidth 明显大于 clientWidth）
  const selfScroll=wide.filter(x=>x.scrollW>x.clientW+4).slice(0,6);
  return{vw,bodyW:W(body),chain,wideCount:wide.length,
    deepest:wide.slice(0,10),selfScroll,
    docScrollW:document.documentElement.scrollWidth}})()`

const labels = await ev(`Array.from(document.querySelectorAll('.ru-mat-chip')).map(b=>b.textContent.trim())`)
for (let i = 0; i < labels.length; i++) {
  await ev(`(()=>{const b=document.querySelectorAll('.ru-mat-chip')[${i}];if(b)b.click()})()`)
  await sleep(1500)
  const r = await ev(probe)
  if (!r) { console.log(`${labels[i]}  (no body)`); continue }
  const flag = r.bodyW > r.vw + 2 ? '  ⟵ 超标' : ''
  console.log(`\n${labels[i]}  viewport=${r.vw} body=${r.bodyW} ${flag} (docScrollW=${r.docScrollW})`)
  console.log('   chain:', JSON.stringify(r.chain))
  if (r.bodyW > r.vw + 2) {
    console.log('   deepest-wide:')
    for (const o of r.deepest) console.log('     ', JSON.stringify(o))
    console.log('   self-scrolling:')
    for (const o of r.selfScroll) console.log('     ', JSON.stringify(o))
  }
}

ws.close(); cleanup(); process.exit(0)