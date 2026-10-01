/**
 * 大附件存储 v2：MTProto 个人账号直连（Telegram 用户会话，非 bot）。
 *
 * 背景：Bot API 非对称限制（上传 50MB、getFile 下载仅 20MB）：bot 方案
 * 上传侧每片 47MiB、1.2GB 也要 26 条消息，仍受消息频率与多层网关限制，
 * 且 47MiB 分片无法靠 getFile 下载。用户会话走 MTProto 后单文件直传可达
 * 2GB（Premium 4GB）、频率配额宽松，且 Worker 下载只占用一条 WebSocket
 * （消息帧不计 subrequest），绕开 50 次/请求上限。tg1 bot 分片的下载同样
 * 经本模块按消息 id 逐 256KiB 窗口回源（用户账号须在同一存储频道）。
 *
 * 凭据全部存 KV（管理员在 /mt-setup 页面登录后写入），本文件只在服务端动态
 * import，不进客户端 bundle：
 *   tg:mt:cfg     {apiId, apiHash}
 *   tg:mt:session StringSession（用户账号授权密钥）
 *   tg:mt:chat    {id: -100…, accessHash}
 *
 * 附件清单存 attachments.storage_key：
 *   mt1:{"c":"-100…","a":"accessHash","p":[{"m":消息id,"id":文档id,"a":accessHash,"d":dcId,"s":字节数}]}
 */
import { Buffer } from 'node:buffer'
import bigInt from 'big-integer'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { ConnectionTCPObfuscated } from 'telegram/network'
import { Api, errors } from 'telegram'
import { getEnv } from './server-env'

/** gramjs TL long 字段类型是 big-integer 对象（其 writer 也接受原生 bigint，
 *  但类型声明只收 BigInteger；统一用 bi() 构造，二者运行时兼容） */
function bi(v: string | number | bigint): bigInt.BigInteger {
  return bigInt(typeof v === 'bigint' ? v.toString() : String(v))
}

// ── 配置 / 会话存取（KV） ─────────────────────────────────────────────

const KV_CFG = 'tg:mt:cfg'
const KV_SESSION = 'tg:mt:session'
const KV_CHAT = 'tg:mt:chat'

export interface MtConfig {
  apiId: number
  apiHash: string
}
export interface MtChatBinding {
  /** 带标记的频道 id（如 -1001234567890） */
  id: string
  /** 频道 accessHash（InputChannel 用；成员频道可传 0，存真实值更稳） */
  accessHash: string
}

function kv() {
  return getEnv().SG_CACHE
}

export async function getMtConfig(): Promise<MtConfig | null> {
  const env = getEnv()
  const raw = await kv()?.get(KV_CFG)
  if (raw) {
    try {
      const j = JSON.parse(raw) as { apiId?: unknown; apiHash?: unknown }
      if (typeof j.apiId === 'number' && j.apiId > 0 && typeof j.apiHash === 'string' && j.apiHash) {
        return { apiId: j.apiId, apiHash: j.apiHash }
      }
    } catch { /* 落到 env 兜底 */ }
  }
  const apiId = Number((env as Record<string, string | undefined>).TG_API_ID)
  const apiHash = (env as Record<string, string | undefined>).TG_API_HASH
  return apiId > 0 && apiHash ? { apiId, apiHash } : null
}

export async function saveMtConfig(cfg: MtConfig): Promise<void> {
  await kv()?.put(KV_CFG, JSON.stringify(cfg))
}

export async function getMtSession(): Promise<string> {
  return (await kv()?.get(KV_SESSION)) || ''
}

export async function saveMtSession(session: string): Promise<void> {
  await kv()?.put(KV_SESSION, session)
}

export async function clearMtSession(): Promise<void> {
  await kv()?.delete(KV_SESSION)
}

export async function getMtChat(): Promise<MtChatBinding | null> {
  const raw = await kv()?.get(KV_CHAT)
  if (!raw) return null
  try {
    const j = JSON.parse(raw) as Partial<MtChatBinding>
    return typeof j.id === 'string' && j.id ? { id: j.id, accessHash: String(j.accessHash ?? '0') } : null
  } catch {
    return null
  }
}

