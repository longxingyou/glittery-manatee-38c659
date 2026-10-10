/**
 * Syntax Garden 附件网关（零依赖 Node 脚本，跑在本地 telegram-bot-api 前面）。
 *
 * 对外三个面：
 *  1. POST /api/:method   Worker 服务端调用（x-sg-admin 签名，JSON/multipart 透传）
 *  2. POST /upload?chat=  管理员浏览器直传分片（x-sg-token 签名，multipart 透传）
 *  3. GET  /file?f=&t=    游客下载（file_id + 签名，网关调本地 getFile 落盘后
 *                         按 HTTP Range 流式回吐，支持断点续传）
 *
 * 设计要点：
 *  - Bot Token 只存在于容器内，浏览器永远拿不到；浏览器/Worker 只能出示
 *    GATEWAY_SECRET 签发的短期 HMAC 令牌。
 *  - /file 每次按 file_id getFile：--local 模式下文件缺失时 botapi 会自动
 *    从 Telegram 机房重新拉回，所以临时文件被清理不影响可下载性。
 *  - 定期清理媒体目录中的陈旧文件（容器磁盘只做临时缓冲，不是存储）。
 */
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'

const BOT_TOKEN = process.env.BOT_TOKEN || ''
const GATEWAY_SECRET = process.env.GATEWAY_SECRET || ''
const WORK_DIR = path.resolve(process.env.TG_WORK_DIR || '/data/tg')
const PREVIEW_DIR = path.resolve(process.env.PREVIEW_DIR || '/data/previews')
const BOTAPI_HOST = '127.0.0.1'
const BOTAPI_PORT = Number(process.env.BOTAPI_HTTP_PORT || 8081)
const PORT = Number(process.env.PORT || 8080)

// 转换后 PDF 体积上限（converter 回传；超过直接拒绝）
const PREVIEW_PDF_MAX = 200 * 1024 * 1024
fs.mkdirSync(PREVIEW_DIR, { recursive: true })

// 允许跨域调用的浏览器源（Worker → 网关是服务端调用，不受 CORS 约束）
const ALLOWED_ORIGINS = (process.env.PUBLIC_ORIGIN || '')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean)
const ALLOW_ALL = process.env.ALLOW_ALL_ORIGINS === '1'

// /api 白名单：即使签名泄露，能调用的方法也收敛在附件业务范围内
const METHOD_ALLOWLIST = new Set([
  'getMe',
  'getChat',
  'getUpdates',
  'sendDocument',
  'getFile',
  'deleteMessage',
  'deleteMessages',
])

const FILE_TTL_MS = 12 * 60 * 60 * 1000
const ADMIN_TTL_MS = 15 * 60 * 1000
const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000
const FILE_PATH_CACHE_MS = 10 * 60 * 1000

// botapi 媒体子目录名（清理只在这些目录内进行，绝不碰会话/binlog 状态文件）
const MEDIA_DIRS = [
  'documents', 'photos', 'videos', 'video_notes', 'voice', 'audio',
  'animations', 'stickers', 'encrypted', 'custom_emoji', 'stories',
]

if (!BOT_TOKEN || !GATEWAY_SECRET) {
  console.error('[gateway] FATAL: BOT_TOKEN / GATEWAY_SECRET 未配置')
  process.exit(1)
}

// ── HMAC 令牌：<exp>.<payloadB64url>.<sigB64url> ──

function b64url(input) {
  return Buffer.from(input).toString('base64url')
}

function hmac(kind, exp, payload) {
  return crypto
    .createHmac('sha256', GATEWAY_SECRET)
    .update(`${kind}.${exp}.${payload}`)
    .digest('base64url')
}

/** 校验令牌；通过返回 payload，失败返回 null */
function verifyToken(kind, token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [expStr, payloadB64, sig] = parts
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || Date.now() > exp) return null
  let payload
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString('utf8')
  } catch {
    return null
  }
  const expected = hmac(kind, exp, payload)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  return payload
}

// ── CORS / 响应工具 ──

