/**
 * Syntax Garden 附件预览转换 worker（容器内常驻，单任务串行）。
 *
 * 循环：POST Worker ?action=convert-poll 认领任务 → 从网关 /dl 拉源文件 →
 * soffice --headless 转 PDF → PUT 网关 /preview-put → 回报 convert-done。
 * 任何一步失败都回报 ok:false，由 Worker 决定重试（最多 3 次）或置 failed。
 *
 * 环境变量（compose env_file .env）：
 *   WORKER_ORIGIN        站点公开源（如 https://wow.xn--fpr224a.mom）
 *   CONVERTER_SECRET     与 Worker secret 相同
 *   GW_INTERNAL_ORIGIN   可选；同机 docker 网络地址 http://gateway:8080，
 *                        替换签名 URL 的 origin，省掉 Cloudflare 绕一圈
 *   POLL_INTERVAL_MS     无任务时的轮询间隔（默认 5000）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const WORKER_ORIGIN = (process.env.WORKER_ORIGIN || process.env.PUBLIC_ORIGIN || '').replace(/\/+$/, '')
const CONVERTER_SECRET = process.env.CONVERTER_SECRET || ''
const GW_INTERNAL = (process.env.GW_INTERNAL_ORIGIN || '').replace(/\/+$/, '')
const POLL_MS = Math.max(2000, Number(process.env.POLL_INTERVAL_MS) || 5000)

const DOWNLOAD_TIMEOUT_MS = 5 * 60_000
const CONVERT_TIMEOUT_MS = 240_000
const PUT_TIMEOUT_MS = 3 * 60_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[converter ${new Date().toISOString()}]`, ...a)

if (!WORKER_ORIGIN || !CONVERTER_SECRET) {
  console.error('[converter] FATAL: WORKER_ORIGIN / CONVERTER_SECRET 未配置')
  process.exit(1)
}

/** 把签名 URL 的公开 origin 换成 docker 内网 origin（签名只覆盖路径与查询） */
function internalize(url) {
  if (!GW_INTERNAL) return url
  try {
    const u = new URL(url)
    return `${GW_INTERNAL}${u.pathname}${u.search}`
  } catch {
    return url
  }
}

async function workerFetch(url, init = {}, timeoutMs = 60_000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function poll() {
  const res = await workerFetch(`${WORKER_ORIGIN}/api/comments?action=convert-poll`, {
    method: 'POST',
    headers: { 'x-converter-secret': CONVERTER_SECRET },
  }, 30_000)
  if (res.status === 204) return null
  if (!res.ok) throw new Error(`poll HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
  const data = await res.json()
  return data.job || null
}

async function report(id, ok, size, error) {
  try {
    await workerFetch(`${WORKER_ORIGIN}/api/comments?action=convert-done`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-converter-secret': CONVERTER_SECRET },
      body: JSON.stringify({ id, ok, ...(typeof size === 'number' ? { size } : {}), ...(error ? { error: String(error).slice(0, 300) } : {}) }),
    }, 30_000)
  } catch (e) {
    log('report failed:', e.message)
  }
}

/** 流式下载源文件到临时路径，返回字节数 */
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS)
    fetch(url, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`)
        const ws = createWriteStream(dest)
        let bytes = 0
        const reader = res.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.length
          await new Promise((r, j) => ws.write(value, (e) => (e ? j(e) : r())))
        }
        await new Promise((r, j) => ws.close((e) => (e ? j(e) : r())))
        clearTimeout(timer)
        resolve(bytes)
      })
      .catch((e) => {
        clearTimeout(timer)
        reject(e)
      })
  })
}

/** 调 soffice 转 PDF，返回产物路径 */
function runSoffice(srcPath, outDir, profileDir) {
  return new Promise((resolve, reject) => {
    const args = [
      '--headless', '--norestore', '--invisible', '--nodefault', '--nolockcheck',
      `-env:UserInstallation=file://${profileDir}`,
      '--convert-to', 'pdf',
      '--outdir', outDir,
      srcPath,
    ]
    const child = spawn('soffice', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (b) => { stderr += b.toString().slice(0, 1000) })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('soffice timeout'))
    }, CONVERT_TIMEOUT_MS)
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`soffice exit ${code}: ${stderr.slice(-300)}`))
      const base = path.basename(srcPath).replace(/\.[^.]+$/, '')
      resolve(path.join(outDir, `${base}.pdf`))
    })
  })
}

/** 校验产物确实是 PDF（%PDF 魔数） */
async function asPdf(file) {
  const buf = Buffer.alloc(5)
  const fh = await fs.open(file, 'r')
  try {
    await fh.read(buf, 0, 5, 0)
  } finally {
    await fh.close()
  }
  return buf.toString('latin1').startsWith('%PDF-')
}

async function handleJob(job) {
  const id = job.id
  const ext = String(job.ext || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'bin'
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-'))
  const src = path.join(dir, `source.${ext}`)
  const profile = path.join(dir, 'lo-profile')
  try {
    log(`#${id} downloading ${job.filename}`)
    await download(internalize(job.sourceUrl), src)
    log(`#${id} converting`)
    const pdfPath = await runSoffice(src, dir, profile)
    const st = await fs.stat(pdfPath).catch(() => null)
    if (!st || st.size === 0) throw new Error('pdf missing/empty')
    if (!(await asPdf(pdfPath))) throw new Error('output is not pdf')
    log(`#${id} uploading pdf (${st.size} bytes)`)
    const buf = await fs.readFile(pdfPath)
    const putRes = await workerFetch(internalize(job.putUrl), {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf', 'content-length': String(buf.length) },
      body: buf,
    }, PUT_TIMEOUT_MS)
    if (!putRes.ok) throw new Error(`put HTTP ${putRes.status}`)
    await report(id, true, st.size)
    log(`#${id} done`)
  } catch (e) {
    log(`#${id} failed: ${e.message}`)
    await report(id, false, undefined, e.message)
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

let running = false
async function loop() {
  if (running) return
  running = true
  try {
    const job = await poll()
    if (job) await handleJob(job)
  } catch (e) {
    log('poll error:', e.message)
    await sleep(15_000)
  } finally {
    running = false
  }
  setTimeout(loop, POLL_MS)
}

// 未捕获异常不杀进程：容器 restart 策略之外的最后一道防线
process.on('unhandledRejection', (e) => log('unhandledRejection:', e?.message || e))
log(`started; worker=${WORKER_ORIGIN} internal=${GW_INTERNAL || 'off'} poll=${POLL_MS}ms`)
loop()