export async function saveMtChat(chat: MtChatBinding): Promise<void> {
  await kv()?.put(KV_CHAT, JSON.stringify(chat))
}

export async function isMtConfigured(): Promise<boolean> {
  return !!(await getMtConfig()) && !!(await getMtSession()) && !!(await getMtChat())
}

// ── 附件清单 ──────────────────────────────────────────────────────────

export interface MtPart {
  /** 频道消息 id（刷新 fileReference / 删除用） */
  m: number
  /** document id（64 位，字符串承载） */
  id: string
  /** document accessHash（64 位字符串） */
  a: string
  /** 文档所在 DC（下载时选择 sender） */
  d: number
  /** 字节数 */
  s: number
}
export interface MtManifest {
  c: string
  /** 频道 accessHash（64 位字符串） */
  a: string
  p: MtPart[]
}

const MT_PREFIX = 'mt1:'

export function encodeMtManifest(m: MtManifest): string {
  return MT_PREFIX + JSON.stringify({ c: m.c, a: m.a, p: m.p })
}

export function decodeMtManifest(key: string | null | undefined): MtManifest | null {
  if (!key || !key.startsWith(MT_PREFIX)) return null
  try {
    const raw = JSON.parse(key.slice(MT_PREFIX.length)) as Partial<MtManifest>
    if (typeof raw.c !== 'string' || !raw.c || !Array.isArray(raw.p) || raw.p.length === 0) return null
    const p = raw.p.filter(
      (x): x is MtPart =>
        !!x && Number.isInteger(x.m) && x.m > 0 &&
        typeof x.id === 'string' && /^\d+$/.test(x.id) &&
        typeof x.a === 'string' && /^-?\d+$/.test(x.a) &&
        Number.isInteger(x.d) && Number.isInteger(x.s) && (x.s as number) >= 0,
    )
    if (p.length !== raw.p.length) return null
    return { c: raw.c, a: typeof raw.a === 'string' ? raw.a : '0', p }
  } catch {
    return null
  }
}

/** 从带标记的频道 id（-100xxxxxxxxxx）取裸 channel_id */
export function channelIdFromMarked(marked: string): bigint {
  const s = marked.trim()
  return BigInt(s.startsWith('-100') ? s.slice(4) : s.replace(/^-/, ''))
}

// ── Worker 内的 WebSocket 传输（gramjs 默认在 Node 判定下走 TCP，需替换） ──

const WEB_DC_HOSTS: Record<number, string> = {
  1: 'pluto.web.telegram.org',
  2: 'venus.web.telegram.org',
  3: 'aurora.web.telegram.org',
  4: 'vesta.web.telegram.org',
  5: 'flora.web.telegram.org',
}

/** 用 workerd 全局 WebSocket 实现 gramjs socket 接口（connect/read/write/close），
 *  避免引入 Node `websocket` 包（依赖 http/tls，Worker 不友好）。 */
class WorkerWsSocket {
  client: WebSocket | undefined
  stream: Buffer = Buffer.alloc(0)
  closed = true
  website = ''
  private canRead: Promise<unknown> = Promise.resolve()
  private resolveRead: ((v: boolean) => void) | undefined

  async readExactly(n: number): Promise<Buffer> {
    let out = Buffer.alloc(0)
    let remaining = n
    while (remaining > 0) {
      const part = await this.read(remaining)
      out = Buffer.concat([out, part])
      remaining -= part.length
    }
    return out
  }

  async read(n: number): Promise<Buffer> {
    if (this.closed) throw new Error('WebSocket was closed')
    await this.canRead
    if (this.closed) throw new Error('WebSocket was closed')
    const out = this.stream.subarray(0, n)
    this.stream = this.stream.subarray(n)
    if (this.stream.length === 0) {
      this.canRead = new Promise((resolve) => { this.resolveRead = resolve as (v: boolean) => void })
    }
    return Buffer.from(out)
  }

