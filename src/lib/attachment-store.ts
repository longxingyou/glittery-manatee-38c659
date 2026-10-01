/**
 * 文章附件存储（Telegram Bot API 云端）。
 *
 * 为什么是 Telegram：完全免费且无配额、无需绑卡（R2 需账号绑付款方式），
 * 文件永久保存在 Telegram 云端，出站流量零费用。Bot API 的限制
 * （bot 上传单文件 50 MB、下载单文件 20 MB）上传侧取满、下载侧改走
 * MTProto 用户会话（WSS 回源，无 20MB 限制，见 mtproto-store.ts）：
 * 每个附件 = 1..N 个 ≤47 MiB 的 document 消息，存在 bot 为管理员的
 * 私有频道/群组里（外界无法搜索到）。
 *
 * Worker 充当代理：上传时把分片 multipart 转发给 Bot API（sendDocument），
 * 下载时优先由用户 MTProto 会话逐 256KiB 窗口流式回源；未配置用户会话时
 * 旧的 getFile 路径仍可下载 ≤20MB 的历史分片。token 永不出 Worker。
 *
 * 配置（wrangler secret put / .dev.vars）：
 *   TG_BOT_TOKEN        @BotFather 创建 bot 后得到的 token
 *   TG_STORAGE_CHAT_ID  bot 为管理员的私有频道/群组 id（如 -100xxxxxxxxxx）
 *
 * attachments.storage_key 存清单 JSON：tg1:{"c":chatId,"p":[{m,f,s},...]}
 * （m=消息 id，f=document file_id，s=分片字节数）。
 */
import { getEnv } from './server-env'

/**
 * 单片大小：47 MiB。
 * sendDocument 硬上限 50 MB（十进制 50,000,000 字节），47 MiB ≈ 49.28 MB
 * 留余量；1.2GB 文件从旧方案 64 条消息降到 26 条，显著降低消息频率
 * 限流与多层网关 503 概率。注意 bot getFile 只能下载 ≤20MB 的文件，
 * 47MiB 分片的下载一律走 MTProto 用户会话。
 * 47MiB 同时是 256KiB 的整数倍，保证 MTProto 取块偏移天然对齐。
 */
export const TG_CHUNK_BYTES = 47 * 1024 * 1024

/** 单请求直传上限 = 单片上限（更大的文件由前端自动走分片路径） */
export const ATTACHMENT_MAX_BYTES = TG_CHUNK_BYTES

/** base64 入库降级上限（TG 未配置的本地开发用，避免撑爆数据库） */
export const ATTACHMENT_LEGACY_MAX_BYTES = 4 * 1024 * 1024

/** 附件总大小上限（管理员可信；Telegram 分片数无硬性上限，取 2 GB 为合理管理值） */
export const ATTACHMENT_DIRECT_MAX_BYTES = 2 * 1024 ** 3

export interface TgPart {
  /** 消息 id（删除分片用） */
  m: number
  /** document file_id（getFile 下载用，对该 bot 永久有效） */
  f: string
  /** 分片字节数 */
  s: number
}

export interface AttachmentManifest {
  /** 存文件的会话 id（随清单持久化，换频道也不影响旧附件下载/删除） */
  c: string
  /** 分片列表，按文件内偏移顺序 */
  p: TgPart[]
}

const MANIFEST_PREFIX = 'tg1:'

/** KV 中存储"附件会话 id"的键（管理员探测页一键绑定，省去手动找 chat_id） */
export const TG_CHAT_KV_KEY = 'tg:storage-chat-id'

/**
 * 附件会话 id：优先 Worker secret TG_STORAGE_CHAT_ID；未配置时读 KV
 * （由管理员探测页 /api/comments?action=tg-probe 一键写入）。
 */
export async function getStorageChatId(): Promise<string> {
  const env = getEnv()
  if (env.TG_STORAGE_CHAT_ID) return env.TG_STORAGE_CHAT_ID
  return (await env.SG_CACHE?.get(TG_CHAT_KV_KEY)) || ''
}

/** 把附件会话 id 持久化到 KV（探测页绑定） */
export async function setStorageChatIdKv(chatId: string): Promise<boolean> {
  const kv = getEnv().SG_CACHE
  if (!kv) return false
  await kv.put(TG_CHAT_KV_KEY, chatId)
  return true
}

export async function isTgConfigured(): Promise<boolean> {
  const env = getEnv()
  if (!env.TG_BOT_TOKEN) return false
  return !!(await getStorageChatId())
}

