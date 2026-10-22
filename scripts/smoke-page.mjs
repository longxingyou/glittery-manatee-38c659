// 冒烟：只确认页面是否真的加载出俄语工具箱 UI，并排查
// ① 资源版本是否与 dist 一致 ② 是否有 Service Worker 缓存旧壳 ③ 控制台/网络错误
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ORIGIN = process.argv[2] || 'http://localhost:4173'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9800 + Math.floor(Math.random() * 60)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userDir = path.join(os.tmpdir(), `cdp-smoke-${process.pid}`)
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDir}`, 'about:blank'], { stdio: 'ignore' })
const cleanup = () => { try { edge.kill() } catch {} ; try { fs.rmSync(userDir, { recursive: true, force: true }) } catch {} }

let wsUrl = ''
for (let i = 0; i < 80; i++) { await sleep(300); try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; break } } catch {} }
if (!wsUrl) { console.error('CDP 未就绪'); cleanup(); process.exit(1) }

const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
let id = 0; const pending = new Map(); const errs = []; const failed = []; const ok = []; const reqs = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return }
  if (m.method === 'Runtime.exceptionThrown') errs.push(String(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text).split('\n')[0])
  if (m.method === 'Network.loadingFailed') failed.push(`${m.params?.type} ${m.params?.errorText} ${m.params?.blockedReason || ''}`)
  if (m.method === 'Network.requestWillBeSent') { const u = m.params?.request?.url || ''; if (!u.startsWith('data:')) reqs.push(`${m.params?.type || '?'} ${u}`) }
  if (m.method === 'Network.responseReceived') { const u = m.params?.response?.url || ''; if (u.includes('/assets/')) ok.push(`${m.params.response.status} ${u.split('/').pop()}`) }
})
const send = (method, params = {}, sid) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) })) })

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)
await send('Network.enable', {}, sessionId)
// 站点注册了 /sw.js：它会缓存旧 HTML 外壳，重新构建后壳里引用的 assets/index-<hash>.js
// 已被删除 ⇒ 动态 import 404、应用不水合。诊断前先清 SW/Cache，并让请求绕过 SW。
await send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'service_workers,cache_storage' }, sessionId)
await send('Network.setBypassServiceWorker', { bypass: true }, sessionId)
await sleep(500)
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, sessionId)
  if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).split('\n')[0] }
  return r.result?.value
}

await send('Page.navigate', { url: `${ORIGIN}/share/russian` }, sessionId)
for (let i = 0; i < 160; i++) { await sleep(250); if (await ev('document.readyState') === 'complete') break }
await sleep(6000)

console.log('title        =', await ev('document.title'))
console.log('bodyTextLen  =', await ev('document.body.innerText.length'))
console.log('bodyTextHead =', JSON.stringify((await ev('document.body.innerText') || '').slice(0, 300)))
console.log('#root/#app   =', await ev(`document.querySelector('#root,#app,[data-dsh-root]')?'found':'MISSING'`))
console.log('childCount   =', await ev('document.body.children.length'))
console.log('tabs         =', await ev(`document.querySelectorAll('.ru-tab').length`))
console.log('hasGate      =', await ev(`!!document.querySelector('.ru-share-gate, .share-gate')`))
console.log('scripts      =', JSON.stringify(await ev(`Array.from(document.querySelectorAll('script[src]')).map(s=>s.src.split('/').pop())`)))
console.log('sw           =', await ev(`'serviceWorker' in navigator ? (navigator.serviceWorker.controller? 'controlled-by:'+navigator.serviceWorker.controller.scriptURL : 'registered-none') : 'unsupported'`))
console.log('swRegs       =', await ev(`(async()=>{if(!navigator.serviceWorker)return 0;const r=await navigator.serviceWorker.getRegistrations();return r.map(x=>x.scope)})()`))
console.log('assetsOK     =', JSON.stringify(ok.slice(0, 12)))
console.log('assetsFAIL   =', JSON.stringify(failed.slice(0, 12)))
console.log('exceptions   =', JSON.stringify(errs.slice(0, 6)))
console.log('requests     =')
for (const r of reqs.slice(0, 40)) console.log('   ', r)

ws.close(); cleanup(); process.exit(0)