  async connect(_port: number, ip: string): Promise<this> {
    this.stream = Buffer.alloc(0)
    this.canRead = new Promise((resolve) => { this.resolveRead = resolve as (v: boolean) => void })
    this.closed = false
    this.website = `wss://${ip}:443/apiws`
    this.client = new WebSocket(this.website)
    this.client.binaryType = 'arraybuffer'
    return new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error('no ws'))
      this.client.onopen = () => resolve(this)
      this.client.onerror = (e) => reject(e instanceof Event ? new Error('ws error') : e)
      this.client.onclose = () => {
        this.closed = true
        this.resolveRead?.(false)
      }
      this.client.onmessage = (ev: MessageEvent) => {
        const data = Buffer.from(ev.data as ArrayBuffer)
        this.stream = Buffer.concat([this.stream, data])
        this.resolveRead?.(true)
      }
    })
  }

  write(data: Buffer | Uint8Array): void {
    if (this.closed || !this.client) throw new Error('WebSocket was closed')
    // workerd WebSocket 接受 ArrayBufferView
    this.client.send(data as unknown as ArrayBuffer)
  }

  async close(): Promise<void> {
    this.closed = true
    try { this.client?.close() } catch { /* ignore */ }
  }
}

/** 混淆 TCP over WSS：把连接目标从 DC IPv4 换成 web.*.telegram.org 域名 */
class WorkerWsConnection extends ConnectionTCPObfuscated {
  async _connect(): Promise<void> {
    const host = WEB_DC_HOSTS[Number(this._dcId)]
    if (host) {
      // 基类把 _ip/_port 声明为 readonly；连接目标在握手前替换是 gramjs
      // 浏览器传输的常规做法（getDC(web=true) 即返回这些 web 主机）
      ;(this as unknown as { _ip: string })._ip = host
      ;(this as unknown as { _port: number })._port = 443
    }
    await super._connect()
  }
}

// ── 客户端实例（按 isolate 复用；不同 colo 并发同会话可能触发 AUTH_KEY_DUPLICATED，
//    届时会在错误处理里丢弃缓存，下次重建；下载场景并发极低） ──────────────

let cachedClient: TelegramClient | null = null

export async function getMtClient(): Promise<TelegramClient> {
  if (cachedClient) return cachedClient
  const cfg = await getMtConfig()
  const session = await getMtSession()
  if (!cfg || !session) throw new Error('MTProto 未配置')
  const client = new TelegramClient(new StringSession(session), cfg.apiId, cfg.apiHash, {
    connection: WorkerWsConnection as never,
    networkSocket: WorkerWsSocket as never,
    autoReconnect: false,
    connectionRetries: 1,
    requestRetries: 2,
    retryDelay: 800,
    timeout: 20,
    floodSleepThreshold: 30,
    useWSS: true,
  })
  ;(client as unknown as { setLogLevel(level: string): void }).setLogLevel('none')
  await client.connect()
  cachedClient = client
  return client
}

/** 会话失效（AUTH_KEY_DUPLICATED/UNAUTHORIZED）时丢弃连接缓存 */
export function dropMtClient(): void {
  void cachedClient?.disconnect().catch(() => undefined)
  cachedClient = null
}

// ── 文档读取与流式输出 ──────────────────────────────────────────────────

/**
 * 单 HTTP 响应窗口与 MTProto 取块大小。
 *
 * 免费版 Worker 硬上限 10ms CPU/请求（实测 @cryptography/aes 纯 JS
 * AES-IGE 约 100MB/s ≈2.3ms/256KiB，加上传输层 AES-CTR 解密、msg_key
 * 校验与缓冲拷贝，256KiB/请求约 5–7ms，留足余量；512KiB 会贴线/超限）。
 * 速度由浏览器端 6 路并发 Range 补偿（见 attachment-download.ts）。
 * 256KiB 是 4096 的整数倍，满足大文件 getFile 的 limit 对齐要求。
 */
export const MT_WINDOW_BYTES = 256 * 1024
const MT_BLOCK_BYTES = 256 * 1024