function corsHeaders(req) {
  const origin = req.headers.origin
  const allow = ALLOW_ALL ? '*' : ALLOWED_ORIGINS.includes(origin) ? origin : ''
  return {
    ...(allow ? { 'Access-Control-Allow-Origin': allow } : {}),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-sg-admin, x-sg-token, range',
    'Access-Control-Expose-Headers': 'content-length, content-range, x-total-size',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function json(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(body)
}

// ── 与本地 botapi 的通信 ──

/** 把整个 HTTP 请求透传给本地 botapi（GET 透传 query，POST 透传 body） */
function proxyToBotapi(method, req, res) {
  const targetPath = `/bot${BOT_TOKEN}/${method}${req.url.includes('?') ? `?${req.url.split('?')[1]}` : ''}`
  const fwdHeaders = {}
  if (req.headers['content-type']) fwdHeaders['content-type'] = req.headers['content-type']
  if (req.headers['content-length']) fwdHeaders['content-length'] = req.headers['content-length']
  const up = http.request(
    { host: BOTAPI_HOST, port: BOTAPI_PORT, path: targetPath, method: req.method, headers: fwdHeaders },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, {
        'content-type': upRes.headers['content-type'] || 'application/json',
        'cache-control': 'no-store',
        ...corsHeaders(req),
      })
      upRes.pipe(res)
    },
  )
  up.on('error', (e) => {
    json(res, 502, { ok: false, error: `botapi 不可用：${e.message}` }, corsHeaders(req))
  })
  if (req.method === 'POST') req.pipe(up)
  else up.end()
}

/** 网关内部用：JSON 调本地 botapi */
function callBotapi(method, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const up = http.request(
      {
        host: BOTAPI_HOST,
        port: BOTAPI_PORT,
        path: `/bot${BOT_TOKEN}/${method}`,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (upRes) => {
        let raw = ''
        upRes.setEncoding('utf8')
        upRes.on('data', (c) => { raw += c })
        upRes.on('end', () => {
          try {
            resolve({ status: upRes.statusCode || 0, data: JSON.parse(raw) })
          } catch {
            resolve({ status: upRes.statusCode || 0, data: { ok: false, description: raw.slice(0, 300) } })
          }
        })
      },
    )
    up.on('error', reject)
    up.end(body)
  })
}

let lastGetMe = { ok: false, at: 0 }
async function botapiReady() {
  if (Date.now() - lastGetMe.at < 30_000) return lastGetMe.ok
  try {
    const r = await callBotapi('getMe', {})
    lastGetMe = { ok: !!r.data?.ok, at: Date.now() }
  } catch {
    lastGetMe = { ok: false, at: Date.now() }
  }
  return lastGetMe.ok
}

// file_id → 本地绝对路径（缓存 10 分钟；getFile 会在文件缺失时自动回源）
const filePathCache = new Map()

async function resolveLocalPath(fileId) {
  const hit = filePathCache.get(fileId)
  if (hit && hit.exp > Date.now()) return hit.path
  const r = await callBotapi('getFile', { file_id: fileId })
  if (!r.data?.ok || !r.data.result?.file_path) {
    const err = new Error(r.data?.description || `getFile 失败 (${r.status})`)
    err.status = 502
    throw err
  }
  const abs = path.resolve(r.data.result.file_path)
  const base = WORK_DIR + path.sep
  if (abs !== WORK_DIR && !abs.startsWith(base)) {
    const err = new Error('file_path 越界')
    err.status = 400
    throw err
  }
  if (filePathCache.size > 256) filePathCache.clear()
  filePathCache.set(fileId, { path: abs, exp: Date.now() + FILE_PATH_CACHE_MS })
  return abs
}

// ── /file：Range 流式回吐 ──

