// 终局验证（生产构建 + 真实浏览器）：
//   ① 「课程精讲」15 份内容是否齐全、重音高亮、大纲导航、折叠、打印；
//   ② 教材分组与后续教材预留位是否如期渲染；
//   ③ 手机视口下正文是否不再「滚动里套滚动」、触控目标是否够大；
//   ④ 既有「语法手册」是否照常可用 —— 用于证明「dev 下 content/*.md 取不到」
//      是环境既有问题（两套内容在 dev 同样失败），而非整合引入。
//
// 用法: node scripts/browser-verify-share.mjs <origin> <outfile> [path]
//   origin 默认 http://localhost:4173（pnpm preview 的生产产物）
//   path   默认 /russian —— 俄语工具箱已从后台迁到主站公开路由；
//          旧地址 /share/russian 不再存在，传该值会 404 并让断言全为 0。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ORIGIN = process.argv[2] || 'http://localhost:4173'
const OUT = process.argv[3] || path.join(os.tmpdir(), 'ru-site-report.json')
const PAGE_PATH = process.argv[4] || '/russian'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9600 + Math.floor(Math.random() * 80)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const userDir = path.join(os.tmpdir(), `cdp-final-${process.pid}`)
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDir}`, 'about:blank'], { stdio: 'ignore' })
const cleanup = () => { try { edge.kill() } catch {} ; try { fs.rmSync(userDir, { recursive: true, force: true }) } catch {} }

let wsUrl = ''
for (let i = 0; i < 80; i++) { await sleep(300); try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; break } } catch {} }
if (!wsUrl) { console.error('CDP 未就绪'); cleanup(); process.exit(1) }

const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
let id = 0; const pending = new Map(); const errs = []; let stubCount = 0
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return }
  if (m.method === 'Runtime.exceptionThrown') errs.push(String(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text).split('\n')[0])
  if (m.method === 'Fetch.requestPaused') {
    const { requestId, request } = m.params
    if (/ru-share/i.test(request.url)) {
      stubCount++
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

// 关键：这个站点注册了 Service Worker（/sw.js）。它会把**旧的 HTML 外壳**缓存下来，
// 而外壳里引用的是上一次构建的 assets/index-<hash>.js —— 重新构建后该文件已不存在，
// 于是动态 import 404、应用永不水合，页面只剩站点框架（表现为「所有断言全是 0」）。
// 校验必须针对「本次构建」，所以先清掉该 origin 的 SW 与 Cache Storage，
// 之后所有请求仍走 Fetch 域拦截（分享口令的桩照常生效）。
try {
  await send('Network.enable', {}, sessionId)
  await send('Storage.clearDataForOrigin',
    { origin: ORIGIN, storageTypes: 'service_workers,cache_storage' }, sessionId)
  await send('Network.setBypassServiceWorker', { bypass: true }, sessionId)
  await sleep(500)
} catch (e) {
  console.error('清 SW 失败（继续，可能导致读到旧外壳）:', e.message)
}

const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, sessionId)
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).split('\n')[0] + ' <<< ' + e.slice(0, 80))
  return r.result?.value
}

const load = async () => {
  await send('Page.navigate', { url: `${ORIGIN}${PAGE_PATH}` }, sessionId)
  for (let i = 0; i < 160; i++) { await sleep(250); if (await ev('document.readyState') === 'complete') break }
  await sleep(3000)
}

const report = { origin: ORIGIN, checks: {}, consoleErrors: [] }
await load()

report.checks.shareGateStubbed = stubCount
report.checks.tabCount = await ev(`document.querySelectorAll('.ru-tab').length`)
report.checks.hasLessonsTab = await ev(`Array.from(document.querySelectorAll('.ru-tab')).some(b=>b.textContent.trim()==='课程精讲')`)

const clickTab = (name) => ev(`(()=>{const b=Array.from(document.querySelectorAll('.ru-tab')).find(x=>x.textContent.trim()===${JSON.stringify(name)});if(b){b.click();return true}return false})()`)

// 切到「课程精讲」并等正文挂载：懒加载 + 长文本渲染，且弱网/移动模拟下水合可能更慢，
// 因此点标签本身也要重试（点早了标签还没水合，click() 会落空）。
const ensureLessons = async () => {
  for (let k = 0; k < 40; k++) {
    if (await ev(`!!document.querySelector('.ru-les-body')`)) return true
    await clickTab('课程精讲')
    await sleep(500)
  }
  return await ev(`!!document.querySelector('.ru-les-body')`)
}

// 点开大纲后另起一次 evaluate 读取（React 状态更新不会在同一次求值内可见）
const openOutline = async () => {
  await ev(`(()=>{const f=document.querySelector('.outline-fab');if(f)f.click()})()`)
  for (let k = 0; k < 20; k++) { await sleep(150); if (await ev(`!!document.querySelector('.outline-panel')`)) break }
}

// ── ① 课程精讲（桌面视口）──
report.checks.clickedLessons = await clickTab('课程精讲')
report.checks.lessonsBodyMounted = await ensureLessons()
await sleep(1200)

// 正文事实（标题层级：正文用 renderMarkdown(src,1)，实际落在 h3–h5）
const facts = `
  (()=>{const b=document.querySelector('.ru-les-body');if(!b)return null;return{
    textLen:b.textContent.length,
    h3:b.querySelectorAll('h3').length,h4:b.querySelectorAll('h4').length,h5:b.querySelectorAll('h5').length,
    tables:b.querySelectorAll('table').length,stressed:b.querySelectorAll('span.stressed').length,
    raw:(b.innerHTML.match(/\\u0301/g)||[]).length,
    details:b.querySelectorAll('details.callout').length,
    outline:document.querySelectorAll('.outline-item').length,
    first:b.querySelector('h3')?.textContent?.replace(/\\s*#$/,'').trim()||null}})()`

report.checks.lessons = {
  books: await ev(`Array.from(document.querySelectorAll('.ru-les-book-name')).map(b=>b.textContent.trim())`),
  bookHints: await ev(`Array.from(document.querySelectorAll('.ru-les-book-hint')).map(b=>b.textContent.trim())`),
  slotNotes: await ev(`document.querySelectorAll('.ru-les-slot-note').length`),
  groupLabels: await ev(`Array.from(document.querySelectorAll('.ru-mat-label')).map(b=>b.textContent.trim())`),
  chips: await ev(`Array.from(document.querySelectorAll('.ru-mat-chip')).map(b=>b.textContent.trim())`),
}
report.checks.lessons.body = await ev(facts)
report.checks.lessons.stressedStyle = await ev(`
  (()=>{const s=document.querySelector('.ru-les-body span.stressed');if(!s)return null;
  const cs=getComputedStyle(s);return{sample:s.textContent,color:cs.color,decoration:cs.textDecorationLine,thickness:cs.textDecorationThickness}})()`)
report.checks.lessons.stressedVisible = await ev(`
  (()=>{const a=[...document.querySelectorAll('.ru-les-body span.stressed')];if(!a.length)return{total:0};
  const v=a.filter(s=>{const r=s.getBoundingClientRect();return r.width>0&&r.height>0});return{total:a.length,visible:v.length}})()`)

// 逐课巡检
report.checks.lessons.perLesson = []
const nChips = await ev(`document.querySelectorAll('.ru-mat-chip').length`)
for (let i = 0; i < nChips; i++) {
  const label = await ev(`document.querySelectorAll('.ru-mat-chip')[${i}]?.textContent?.trim()`)
  await ev(`(()=>{const b=document.querySelectorAll('.ru-mat-chip')[${i}];if(b)b.click()})()`)
  let f = null
  for (let k = 0; k < 40 && !f; k++) { await sleep(300); f = await ev(facts) }
  report.checks.lessons.perLesson.push(f ? { chip: label, ...f } : { chip: label, missing: true })
}

// 折叠交互 + 三条打印路径（固定在 Урок 12）
await ev(`(()=>{const b=Array.from(document.querySelectorAll('.ru-mat-chip')).find(x=>x.textContent.trim()==='Урок 12');if(b)b.click()})()`)
for (let k = 0; k < 40; k++) { await sleep(300); if (await ev(`!!document.querySelector('.ru-les-body')`)) break }
await sleep(800)
report.checks.lessons.manualToggle = await ev(`
  (()=>{const d=document.querySelector('.ru-les-body details.callout');if(!d)return null;
  const before=d.open;d.querySelector('summary').click();const mid=d.open;d.querySelector('summary').click();const back=d.open;
  return{before,afterFirstClick:mid,afterSecondClick:back,expandedOnClick:before===false&&mid===true,collapsedOnSecond:mid===true&&back===false}})()`)
report.checks.lessons.printCtrlP = await ev(`
  (()=>{const b=document.querySelector('.ru-les-body');if(!b)return null;const all=[...b.querySelectorAll('details.callout')];
  all.forEach(d=>{d.open=false});window.dispatchEvent(new Event('beforeprint'));
  const during=all.filter(d=>d.open).length;window.dispatchEvent(new Event('afterprint'));
  const after=all.filter(d=>d.open).length;
  return{total:all.length,during,after,expanded:during===all.length,restored:after===0}})()`)
report.checks.lessons.printButton = await ev(`
  (()=>{const b=document.querySelector('.ru-les-body');if(!b)return null;const all=[...b.querySelectorAll('details.callout')];
  all.forEach(d=>{d.open=false});
  const btn=[...document.querySelectorAll('.ru-mat-btn')].find(x=>/打印/.test(x.textContent));if(!btn)return{found:false};
  btn.click();const oc={open:all.filter(d=>d.open).length,printing:document.body.classList.contains('ru-mat-printing')};
  window.dispatchEvent(new Event('afterprint'));
  const ar={open:all.filter(d=>d.open).length,printing:document.body.classList.contains('ru-mat-printing')};
  return{found:true,afterClick:oc,afterRestore:ar,expandedOnClick:oc.open===all.length,restored:ar.open===0&&!ar.printing}})()`)

// ── 大纲（替代原先的左目录）：浮动钮 → 抽屉 → 点击跳转 ──
report.checks.lessons.outlineFab = await ev(`
  (()=>{const f=document.querySelector('.outline-fab');if(!f)return{found:false};
  const r=f.getBoundingClientRect();const cs=getComputedStyle(f);
  return{found:true,visible:r.width>0&&r.height>0,w:Math.round(r.width),h:Math.round(r.height),
  position:cs.position,right:Math.round(window.innerWidth-r.right),bottom:Math.round(window.innerHeight-r.bottom),
  beforeOpen:!!document.querySelector('.outline-panel')}})()`)
await openOutline()
report.checks.lessons.outlineOpen = await ev(`
  (()=>{const p=document.querySelector('.outline-panel');if(!p)return{opened:false};
  const r=p.getBoundingClientRect();const cs=getComputedStyle(p);
  const items=[...p.querySelectorAll('.outline-item')];
  return{opened:true,count:items.length,position:cs.position,
  lv:[...new Set(items.map(i=>i.className.replace(/.*\\blv(\\d).*/,'$1')))].sort(),
  hasActive:!!p.querySelector('.outline-item.active'),
  first3:items.slice(0,3).map(i=>({text:i.textContent.trim().slice(0,20),lv:i.className.replace(/.*\\blv(\\d).*/,'$1')})),
  w:Math.round(r.width)}})()`)

// 点击第 3 个条目：正文应随之滚动（滚动容器可能是 window 或某个祖先）
report.checks.lessons.outlineJump = await ev(`
  (()=>{const p=document.querySelector('.outline-panel');if(!p)return null;
  const items=[...p.querySelectorAll('.outline-item')];if(items.length<3)return{count:items.length};
  const id=items[2].dataset.id;
  const winBefore=window.scrollY;
  let anc=null;for(let n=document.querySelector('.ru-les-body');n&&n!==document.body;n=n.parentElement){
    const oy=getComputedStyle(n).overflowY;if((oy==='auto'||oy==='scroll')&&n.scrollHeight>n.clientHeight+4){anc=n;break}}
  const ancBefore=anc?anc.scrollTop:null;
  window.__outlineJumpId=id;
  items[2].click();
  return{count:items.length,id,winBefore,ancBefore,hadScroller:!!anc}})()`)
await sleep(1200)
report.checks.lessons.outlineJumpAfter = await ev(`
  (()=>{const id=window.__outlineJumpId;
  const head=document.getElementById(id);
  const active=document.querySelector('.outline-item.active');
  const winAfter=window.scrollY;
  let anc=null;for(let n=document.querySelector('.ru-les-body');n&&n!==document.body;n=n.parentElement){
    const oy=getComputedStyle(n).overflowY;if((oy==='auto'||oy==='scroll')&&n.scrollHeight>n.clientHeight+4){anc=n;break}}
  return{winAfter,ancAfter:anc?anc.scrollTop:null,
    activeText:active?.textContent?.trim().slice(0,24)||null,
    activeMatchesClicked:active?.dataset?.id===id,
    headingTopDelta:head?Math.round(head.getBoundingClientRect().top):null}})()`)

// ── ② 既有「语法手册」：生产下应正常 ──
report.checks.clickedMaterials = await clickTab('语法手册')
await sleep(4000)
report.checks.materials = {
  chips: await ev(`Array.from(document.querySelectorAll('.ru-mat-chip')).map(b=>b.textContent.trim())`),
  panelText: (await ev(`document.querySelector('.ru-mat-panel')?.textContent?.slice(0,200) ?? null`)) || null,
  canvas: await ev(`document.querySelectorAll('.ru-mat-canvas, .ru-mat-svg').length`),
}

// ── ③ 手机视口（390×844，iPhone 级别）：布局是否回归单列、正文是否不再内部滚动 ──
await send('Emulation.setDeviceMetricsOverride',
  { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, sessionId)
await load()
report.checks.mobile = { shareGateStubbed: stubCount }
report.checks.mobile.clickedLessons = await clickTab('课程精讲')
report.checks.mobile.lessonsBodyMounted = await ensureLessons()
await sleep(1200)

report.checks.mobile.layout = await ev(`
  (()=>{const b=document.querySelector('.ru-les-body');if(!b)return null;
  const cs=getComputedStyle(b);const r=b.getBoundingClientRect();
  return{viewport:window.innerWidth,
  bodyOverflowY:cs.overflowY,bodyMaxHeight:cs.maxHeight,
  nestedScroll:cs.overflowY!=='visible'&&b.scrollHeight>b.clientHeight+4,
  bodyWidth:Math.round(r.width),bodyHeight:Math.round(r.height),
  morePages:document.documentElement.scrollHeight>window.innerHeight+4}})()`)
report.checks.mobile.touchTargets = await ev(`
  (()=>{const m=(sel)=>{const a=[...document.querySelectorAll(sel)];if(!a.length)return null;
  const h=a.map(e=>Math.round(e.getBoundingClientRect().height));
  return{count:a.length,minH:Math.min(...h),maxH:Math.max(...h)}};
  return{chip:m('.ru-mat-chip'),btn:m('.ru-mat-btn'),tab:m('.ru-tab'),fab:m('.outline-fab')}})()`)
await openOutline()
report.checks.mobile.outlineDrawer = await ev(`
  (()=>{const p=document.querySelector('.outline-panel');if(!p)return{found:true,opened:false};
  const cs=getComputedStyle(p);const r=p.getBoundingClientRect();
  return{found:true,opened:true,position:cs.position,left:Math.round(r.left),right:Math.round(window.innerWidth-r.right),
  width:Math.round(r.width),count:p.querySelectorAll('.outline-item').length,
  closeBtn:!!p.querySelector('.outline-close')}})()`)
// 抽屉模式下选中条目应自动收起，避免挡正文
report.checks.mobile.drawerAutoClose = await ev(`
  (()=>{const p=document.querySelector('.outline-panel');if(!p)return null;
  const items=[...p.querySelectorAll('.outline-item')];if(items.length<2)return{count:items.length};
  items[1].click();return{count:items.length}})()`)
await sleep(700)
report.checks.mobile.drawerClosedAfterJump = await ev(`!document.querySelector('.outline-panel')`)
report.checks.mobile.booksWrap = await ev(`
  (()=>{const n=document.querySelector('.ru-mat-nav');if(!n)return null;const r=n.getBoundingClientRect();
  return{navWidth:Math.round(r.width),viewport:window.innerWidth,documentOverflowsX:document.documentElement.scrollWidth>window.innerWidth+2}})()`)

report.consoleErrors = errs
fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8')
console.log(JSON.stringify(report, null, 2))
ws.close(); cleanup(); process.exit(0)