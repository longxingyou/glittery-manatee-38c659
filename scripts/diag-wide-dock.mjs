// 宽屏（≥1410px）停靠验证：课程精讲的正文与大纲应并排（大纲为粘性侧栏），
// 而非浮层覆盖正文。窄屏（<1410px）则应为底部抽屉。
//
// 手法与 browser-verify-share.mjs 一致：
//   - 独立 user-data-dir 的 Edge + CDP
//   - 先清 SW / Cache Storage（站点注册了 /sw.js，会缓存旧 HTML 外壳）
//   - 用 Fetch 域把 /ru-share 请求桩成 200（否则被分享口令门挡住，页面不可用）
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

const userDir = path.join(os.tmpdir(), `cdp-dock-${process.pid}`)
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDir}`, 'about:blank'], { stdio: 'ignore' })
const cleanup = () => {
  try { edge.kill() } catch { /* ignore */ }
  try { fs.rmSync(userDir, { recursive: true, force: true }) } catch { /* ignore */ }
}

let wsUrl = ''
for (let i = 0; i < 80; i++) {
  await sleep(300)
  try {
    const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()
    if (j.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; break }
  } catch { /* not up */ }
}
if (!wsUrl) { console.error('CDP 未就绪'); cleanup(); process.exit(1) }

const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res)
  ws.addEventListener('error', rej)
})
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
    return
  }
  if (m.method === 'Fetch.requestPaused') {
    const { requestId, request } = m.params
    if (/ru-share/i.test(request.url)) {
      send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
        body: Buffer.from(JSON.stringify({ ok: true })).toString('base64'),
      }, m.sessionId).catch(() => {})
    } else {
      send('Fetch.continueRequest', { requestId }, m.sessionId).catch(() => {})
    }
  }
})
const send = (method, params = {}, sid) => new Promise((res, rej) => {
  const i = ++id
  pending.set(i, { res, rej })
  ws.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) }))
})

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)
await send('Fetch.enable', { patterns: [{ urlPattern: '*ru-share*' }] }, sessionId)
await send('Network.enable', {}, sessionId)
await send('Storage.clearDataForOrigin',
  { origin: ORIGIN, storageTypes: 'service_workers,cache_storage' }, sessionId)
await send('Network.setBypassServiceWorker', { bypass: true }, sessionId)
await sleep(400)

const ev = async (expr) => {
  const r = await send('Runtime.evaluate',
    { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)
  if (r.exceptionDetails) {
    throw new Error(String(r.exceptionDetails.exception?.description
      || r.exceptionDetails.text).split('\n')[0])
  }
  return r.result?.value
}

const clickTab = (name) => ev(`(()=>{
  const b=Array.from(document.querySelectorAll('.ru-tab'))
    .find(x=>x.textContent.trim()===${JSON.stringify(name)});
  if(b){b.click();return true}return false})()`)

const ensureLessons = async () => {
  for (let k = 0; k < 40; k++) {
    if (await ev(`!!document.querySelector('.ru-les-body')`)) return true
    await clickTab('课程精讲')
    await sleep(500)
  }
  return await ev(`!!document.querySelector('.ru-les-body')`)
}

const results = []
for (const [w, h] of [[1440, 900], [1280, 900], [1600, 950]]) {
  await send('Emulation.setDeviceMetricsOverride',
    { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId)
  await send('Page.navigate', { url: `${ORIGIN}${PAGE_PATH}` }, sessionId)
  for (let i = 0; i < 160; i++) {
    await sleep(250)
    if (await ev('document.readyState') === 'complete') break
  }
  await sleep(2500)

  await clickTab('课程精讲')
  const mounted = await ensureLessons()
  // 选一课正文较长的，便于观察停靠
  await ev(`(()=>{const c=[...document.querySelectorAll('.ru-mat-chip')]
    .find(b=>(b.textContent||'').includes('Урок 3'));if(c)c.click();return !!c})()`)
  await sleep(1500)

  await ev(`(()=>{const f=document.querySelector('.outline-fab');if(f)f.click()})()`)
  await sleep(900)

  const probe = await ev(`(()=>{
    const panel=document.querySelector('.ru-les-panel');
    if(!panel) return {found:false};
    const body=panel.querySelector('.ru-les-body');
    const ps=getComputedStyle(panel);
    const pr=panel.getBoundingClientRect();
    const br=body?body.getBoundingClientRect():null;
    const op=document.querySelector('.outline-panel');
    const ocs=op?getComputedStyle(op):null;
    const orr=op?op.getBoundingClientRect():null;
    const outItems=document.querySelectorAll('.outline-item').length;
    return {
      found:true,
      viewport: window.innerWidth,
      mounted: !!body,
      panelDisplay: ps.display,
      panelOverflow: ps.overflow,
      bodyWidth: br?Math.round(br.width):null,
      panelWidth: Math.round(pr.width),
      outlinePosition: ocs?ocs.position:null,
      outlineLeft: orr?Math.round(orr.left):null,
      outlineRight: orr?Math.round(orr.right):null,
      outlineWidth: orr?Math.round(orr.width):null,
      bodyLeft: br?Math.round(br.left):null,
      bodyRight: br?Math.round(br.right):null,
      sideBySide: !!(br&&orr&&orr.left>=br.right-2),
      overlaps: !!(br&&orr&&orr.left<br.right-2&&orr.right>br.left+2),
      outlineItems: outItems,
      docOverflowsX: document.documentElement.scrollWidth>window.innerWidth+1,
    };
  })()`)
  results.push({ width: w, mounted, ...probe })
}

console.log(JSON.stringify(results, null, 2))
ws.close()
cleanup()
process.exit(0)