function serveFile(req, res, fileId) {
  resolveLocalPath(fileId)
    .then((abs) => fs.promises.stat(abs).then((st) => ({ abs, st })))
    .then(({ abs, st }) => {
      if (!st.isFile()) return json(res, 404, { ok: false, error: '文件不存在' }, corsHeaders(req))
      // 滚动续期 mtime：长时间下载（慢链路可能数小时）途中防止被 cleanOnce 误删
      fsp.utimes(abs, new Date(), new Date()).catch(() => undefined)
      const size = st.size
      let start = 0
      let end = size - 1
      let isRange = false
      const m = /^bytes=(\d+)-(\d*)$/.exec((req.headers.range || '').trim())
      if (m) {
        start = Number(m[1])
        if (m[2]) end = Number(m[2])
        if (Number.isFinite(start) && start < size) {
          isRange = true
          end = Math.min(end, size - 1)
        } else {
          res.writeHead(416, { 'Content-Range': `bytes */${size}`, ...corsHeaders(req) })
          return res.end()
        }
      }
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}`, ...corsHeaders(req) })
        return res.end()
      }
      const headers = {
        'content-type': 'application/octet-stream',
        'accept-ranges': 'bytes',
        'content-length': String(end - start + 1),
        'cache-control': 'private, no-store',
        ...corsHeaders(req),
      }
      if (isRange) {
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}` })
      } else {
        res.writeHead(200, headers)
      }
      const stream = fs.createReadStream(abs, { start, end })
      stream.on('error', () => { if (!res.headersSent) json(res, 500, { ok: false, error: '读取失败' }, corsHeaders(req)); else res.destroy() })
      stream.pipe(res)
    })
    .catch((e) => {
      json(res, e.status || 502, { ok: false, error: e.message || '文件解析失败' }, corsHeaders(req))
    })
}

// ── /dl：多片顺序拼接成整文件流直发（手机/普通浏览器原生下载；Worker 302 跳来）──

/** RFC 5987 文件名头（非 ASCII 走 filename*）；inline 用于页内原生 PDF 查看器 */
function contentDisposition(filename, inline = false) {
  const fallback = String(filename || 'file').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file'
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(String(filename || 'file'))}`
}

/**
 * 整流直发：parts=[{f,s}] 按序拼接；Range 的全局偏移映射到起始分片与片内偏移。
 * 同时支持普通范围（bytes=0-99 / bytes=0-）与后缀范围（bytes=-N，RFC 7233，
 * Chrome 等原生 PDF 查看器读 xref 时会发）。
 * 后台先预热解析全部片路径并滚动 mtime，防止慢速长下载途中被 cleanOnce 清掉。
 */
function serveManifest(req, res, filename, mimeType, parts, total, headOnly = false, inline = false) {
  let start = 0
  let isRange = false
  let rangeEnd = null
  const rangeHdr = (req.headers.range || '').trim()
  const mSuffix = /^bytes=-(\d+)$/.exec(rangeHdr)
  const mNormal = /^bytes=(\d+)-(\d*)$/.exec(rangeHdr)
  if (mSuffix) {
    const n = Number(mSuffix[1])
    if (n > 0) {
      start = Math.max(0, total - n)
      isRange = true
    }
  } else if (mNormal) {
    const s = Number(mNormal[1])
    if (Number.isFinite(s) && s < total) {
      start = s
      isRange = true
      if (mNormal[2]) rangeEnd = Number(mNormal[2])
    } else {
      res.writeHead(416, { 'Content-Range': `bytes */${total}`, ...corsHeaders(req) })
      return res.end()
    }
  }
  let length = total - start
  if (rangeEnd !== null) length = Math.min(length, rangeEnd - start + 1)
  if (length <= 0) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}`, ...corsHeaders(req) })
    return res.end()
  }

  res.writeHead(isRange ? 206 : 200, {
    'content-type': typeof mimeType === 'string' && mimeType ? mimeType : 'application/octet-stream',
    'accept-ranges': 'bytes',
    'content-length': String(length),
    'content-disposition': contentDisposition(filename, inline),
    'cache-control': 'private, no-store',
    ...(isRange ? { 'Content-Range': `bytes ${start}-${start + length - 1}/${total}` } : {}),
    ...corsHeaders(req),
  })
  // HEAD：部分移动下载器正式下载前先探测，只回头不回体
  if (headOnly) return res.end()

  // 预热：解析 + 滚动 mtime（慢链路下整文件可能传数小时，晚到的分片先续期）
  for (const part of parts) {
    resolveLocalPath(part.f)
      .then((abs) => fsp.utimes(abs, new Date(), new Date()).catch(() => undefined))
      .catch(() => undefined)
  }

  // 顺序拼片：pipe(res, {end:false})，一片流完接下一片；失败/客户端断开即断流
  let idx = 0
  let skip = start
  while (idx < parts.length && skip >= parts[idx].s) {
    skip -= parts[idx].s
    idx++
  }
  let remaining = length
  const pump = async () => {
    while (idx < parts.length && remaining > 0) {
      const part = parts[idx]
      let abs
      try {
        abs = await resolveLocalPath(part.f)
      } catch (e) {
        console.error('[dl] resolve failed:', e.message)
        return res.destroy()
      }
      fsp.utimes(abs, new Date(), new Date()).catch(() => undefined)
      const from = skip
      skip = 0
      const to = Math.min(part.s - 1, from + remaining - 1)
      const stream = fs.createReadStream(abs, { start: from, end: to })
      const ok = await new Promise((resolve) => {
        const onResClose = () => {
          if (!res.writableEnded) stream.destroy()
        }
        const done = (v) => {
          res.off('close', onResClose)
          resolve(v)
        }
        res.on('close', onResClose)
        stream.on('error', () => done(false))
        stream.on('close', () => done(false))
        stream.on('end', () => done(true))
        stream.pipe(res, { end: false })
      })
      if (!ok) return res.destroy()
      remaining -= to - from + 1
      idx++
    }
    res.end()
  }
  pump().catch(() => res.destroy())
}