export function encodeAttachmentManifest(m: AttachmentManifest): string {
  return MANIFEST_PREFIX + JSON.stringify({ c: m.c, p: m.p })
}

/** 解析清单；任何不合法形态返回 null（调用方走降级/报错路径） */
export function decodeAttachmentManifest(key: string | null | undefined): AttachmentManifest | null {
  if (!key || !key.startsWith(MANIFEST_PREFIX)) return null
  try {
    const raw = JSON.parse(key.slice(MANIFEST_PREFIX.length)) as Partial<AttachmentManifest>
    if (!raw || typeof raw.c !== 'string' || !raw.c || !Array.isArray(raw.p) || raw.p.length === 0) return null
    const p = raw.p.filter(
      (x) =>
        x &&
        Number.isInteger(x.m) &&
        x.m > 0 &&
        typeof x.f === 'string' &&
        x.f.length > 0 &&
        x.f.length <= 256 &&
        Number.isInteger(x.s) &&
        x.s >= 0,
    )
    if (p.length === 0) return null
    return { c: raw.c, p }
  } catch {
    return null
  }
}

interface TgResponse<T> {
  ok?: boolean
  result?: T
  description?: string
  /** 429 时 Telegram 通过 parameters.retry_after 给出需等待秒数 */
  parameters?: { retry_after?: number }
}

type TgSendDocResponse = TgResponse<{
  message_id?: number
  document?: { file_id?: string; file_size?: number }
}>

/** Telegram 限流错误：立即抛给调用方（由前端按 retryAfterMs 等待重试），
 *  服务端不长睡——单个 Worker 请求挂太久会被前置网关判超时（503）。 */
export class TgRateLimitError extends Error {
  retryAfterMs: number
  constructor(retryAfterSec: number, method: string) {
    super(`Telegram ${method} 限流，请稍后重试`)
    this.name = 'TgRateLimitError'
    this.retryAfterMs = Math.max(1000, Math.ceil(retryAfterSec * 1000)) + 300
  }
}

/** Worker 单次请求内的安全短睡眠（只做 5xx/网络抖动的快速退避，不用于 429） */
const TG_MAX_WAIT_MS = 2_000

function tgSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(ms, TG_MAX_WAIT_MS))))
}

/**
 * 统一 Bot API 调用：429 Flood 立即抛 TgRateLimitError（客户端节奏控制），
 * 5xx/网络抖动快速退避重试。JSON 请求。
 */
async function tgApi<T>(method: string, body: unknown, attempts = 2): Promise<T> {
  const token = getEnv().TG_BOT_TOKEN
  if (!token) throw new Error('TG_BOT_TOKEN 未配置')
  let lastErr = `Telegram ${method} 失败`
  for (let attempt = 0; attempt < attempts; attempt++) {
    let res: Response
    let data: TgResponse<T> | null = null
    try {
      res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      data = (await res.json().catch(() => null)) as TgResponse<T> | null
    } catch (e) {
      lastErr = `Telegram ${method} 网络错误：${e instanceof Error ? e.message : String(e)}`
      await tgSleep(700 * (attempt + 1))
      continue
    }
    const retryAfter = data?.parameters?.retry_after
    if (res.status === 429 || (data && data.ok === false && typeof retryAfter === 'number')) {
      throw new TgRateLimitError(retryAfter ?? 2, method)
    }
    if (res.status >= 500 || (data && data.ok === false && res.status >= 500)) {
      lastErr = `Telegram ${method} 失败：${data?.description || `HTTP ${res.status}`}`
      await tgSleep(600 * (attempt + 1))
      continue
    }
    if (!data?.ok) throw new Error(`Telegram ${method} 失败：${data?.description || `HTTP ${res.status}`}`)
    return data.result as T
  }
  throw new Error(lastErr)
}

/** 上传一个分片为 Telegram document；返回消息 id / file_id / 实际字节数。
 *  429 立即抛 TgRateLimitError（Blob body 可安全重发，由前端节奏控制），
 *  5xx/网络错误快速退避重试。 */