/** fileReference 刷新后的文档缓存（同 isolate 内 1 小时有效，过期自动重取；
 *  每个 256KiB 请求省一次 channels.getMessages 往返） */
const DOC_CACHE_TTL_MS = 60 * 60 * 1000
const docCache = new Map<string, { doc: Api.Document; at: number }>()

function cachedDoc(key: string): Api.Document | null {
  const hit = docCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > DOC_CACHE_TTL_MS) {
    docCache.delete(key)
    return null
  }
  return hit.doc
}
function rememberDoc(key: string, doc: Api.Document): void {
  docCache.clear() // 附件并发极低，单条目即可，清掉旧引用控制内存
  docCache.set(key, { doc, at: Date.now() })
}

export interface MtWindow {
  start: number
  endInclusive: number
  complete: boolean
}

export function planMtWindow(total: number, startByte: number): MtWindow {
  const start = Math.max(0, Math.min(startByte, Math.max(0, total - 1)))
  const aligned = start - (start % MT_BLOCK_BYTES)
  const endInclusive = Math.min(total - 1, aligned + MT_WINDOW_BYTES - 1)
  return { start: aligned, endInclusive, complete: endInclusive >= total - 1 }
}

/** 按频道消息 id 刷新并取出文档（fileReference 有效期约几十小时） */
async function fetchDocByMessage(
  client: TelegramClient,
  channelId: string | number | bigint,
  accessHash: string,
  messageId: number,
): Promise<Api.Document> {
  const channel = new Api.InputChannel({
    channelId: bi(channelId),
    accessHash: bi(accessHash || '0'),
  })
  const res = await client.invoke(
    new Api.channels.GetMessages({
      channel,
      id: [new Api.InputMessageID({ id: messageId })],
    }),
  )
  const msg = (res as Api.messages.Messages | Api.messages.ChannelMessages).messages[0]
  const media = (msg as Api.Message).media
  if (!(media instanceof Api.MessageMediaDocument) || !(media.document instanceof Api.Document)) {
    throw new Error('附件文档已不可用（消息可能已被删除）')
  }
  return media.document
}

// ── 通用频道消息分片读取（mt1 单片与 tg1 bot 多片共用） ─────────────────

/** 一个"消息分片"：某条频道消息里的 document 承载文件内 s 个字节 */
export interface MtMessagePart {
  /** 频道消息 id */
  m: number
  /** 字节数 */
  s: number
}

export interface MtPartsWindow {
  /** 命中的分片下标 */
  partIndex: number
  /** 该分片在整个文件内的字节起点 */
  partStart: number
  /** 本次响应窗口首字节（文件内偏移，256KiB 对齐且不跨分片） */
  start: number
  /** 本次响应窗口末字节（含） */
  endInclusive: number
  /** 窗口是否覆盖到文件尾 */
  complete: boolean
}

/**
 * 定位 startByte 所在分片并给出一个 256KiB 对齐、不跨分片边界的窗口。
 * 前置条件：除最后一片外各片大小均为 MT_BLOCK_BYTES 的整数倍
 * （47MiB / 19MiB 都满足），因此块对齐不会跨界。
 */
export function planMtPartsWindow(parts: MtMessagePart[], total: number, startByte: number): MtPartsWindow {
  const clamped = Math.max(0, Math.min(startByte, Math.max(0, total - 1)))
  let off = 0
  for (let i = 0; i < parts.length; i++) {
    const partEnd = off + parts[i].s // 开区间
    if (clamped < partEnd) {
      const inPart = clamped - off
      const alignedInPart = inPart - (inPart % MT_BLOCK_BYTES)
      const start = off + alignedInPart
      const endInclusive = Math.min(total - 1, start + MT_WINDOW_BYTES - 1, partEnd - 1)
      return { partIndex: i, partStart: off, start, endInclusive, complete: endInclusive >= total - 1 }
    }
    off = partEnd
  }
  // startByte >= total（防御）
  return { partIndex: parts.length - 1, partStart: 0, start: total, endInclusive: total - 1, complete: true }
}

