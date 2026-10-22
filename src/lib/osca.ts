/**
 * OSCA 对象存储（中科院高能所 OCloud，S3 兼容）— 最小 SigV4 签名客户端。
 *
 * 用途：文渊（redbean 文档管理器）的异地灾备。归档时 Worker 直接把 Markdown
 * PUT 到 OSCA 桶；cron 对账（wenyuan-sync.ts）周期比对文渊与桶，变更重传、
 * 删除跟随；VPS 故障时 OSCA 仍保有全部归档文本。
 *
 * 配置（wrangler secret put / .dev.vars）：
 *   OSCA_ENDPOINT   公网网关地址，如 https://fgws3-ocloud.ihep.ac.cn
 *   OSCA_BUCKET     桶名（控制台创建）
 *   OSCA_REGION     S3 region，绝大多数 S3 兼容服务固定 us-east-1
 *   OSCA_ACCESS_KEY 秘钥管理页的 AccessKeyId
 *   OSCA_SECRET_KEY 秘钥管理页的 AccessKeySecret
 */
import { getEnv } from './server-env.js'

const encoder = new TextEncoder()

interface OscaCfg {
  endpoint: string
  accessKey: string
  secretKey: string
  bucket: string
  region: string
}

function cfg(): OscaCfg {
  const env = getEnv()
  return {
    endpoint: (env.OSCA_ENDPOINT || '').trim().replace(/\/+$/, ''),
    accessKey: (env.OSCA_ACCESS_KEY || '').trim(),
    secretKey: (env.OSCA_SECRET_KEY || '').trim(),
    bucket: (env.OSCA_BUCKET || '').trim(),
    region: (env.OSCA_REGION || 'us-east-1').trim() || 'us-east-1',
  }
}

export function isOscaConfigured(): boolean {
  const c = cfg()
  return !!(c.endpoint && c.accessKey && c.secretKey && c.bucket)
}

/* ── SigV4 原语（WebCrypto HMAC-SHA256） ── */

async function hmac(key: ArrayBuffer | string, msg: string): Promise<ArrayBuffer> {
  const k = typeof key === 'string' ? encoder.encode(key) : key
  const ck = await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', ck, encoder.encode(msg))
}