// ── 预览 PDF：converter 回传写盘 / 浏览器 Range 读取 / 附件删除时清理 ──

function previewPath(id) {
  return path.join(PREVIEW_DIR, `${id}.pdf`)
}

/** 校验 URL 里的 id 段为纯数字（防路径穿越） */
function parsePreviewId(seg) {
  return /^\d{1,12}$/.test(seg || '') ? Number(seg) : null
}

/** PUT /preview-put/:id：整文件写入（先写 .tmp 再 rename，避免半文件被读到） */
function handlePreviewPut(req, res, id) {
  const tmp = path.join(PREVIEW_DIR, `${id}.pdf.tmp`)
  const ws = fs.createWriteStream(tmp)
  let bytes = 0
  let aborted = false
  req.on('data', (chunk) => {
    bytes += chunk.length
    if (bytes > PREVIEW_PDF_MAX) {
      aborted = true
      req.destroy()
      ws.destroy()
      fsp.unlink(tmp).catch(() => undefined)
      json(res, 413, { ok: false, error: 'preview too large' }, corsHeaders(req))
    }
  })
  ws.on('error', () => {
    if (!aborted) json(res, 500, { ok: false, error: 'write failed' }, corsHeaders(req))
  })
  req.pipe(ws)
  ws.on('finish', () => {
    if (aborted) return
    fsp.rename(tmp, previewPath(id))
      .then(() => json(res, 200, { ok: true, size: bytes }, corsHeaders(req)))
      .catch((e) => json(res, 500, { ok: false, error: e.message }, corsHeaders(req)))
  })
  req.on('aborted', () => {
    aborted = true
    ws.destroy()
    fsp.unlink(tmp).catch(() => undefined)
  })
}