export async function tgSendChunk(args: {
  chatId: string
  chunk: Blob
  filename: string
  contentType?: string
}): Promise<TgPart> {
  const token = getEnv().TG_BOT_TOKEN
  if (!token) throw new Error('TG_BOT_TOKEN 未配置')
  let lastErr = 'Telegram sendDocument 失败'
  for (let attempt = 0; attempt < 2; attempt++) {
    // 每次重试重建 FormData（已发送的 body 不可复用）
    const form = new FormData()
    form.append('chat_id', args.chatId)
    form.append(
      'document',
      new File([args.chunk], args.filename || 'blob', {
        type: args.contentType || 'application/octet-stream',
      }),
    )
    let res: Response
    let data: TgSendDocResponse | null = null
    try {
      res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form })
      data = (await res.json().catch(() => null)) as TgSendDocResponse | null
    } catch (e) {
      lastErr = `Telegram sendDocument 网络错误：${e instanceof Error ? e.message : String(e)}`
      await tgSleep(700 * (attempt + 1))
      continue
    }
    const retryAfter = data?.parameters?.retry_after
    if (res.status === 429 || (data?.ok === false && typeof retryAfter === 'number')) {
      throw new TgRateLimitError(retryAfter ?? 2, 'sendDocument')
    }
    if (res.status >= 500) {
      lastErr = `Telegram sendDocument 失败：${data?.description || `HTTP ${res.status}`}`
      await tgSleep(600 * (attempt + 1))
      continue
    }
    if (!data?.ok || !data.result?.document?.file_id || !data.result.message_id) {
      throw new Error(`Telegram sendDocument 失败：${data?.description || `HTTP ${res.status}`}`)
    }
    return {
      m: data.result.message_id,
      f: data.result.document.file_id,
      s: data.result.document.file_size ?? args.chunk.size,
    }
  }
  throw new Error(lastErr)
}

/** getFile 解析结果的实例内缓存：file_path URL 有效期 ≥1 小时，
 *  断点续传/重复下载同一附件时省掉一半 subrequest（免费版单请求上限 50 次）。 */
const fileUrlCache = new Map<string, { url: string; exp: number }>()

/** getFile：把 file_id 解析为可直接下载的临时 URL（同一 file_id 可重复解析） */
export async function tgChunkUrl(fileId: string): Promise<string> {
  const hit = fileUrlCache.get(fileId)
  if (hit && hit.exp > Date.now()) return hit.url
  const token = getEnv().TG_BOT_TOKEN
  if (!token) throw new Error('TG_BOT_TOKEN 未配置')
  const r = await tgApi<{ file_path?: string }>('getFile', { file_id: fileId })
  if (!r.file_path) throw new Error('Telegram getFile 未返回 file_path')
  const url = `https://api.telegram.org/file/bot${token}/${r.file_path}`
  if (fileUrlCache.size > 512) fileUrlCache.clear()
  fileUrlCache.set(fileId, { url, exp: Date.now() + 50 * 60 * 1000 })
  return url
}

/** 删除分片消息（附件删除/上传中止时清理云端文件）；单次最多 100 条，尽力而为不抛错 */
export async function tgDeleteMessages(chatId: string, messageIds: number[]): Promise<void> {
  if (messageIds.length === 0) return
  try {
    for (let i = 0; i < messageIds.length; i += 100) {
      await tgApi('deleteMessages', { chat_id: chatId, message_ids: messageIds.slice(i, i + 100) })
    }
  } catch {
    /* 云端残留只是不可达的孤儿消息，不阻断业务 */
  }
}

/** 删除附件对应的全部云端文件（bot tg1 清单 或用户会话 mt1 清单）；
 *  清单不合法时静默返回。mtproto 动态引入，避免把 gramjs 拖进冷启动路径。 */
export async function deleteAttachmentFiles(storageKey: string | null | undefined): Promise<void> {
  if (storageKey?.startsWith('mt1:')) {
    try {
      const mt = await import('./mtproto-store.js')
      const m = mt.decodeMtManifest(storageKey)
      if (m) await mt.deleteMtMessages(m)
    } catch {
      /* 云端残留只是不可达的孤儿消息，不阻断业务 */
    }
    return
  }
  const m = decodeAttachmentManifest(storageKey)
  if (!m) return
  await tgDeleteMessages(m.c, m.p.map((x) => x.m))
}

/**
 * 单次 HTTP 响应最多流经的分片数。Cloudflare 免费版单请求 subrequest 上限 50，
 * 每片消耗 2 次（getFile + 拉文件，缓存命中时 1 次），20 片 × 2 = 40 留足余量。
 * 更大的文件由客户端用 Range 续传（前端下载器自动分段拉取并断点重试）。
 */
export const ATTACHMENT_MAX_CHUNKS_PER_RESPONSE = 20

export interface AttachmentByteWindow {
  /** 本次响应实际覆盖的字节区间 [start, endInclusive] */
  start: number
  endInclusive: number
  /** 是否覆盖到文件末尾 */
  complete: boolean
}