async function signingKey(secretKey: string, dateStamp: string, region: string): Promise<ArrayBuffer> {
  let k = await hmac('AWS4' + secretKey, dateStamp)
  k = await hmac(k, region)
  k = await hmac(k, 's3')
  k = await hmac(k, 'aws4_request')
  return k
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function amzNow(d = new Date()): { amzDate: string; dateStamp: string } {
  const iso = d.toISOString().replace(/[:\-]|\.\d{3}/g, '')
  return { amzDate: iso, dateStamp: iso.slice(0, 8) }
}

/** S3 对象 key 做 path 编码：逐段 encodeURIComponent，保留 / 分隔 */
function encodeKey(key: string): string {
  return key.split('/').map((s) => encodeURIComponent(s)).join('/')
}

/**
 * PUT 对象到 OSCA（Worker 直传，SigV4 header 签名）。
 * 30s 超时；失败返回 {ok:false, error}，不抛异常（调用方记日志即可）。
 */
export async function oscaPutObject(
  key: string,
  body: Uint8Array | string,
  contentType = 'application/octet-stream',
): Promise<{ ok: boolean; error?: string }> {
  const c = cfg()
  if (!c.endpoint || !c.accessKey || !c.secretKey || !c.bucket) {
    return { ok: false, error: 'OSCA 未配置（缺 endpoint / accessKey / secretKey / bucket）' }
  }

  const raw = typeof body === 'string' ? encoder.encode(body) : body
  // 拷贝到独立 ArrayBuffer，满足 Workers BodyInit / SubtleCrypto 的 TS 类型约束
  const payload = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer
  const url = new URL(`${c.endpoint}/${c.bucket}/${encodeKey(key)}`)
  const { amzDate, dateStamp } = amzNow()
  const payloadHash = hex(await crypto.subtle.digest('SHA-256', payload))

  const headers: Record<string, string> = {
    host: url.host,
    'content-type': contentType,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }

  const signedKeys = Object.keys(headers).sort()
  const canonicalHeaders = signedKeys.map((k) => `${k}:${headers[k].trim()}\n`).join('')
  const signedHeaders = signedKeys.join(';')

  const canonicalRequest = ['PUT', url.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${dateStamp}/${c.region}/s3/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    hex(await crypto.subtle.digest('SHA-256', encoder.encode(canonicalRequest))),
  ].join('\n')

  const sig = hex(await hmac(await signingKey(c.secretKey, dateStamp, c.region), stringToSign))
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${c.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`

  const res = await fetch(url.toString(), {
    method: 'PUT',
    headers,
    body: payload,
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, error: `OSCA PUT ${res.status}: ${text.slice(0, 200)}` }
  }
  return { ok: true }
}

/**
 * 生成预签名 GET URL（默认 24h 有效）。浏览器/下载器可直接访问，
 * 不占 Worker 子请求。用于管理界面临时下载 OSCA 备份。
 */
export async function oscaPresignedGetUrl(key: string, expiresInSeconds = 86400): Promise<string | null> {
  const c = cfg()
  if (!c.endpoint || !c.accessKey || !c.secretKey || !c.bucket) return null

  const url = new URL(`${c.endpoint}/${c.bucket}/${encodeKey(key)}`)
  const { amzDate, dateStamp } = amzNow()
  const scope = `${dateStamp}/${c.region}/s3/aws4_request`

  const params: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${c.accessKey}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresInSeconds),
    'X-Amz-SignedHeaders': 'host',
  }
  const qs = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&')

  const canonicalRequest = ['GET', url.pathname, qs, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n')
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    hex(await crypto.subtle.digest('SHA-256', encoder.encode(canonicalRequest))),
  ].join('\n')

  const sig = hex(await hmac(await signingKey(c.secretKey, dateStamp, c.region), stringToSign))
  url.search = `${qs}&X-Amz-Signature=${sig}`
  return url.toString()
}

/**
 * DELETE 对象（wenyuan-sync 对账删除用）。404 视为已删除（幂等）。
 */
export async function oscaDeleteObject(key: string): Promise<{ ok: boolean; error?: string }> {
  const c = cfg()
  if (!c.endpoint || !c.accessKey || !c.secretKey || !c.bucket) {
    return { ok: false, error: 'OSCA 未配置（缺 endpoint / accessKey / secretKey / bucket）' }
  }

  const url = new URL(`${c.endpoint}/${c.bucket}/${encodeKey(key)}`)
  const { amzDate, dateStamp } = amzNow()
  const emptyHash = hex(await crypto.subtle.digest('SHA-256', new Uint8Array(0)))

  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': emptyHash,
    'x-amz-date': amzDate,
  }
  const signedKeys = Object.keys(headers).sort()
  const canonicalHeaders = signedKeys.map((k) => `${k}:${headers[k].trim()}\n`).join('')
  const signedHeaders = signedKeys.join(';')

  const canonicalRequest = ['DELETE', url.pathname, '', canonicalHeaders, signedHeaders, emptyHash].join('\n')
  const scope = `${dateStamp}/${c.region}/s3/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    hex(await crypto.subtle.digest('SHA-256', encoder.encode(canonicalRequest))),
  ].join('\n')

  const sig = hex(await hmac(await signingKey(c.secretKey, dateStamp, c.region), stringToSign))
  const res = await fetch(url.toString(), {
    method: 'DELETE',
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
    },
    signal: AbortSignal.timeout(15_000),
  })
  // S3 DELETE 成功返回 204；对象本就不存在返回 404，同样视为已删除
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '')
    return { ok: false, error: `OSCA DELETE ${res.status}: ${text.slice(0, 200)}` }
  }
  return { ok: true }
}

/** 文渊文档在桶内的稳定 key：按文档 id（wen 返回的字符串 id）而非标题，改名不受影响 */
export function oscaDocKey(docId: string): string {
  return `wenyuan/docs/${docId}.md`
}