/**
 * 从 startByte 起流式读取一个 256KiB 窗口（恰好一次 upload.getFile）。
 * FILE_MIGRATION 自动切换 DC；fileReference 过期自动刷新一次重试。
 * mt1 与 tg1 清单统一走这里：差别只是频道/分片列表不同。
 */
export function streamMtParts(
  chatMarkedId: string,
  accessHash: string,
  parts: MtMessagePart[],
  startByte: number,
  total: number,
): ReadableStream<Uint8Array> {
  const channelId = channelIdFromMarked(chatMarkedId)
  const win = planMtPartsWindow(parts, total, startByte)
  const part = parts[win.partIndex]
  const cacheKey = `${channelId}:${part.m}`
  let retriedRef = false

  const pullBlock = async (): Promise<{ doc: Api.Document; bytes: Buffer }> => {
    const client = await getMtClient()
    let doc = cachedDoc(cacheKey)
    if (!doc) {
      doc = await fetchDocByMessage(client, channelId, accessHash, part.m)
      rememberDoc(cacheKey, doc)
    }
    const location = new Api.InputDocumentFileLocation({
      id: doc.id,
      accessHash: doc.accessHash,
      fileReference: doc.fileReference,
      thumbSize: '',
    })
    const intraOffset = win.start - win.partStart
    try {
      const res = await client.invoke(
        new Api.upload.GetFile({
          location,
          offset: bi(intraOffset),
          limit: MT_BLOCK_BYTES,
          precise: false,
        }),
        doc.dcId,
      )
      if (!(res instanceof Api.upload.File)) throw new Error('意外的文件响应类型')
      return { doc, bytes: Buffer.from(res.bytes) }
    } catch (e) {
      if (e instanceof errors.FileMigrateError) {
        const client2 = await getMtClient()
        const res = await client2.invoke(
          new Api.upload.GetFile({
            location,
            offset: bi(intraOffset),
            limit: MT_BLOCK_BYTES,
          }),
          e.newDc,
        )
        return { doc, bytes: Buffer.from((res as Api.upload.File).bytes) }
      }
      const msg = e instanceof Error ? e.message : String(e)
      if (!retriedRef && /FILE_REFERENCE/.test(msg)) {
        retriedRef = true
        docCache.delete(cacheKey)
        return pullBlock()
      }
      if (/AUTH_KEY|UNAUTHORIZED|CONNECTION_NOT_INITED|SESSION_REVOKED/.test(msg)) dropMtClient()
      throw e
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { bytes } = await pullBlock()
      if (bytes.length === 0) {
        controller.close()
        return
      }
      const want = win.endInclusive - win.start + 1
      controller.enqueue(new Uint8Array(bytes.length > want ? bytes.subarray(0, want) : bytes))
      controller.close()
    },
  })
}

/** mt1 清单（用户会话直传，单消息承载整个文件）的流式读取入口 */
export function streamMtManifest(manifest: MtManifest, startByte: number, total: number): ReadableStream<Uint8Array> {
  return streamMtParts(
    manifest.c,
    manifest.a || '0',
    manifest.p.map((p) => ({ m: p.m, s: p.s })),
    startByte,
    total,
  )
}

/** 删除附件对应的频道消息（尽力而为，返回失败信息） */
export async function deleteMtMessages(manifest: MtManifest): Promise<void> {
  const client = await getMtClient()
  try {
    await client.invoke(
      new Api.channels.DeleteMessages({
        channel: new Api.InputChannel({
          channelId: bi(channelIdFromMarked(manifest.c)),
          accessHash: bi(manifest.a || '0'),
        }),
        id: manifest.p.map((x) => x.m),
      }),
    )
  } catch (e) {
    // 消息可能已不在；不阻塞 DB 删除
    if (!/MESSAGE_ID_INVALID|CHANNEL_PRIVATE|CHANNEL_INVALID/.test(e instanceof Error ? e.message : String(e))) throw e
  }
}