/** GET /preview/:id：Range 读取已转换 PDF（inline，交给 PDF.js/浏览器） */
function servePreview(req, res, id, headOnly = false) {
  const abs = previewPath(id)
  fsp.stat(abs)
    .then((st) => {
      if (!st.isFile()) return json(res, 404, { ok: false, error: 'preview missing' }, corsHeaders(req))
      const size = st.size
      let start = 0
      let end = size - 1
      let isRange = false
      const m = /^bytes=(\d+)-(\d*)$/.exec((req.headers.range || '').trim())
      if (m) {
        start = Number(m[1])
        if (m[2]) end = Number(m[2])
        if (Number.isFinite(start) && start < size) {
          isRange = true
          end = Math.min(end, size - 1)
        } else {
          res.writeHead(416, { 'Content-Range': `bytes */${size}`, ...corsHeaders(req) })
          return res.end()
        }
      }
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}`, ...corsHeaders(req) })
        return res.end()
      }
      res.writeHead(isRange ? 206 : 200, {
        'content-type': 'application/pdf',
        'accept-ranges': 'bytes',
        'content-length': String(end - start + 1),
        'content-disposition': `inline; filename="preview-${id}.pdf"`,
        'cache-control': 'private, max-age=3600',
        ...(isRange ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
        ...corsHeaders(req),
      })
      if (headOnly) return res.end()
      const stream = fs.createReadStream(abs, { start, end })
      stream.on('error', () => { if (!res.headersSent) json(res, 500, { ok: false, error: 'read failed' }, corsHeaders(req)); else res.destroy() })
      stream.pipe(res)
    })
    .catch(() => json(res, 404, { ok: false, error: 'preview missing' }, corsHeaders(req)))
}

// ── 临时文件清理：媒体目录内 >30 分钟的文件一律删除（getFile 会自动回源重拉） ──

async function cleanOnce() {
  let cleaned = 0
  for (const dir of MEDIA_DIRS) {
    const root = path.join(WORK_DIR, dir)
    try {
      const walk = async (d) => {
        let entries = []
        try { entries = await fsp.readdir(d, { withFileTypes: true }) } catch { return }
        for (const ent of entries) {
          const full = path.join(d, ent.name)
          if (ent.isDirectory()) { await walk(full); continue }
          try {
            const st = await fsp.stat(full)
            if (Date.now() - st.mtimeMs > 30 * 60 * 1000) {
              await fsp.unlink(full)
              cleaned++
            }
          } catch { /* 竞态删除/权限：忽略 */ }
        }
      }
      await walk(root)
    } catch { /* 目录不存在：忽略 */ }
  }
  if (cleaned > 0) console.log(`[cleanup] removed ${cleaned} stale media files`)
}
setInterval(() => { cleanOnce().catch(() => undefined) }, 5 * 60 * 1000).unref()
cleanOnce().catch(() => undefined)

// ── 神经语音合成（Edge Read Aloud，俄语 Svetlana/Dmitry，无需 API key）──
// 手机浏览器普遍没有 ru-RU 本地合成语音；俄语工具箱前端在移动设备上改用
// <audio> 播放本端点返回的 mp3。神经语音对完整句子有自然韵律，疑问句升调、
// 停顿与重音由模型按语境生成，解决本地合成机械、无句调的问题。
const TTS_MAX_TEXT = 600
const TTS_CACHE_MAX = 400
const ttsCache = new Map() // sha1(text|voice|rate) → mp3 Buffer
let ttsActive = 0
const TTS_MAX_CONCURRENT = 4
const ttsWaiters = []

function ttsCacheKey(text, voice, rate) {
  return crypto.createHash('sha1').update(`${voice}|${rate}|${text}`).digest('hex')
}

// toStream 内部把文本嵌入 SSML 模板；转义 XML 特殊字符，防止文本里含 <>& 破坏请求
function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

async function synthesizeMp3(text, voice, rateMultiplier) {
  // 并发限流：超出排队等待，避免瞬间建立大量到微软的 WebSocket
  if (ttsActive >= TTS_MAX_CONCURRENT) {
    await new Promise((resolve) => ttsWaiters.push(resolve))
  }
  ttsActive++
  let client = null
  try {
    client = new MsEdgeTTS()
    await client.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
    // rate 为相对倍速（0.5 = 半速）；输入先做 XML 转义
    const { audioStream } = client.toStream(escapeXml(text), { rate: rateMultiplier })
    const chunks = []
    for await (const chunk of audioStream) chunks.push(chunk)
    return Buffer.concat(chunks)
  } finally {
    try { client?.close() } catch { /* ignore */ }
    ttsActive--
    const next = ttsWaiters.shift()
    if (next) next()
  }
}

// ── HTTP 路由 ──

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', 'http://localhost')
  const p = u.pathname

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req))
    return res.end()
  }

  if (p === '/' || p === '/healthz') {
    const ready = await botapiReady()
    return json(res, ready ? 200 : 503, { ok: ready, service: 'sg-bot-gateway' }, corsHeaders(req))
  }

  // 0.5) 俄语神经语音：GET /tts?text=&rate=0.8&voice=s  → audio/mpeg（公开端点）
  if (p === '/tts' && req.method === 'GET') {
    const text = (u.searchParams.get('text') || '').trim()
    if (!text || text.length > TTS_MAX_TEXT) {
      return json(res, 400, { ok: false, error: 'bad text' }, corsHeaders(req))
    }
    const rateParsed = Number(u.searchParams.get('rate') || '0.8')
    const rate = Math.min(1.5, Math.max(0.4, Number.isFinite(rateParsed) ? rateParsed : 0.8))
    const voice = u.searchParams.get('voice') === 'd'
      ? 'ru-RU-DmitryNeural'
      : 'ru-RU-SvetlanaNeural'
    const key = ttsCacheKey(text, voice, rate.toFixed(2))
    let buf = ttsCache.get(key)
    if (!buf) {
      try {
        buf = await synthesizeMp3(text, voice, rate)
      } catch (e) {
        console.error('[tts] synth failed:', e?.message || e)
        return json(res, 502, { ok: false, error: 'tts failed' }, corsHeaders(req))
      }
      if (buf.length === 0) {
        return json(res, 502, { ok: false, error: 'empty audio' }, corsHeaders(req))
      }
      if (ttsCache.size >= TTS_CACHE_MAX) {
        const oldestKey = ttsCache.keys().next().value
        ttsCache.delete(oldestKey)
      }
      ttsCache.set(key, buf)
    }
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': buf.length,
      // 合成音频永不变化：浏览器/CDN 可长缓存
      'Cache-Control': 'public, max-age=86400',
      ...corsHeaders(req),
    })
    return res.end(buf)
  }

  // 0.6) B站 playurl 代理：GET /bili-playurl?bvid=|&aid=&cid=（x-sg-bili 签名）
  // 只透传小 JSON，视频流本身不经网关（html5 直链无 Referer 鉴权，浏览器直连 CDN）。
  // 背景：playurl 仅接受 *.bilibili.com 的 Referer，第三方/空 Referer 返回 403；
  // Cloudflare 数据中心出口又被 B站 WAF 以 412 拦截，故改由本网关出口转发。
  if (p === '/bili-playurl' && req.method === 'GET') {
    const bvid = (u.searchParams.get('bvid') || '').trim()
    const aid = (u.searchParams.get('aid') || '').trim()
    const cid = (u.searchParams.get('cid') || '').trim()
    const useBvid = /^BV[0-9A-Za-z]{10}$/.test(bvid)
    if (!useBvid && !/^\d{6,}$/.test(aid)) {
      return json(res, 400, { ok: false, error: 'bad id' }, corsHeaders(req))
    }
    if (!/^\d+$/.test(cid) || Number(cid) <= 0) {
      return json(res, 400, { ok: false, error: 'bad cid' }, corsHeaders(req))
    }
    const payload = `${useBvid ? 'bvid' : 'aid'}.${useBvid ? bvid : aid}.${cid}`
    if (verifyToken('bili', req.headers['x-sg-bili']) !== payload) {
      return json(res, 401, { ok: false, error: 'bad bili token' }, corsHeaders(req))
    }
    const idParam = useBvid ? `bvid=${encodeURIComponent(bvid)}` : `aid=${encodeURIComponent(aid)}`
    const api =
      `https://api.bilibili.com/x/player/playurl?${idParam}&cid=${cid}` +
      '&platform=html5&high_quality=1&qn=64&fnval=1'
    let r
    try {
      r = await fetch(api, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
          Referer: 'https://www.bilibili.com/',
          Accept: 'application/json, text/plain, */*',
        },
        signal: AbortSignal.timeout(10000),
      })
    } catch {
      return json(res, 502, { ok: false, error: 'bili fetch failed' }, corsHeaders(req))
    }
    const text = await r.text().catch(() => '')
    if (!r.ok) {
      return json(res, 502, { ok: false, error: `bili HTTP ${r.status}` }, corsHeaders(req))
    }
    let data
    try {
      data = JSON.parse(text)
    } catch {
      return json(res, 502, { ok: false, error: 'bili non-json' }, corsHeaders(req))
    }
    if (data.code !== 0 || !data.data?.durl?.[0]?.url) {
      return json(res, 502, { ok: false, error: `bili code ${data.code ?? '?'}: ${data.message || ''}` }, corsHeaders(req))
    }
    const d = data.data.durl[0]
    return json(res, 200, {
      ok: true,
      quality: data.data.quality ?? null,
      streams: [d.url, ...(d.backup_url || [])].filter(Boolean),
    }, corsHeaders(req))
  }

  // 1) Worker → botapi（白名单方法 + admin 签名）
  let mm = /^\/api\/([A-Za-z]+)$/.exec(p)
  if (mm && (req.method === 'POST' || req.method === 'GET')) {
    const method = mm[1]
    if (!METHOD_ALLOWLIST.has(method)) return json(res, 403, { ok: false, error: 'method not allowed' }, corsHeaders(req))
    if (verifyToken('admin', req.headers['x-sg-admin']) !== method) {
      return json(res, 401, { ok: false, error: 'bad admin token' }, corsHeaders(req))
    }
    return proxyToBotapi(method, req, res)
  }

  // 2) 浏览器直传分片：token 绑定 chat，query 里的 chat 必须与签名一致
  if (p === '/upload' && req.method === 'POST') {
    const chat = u.searchParams.get('chat') || ''
    if (!chat || verifyToken('upload', req.headers['x-sg-token']) !== chat) {
      return json(res, 401, { ok: false, error: 'bad upload token' }, corsHeaders(req))
    }
    return proxyToBotapi('sendDocument', req, res)
  }

  // 3) 浏览器/Worker 按 file_id 下载（Range）
  if (p === '/file' && req.method === 'GET') {
    const fileId = u.searchParams.get('f') || ''
    if (!fileId || verifyToken('file', u.searchParams.get('t') || '') !== fileId) {
      return json(res, 401, { ok: false, error: 'bad file token' }, corsHeaders(req))
    }
    return serveFile(req, res, fileId)
  }

  // 4) 整文件顺序拼片直发：token 内含 {n:文件名, m:MIME, p:[[file_id,字节数],...]}
  //    手机/普通浏览器原生下载走这里（Worker 302 跳转），支持 Range 断点续传
  if (p === '/dl' && (req.method === 'GET' || req.method === 'HEAD')) {
    const raw = verifyToken('dl', u.searchParams.get('t') || '')
    let spec = null
    try { spec = raw ? JSON.parse(raw) : null } catch { spec = null }
    if (!spec || typeof spec.n !== 'string' || !Array.isArray(spec.p) || spec.p.length === 0 || spec.p.length > 512) {
      return json(res, 401, { ok: false, error: 'bad dl token' }, corsHeaders(req))
    }
    const parts = []
    let total = 0
    for (const it of spec.p) {
      const f = Array.isArray(it) ? it[0] : null
      const s = Array.isArray(it) ? Number(it[1]) : NaN
      if (typeof f !== 'string' || !f || f.length > 256 || !Number.isInteger(s) || s <= 0) {
        return json(res, 400, { ok: false, error: 'bad dl part' }, corsHeaders(req))
      }
      parts.push({ f, s })
      total += s
      if (total > 4 * 1024 * 1024 * 1024) {
        return json(res, 400, { ok: false, error: 'dl too big' }, corsHeaders(req))
      }
    }
    // inline=1 仅影响浏览器呈现方式（页内查看器 vs 下载），令牌仍是唯一访问凭据
    return serveManifest(req, res, spec.n, spec.m, parts, total, req.method === 'HEAD', u.searchParams.get('inline') === '1')
  }

  // 5) 预览 PDF：converter 写入（PUT）/ 浏览器 Range 读取（GET、HEAD）/ 删除（DELETE）
  let mpv = /^\/preview(?:-put)?\/(\d{1,12})$/.exec(p)
  if (p.startsWith('/preview-put/') && req.method === 'PUT') {
    const id = parsePreviewId(p.split('/').pop())
    if (id === null || verifyToken('pvput', u.searchParams.get('t') || '') !== String(id)) {
      return json(res, 401, { ok: false, error: 'bad preview put token' }, corsHeaders(req))
    }
    return handlePreviewPut(req, res, id)
  }
  if (mpv && p.startsWith('/preview/') && (req.method === 'GET' || req.method === 'HEAD')) {
    const id = parsePreviewId(mpv[1])
    if (id === null || verifyToken('pvget', u.searchParams.get('t') || '') !== String(id)) {
      return json(res, 401, { ok: false, error: 'bad preview token' }, corsHeaders(req))
    }
    return servePreview(req, res, id, req.method === 'HEAD')
  }
  if (mpv && p.startsWith('/preview/') && req.method === 'DELETE') {
    const id = parsePreviewId(mpv[1])
    if (id === null || verifyToken('pvdel', u.searchParams.get('t') || '') !== String(id)) {
      return json(res, 401, { ok: false, error: 'bad preview delete token' }, corsHeaders(req))
    }
    await fsp.unlink(previewPath(id)).catch(() => undefined)
    return json(res, 200, { ok: true }, corsHeaders(req))
  }

  json(res, 404, { ok: false, error: 'not found' }, corsHeaders(req))
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[gateway] listening on :${PORT}, botapi at ${BOTAPI_HOST}:${BOTAPI_PORT}, workdir ${WORK_DIR}`)
})