/** 计算从 startByte 起、最多 maxChunks 片的字节窗口（用于 Range 支持与 subrequest 预算） */
export function planAttachmentWindow(
  manifest: AttachmentManifest,
  startByte: number,
  maxChunks = ATTACHMENT_MAX_CHUNKS_PER_RESPONSE,
): AttachmentByteWindow {
  const total = manifest.p.reduce((a, b) => a + b.s, 0)
  const start = Math.max(0, Math.min(startByte, total))
  let offset = 0
  let end = total - 1
  let served = 0
  for (let i = 0; i < manifest.p.length; i++) {
    const partEnd = offset + manifest.p[i].s // 开区间
    if (partEnd <= start) {
      offset = partEnd
      continue
    }
    served++
    if (served >= maxChunks) {
      end = partEnd - 1
      break
    }
    offset = partEnd
  }
  if (total === 0) return { start: 0, endInclusive: -1, complete: true }
  return { start, endInclusive: Math.min(end, total - 1), complete: end >= total - 1 }
}

/**
 * 把清单中的分片依序流式拼接为响应体（逐片拉取转发，不在 Worker 内存里
 * 展开完整文件，2 GB 附件也只需常驻单片缓冲）。任一分片失败则整个流出错。
 * startByte/maxChunks 用于 Range 续传与 subrequest 预算控制。
 */
export function streamAttachmentChunks(
  manifest: AttachmentManifest,
  opts: { startByte?: number; maxChunks?: number } = {},
): ReadableStream<Uint8Array> {
  const startByte = Math.max(0, opts.startByte || 0)
  const maxChunks = Math.max(1, opts.maxChunks || ATTACHMENT_MAX_CHUNKS_PER_RESPONSE)
  // 预扫描：跳过完全落在 startByte 之前的分片，记下首片内需跳过的字节数
  let idx = 0
  let offset = 0
  while (idx < manifest.p.length && offset + manifest.p[idx].s <= startByte) {
    offset += manifest.p[idx].s
    idx++
  }
  let skipInFirstPart = startByte - offset
  let remaining = maxChunks
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (idx >= manifest.p.length || remaining <= 0) {
        controller.close()
        return
      }
      const part = manifest.p[idx++]
      remaining--
      let res: Response | null = null
      let lastErr = '分片下载失败'
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const url = await tgChunkUrl(part.f) // 实例内缓存 + getFile 快速退避
          const r = await fetch(url)
          if (r.ok && r.body) {
            res = r
            break
          }
          lastErr = `Telegram 文件下载失败（HTTP ${r.status}）`
        } catch (e) {
          lastErr = e instanceof Error ? e.message : '分片下载失败'
        }
        await tgSleep(500 * (attempt + 1))
      }
      try {
        if (!res || !res.body) throw new Error(lastErr)
        const reader = res.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (skipInFirstPart > 0) {
            // Range 起点落在分片中间：丢弃前 skip 字节
            if (value.length <= skipInFirstPart) {
              skipInFirstPart -= value.length
              continue
            }
            const sliced = value.subarray(skipInFirstPart)
            skipInFirstPart = 0
            controller.enqueue(sliced)
            continue
          }
          controller.enqueue(value)
        }
      } catch (e) {
        controller.error(e instanceof Error ? e : new Error('分片下载失败'))
      }
    },
  })
}

// ── 管理员探测页辅助：列出 bot 可见会话、校验并一键绑定 ──

export interface TgChatInfo {
  id: number
  title?: string
  type?: string
  username?: string
}

export async function tgGetMe(): Promise<{ username?: string; first_name?: string }> {
  return tgApi('getMe', {})
}

/** 拉取 bot 的最近更新（加 bot 入群事件、频道帖子、私聊消息等都会出现在这里）。
 * 显式声明 allowed_updates：频道帖子/入群事件默认虽会下发，但一旦该 bot 历史上
 * 被 setWebhook 改过订阅类型，不声明可能拿不到 channel_post / my_chat_member。 */
export async function tgGetUpdates(): Promise<Array<Record<string, unknown>>> {
  return tgApi<Array<Record<string, unknown>>>('getUpdates', {
    timeout: 0,
    limit: 100,
    allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'my_chat_member'],
  })
}

/** getChat：验证 bot 确实能访问该会话（频道里必须是管理员），返回会话信息 */
export async function tgGetChat(chatId: string): Promise<TgChatInfo> {
  return tgApi('getChat', { chat_id: chatId })
}

