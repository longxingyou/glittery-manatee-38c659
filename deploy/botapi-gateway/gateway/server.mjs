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

const BOT_TOKEN = process.env.BOT_TOKEN || ''
const GATEWAY_SECRET = process.env.GATEWAY_SECRET || ''
const WORK_DIR = path.resolve(process.env.TG_WORK_DIR || '/data/tg')
const BOTAPI_HOST = '127.0.0.1'
const BOTAPI_PORT = Number(process.env.BOTAPI_HTTP_PORT || 8081)
const PORT = Number(process.env.PORT || 8080)

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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

  json(res, 404, { ok: false, error: 'not found' }, corsHeaders(req))
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[gateway] listening on :${PORT}, botapi at ${BOTAPI_HOST}:${BOTAPI_PORT}, workdir ${WORK_DIR}`)
})
