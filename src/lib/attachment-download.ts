/**
 * 大附件可续传下载器（浏览器端）。
 *
 * 两类后端窗口：
 * - MTProto 直传（mt1）：免费版 Worker 10ms CPU 上限下单响应只回 256KiB
 *   （X-Chunk-Size 头），这里用 6 路并发 Range 拉块、按偏移随机写盘；
 * - Bot 分片（tg1）：单窗口最大 ~380MiB，无 X-Chunk-Size，走顺序流式。
 *
 * 经 File System Access API 直写磁盘（不占浏览器内存）；任一块失败按指数
 * 退避重试，进度按已完成字节数汇报，中断不影响已落盘部分（本次会话内续传）。
 *
 * 小文件 / 不支持 File System Access 的浏览器：退化为普通 <a> 链接下载。
 */
import { attachmentDownloadUrl } from './utils'

/** tg1 bot 附件的单响应窗口 20 片 × 19 MiB = 380 MiB；超过即走 JS 下载器 */
export const ATTACHMENT_DIRECT_LINK_MAX_BYTES = 20 * 19 * 1024 * 1024

/**
 * Bot 分片阈值（与服务端 TG_CHUNK_BYTES 保持一致，47 MiB）：
 * 超过即走分片/MTProto 通道。客户端侧镜像常量，避免引入服务端模块。
 */
export const BOT_UPLOAD_CHUNK_BYTES = 47 * 1024 * 1024

/** MTProto 小窗口的并发拉取路数（浏览器对同源 HTTP/1.1 连接上限 6） */
const MT_CONCURRENCY = 6
/** 单块最多重试次数（429/5xx/网络抖动） */
const CHUNK_MAX_RETRIES = 6

export interface FSSavePickerOptions {
  suggestedName?: string
}

type FSWriteCommand =
  | Uint8Array
  | { type: 'write'; position?: number; data: BufferSource | Blob | string }
  | { type: 'truncate'; size: number }

interface FSWritable {
  write(cmd: FSWriteCommand): Promise<void>
  close(): Promise<void>
  abort(reason?: unknown): Promise<void>
}

interface FSFileHandle {
  createWritable(): Promise<FSWritable>
}

declare global {
  interface Window {
    showSaveFilePicker?: (opts?: FSSavePickerOptions) => Promise<FSFileHandle>
  }
}

export function canStreamDownload(): boolean {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function'
}

export type DownloadResult = 'done' | 'cancelled'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 给 read() 挂 60s 无数据超时（收到数据即重置计时）；
 *  裸 Promise.race 的输者 promise 稍后 reject 会变成 unhandled rejection，
 *  这里用 timer 清理避免 */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} stalled (60s)`)), ms)
    p.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) },
    )
  })
}

/** 读取一块 Range 数据（带退避重试）；4xx 直接抛错终止 */
async function fetchChunk(url: string, start: number, end: number): Promise<Uint8Array> {
  let last: unknown = null
  for (let attempt = 0; attempt < CHUNK_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
        credentials: 'same-origin',
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok || !res.body) {
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null
          throw new Error(data?.error || `HTTP ${res.status}`)
        }
        throw new Error(`HTTP ${res.status}`)
      }
      const buf = new Uint8Array(await res.arrayBuffer())
      if (buf.length === 0) throw new Error('empty')
      return buf
    } catch (e) {
      last = e
      const msg = e instanceof Error ? e.message : String(e)
      if (/HTTP 4\d\d|令牌|无效/.test(msg)) throw e
      await sleep(Math.min(12000, 600 * 2 ** attempt))
    }
  }
  throw last instanceof Error ? last : new Error('chunk failed')
}

export async function downloadAttachmentLarge(opts: {
  id: number
  token?: string
  filename: string
  sizeBytes: number
  onPct?: (pct: number) => void
}): Promise<DownloadResult> {
  const picker = window.showSaveFilePicker
  if (!picker) throw new Error('unsupported')
  let handle: FSFileHandle
  try {
    handle = await picker({ suggestedName: opts.filename })
  } catch {
    return 'cancelled' // 用户取消保存对话框
  }
  const writable = await handle.createWritable()
  const url = attachmentDownloadUrl(opts.id, opts.token)
  const total = Math.max(1, opts.sizeBytes)
  let received = 0
  const reportPct = () => opts.onPct?.(Math.min(99, Math.round((received / total) * 100)))

  try {
    // 首块请求：探测服务端窗口大小（X-Chunk-Size 仅 mt1 返回）
    let res: Response
    try {
      res = await fetch(url, {
        headers: { Range: 'bytes=0-' },
        credentials: 'same-origin',
        signal: AbortSignal.timeout(60_000),
      })
    } catch {
      throw new Error('network')
    }
    if (!res.ok || !res.body) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(data?.error || `HTTP ${res.status}`)
    }
    const declaredChunk = Number(res.headers.get('X-Chunk-Size') || '')
    const chunkSize = Number.isFinite(declaredChunk) && declaredChunk > 0 ? declaredChunk : 0

    // 顺序流式消费首块响应体（tg1 大窗口或 mt1 首块都走这里，避免双倍缓冲）。
    // 中途断流不致命：已收字节保留，chunkSize>0 走并发块续传，否则走下面的
    // tg1 窗口循环从断点重开新窗口。
    const firstReader = res.body.getReader()
    try {
      for (;;) {
        const { done, value } = await withTimeout(firstReader.read(), 60_000, 'first window')
        if (done) break
        if (!value || value.length === 0) continue
        await writable.write(value)
        received += value.length
        reportPct()
      }
    } catch {
      /* 断流容错：交给后续续传逻辑 */
    }
    if (received >= total) {
      opts.onPct?.(100)
      await writable.close()
      return 'done'
    }

    if (chunkSize > 0) {
      // ── mt1 小窗口：固定块大小 + 有界并发，按偏移随机写 ──
      // 从"最后不完整块"的块起点重发（首块可能中途断流，盘上有半块残数据；
      // 整块重写幂等，最多多拉一个块）
      const nextStart = Math.floor(received / chunkSize) * chunkSize

      const starts: number[] = []
      for (let s = nextStart; s < total; s += chunkSize) starts.push(s)
      let cursor = 0

      const worker = async () => {
        for (;;) {
          const start = starts[cursor++]
          if (start === undefined) return
          const end = Math.min(start + chunkSize, total) - 1
          const buf = await fetchChunk(url, start, end)
          await writable.write({ type: 'write', position: start, data: buf as BufferSource })
          received += buf.length
          reportPct()
        }
      }
      await Promise.all(Array.from({ length: Math.min(MT_CONCURRENCY, starts.length) }, () => worker()))
    } else {
      // ── tg1 大窗口：服务端决定窗口大小，顺序开放区间 Range 续传 ──
      let guard = 0
      while (received < total) {
        if (++guard > 4096) throw new Error('too many windows')
        let res: Response | null = null
        let lastErr: unknown = null
        for (let attempt = 0; attempt < CHUNK_MAX_RETRIES; attempt++) {
          try {
            const r = await fetch(url, {
              headers: { Range: `bytes=${received}-` },
              credentials: 'same-origin',
            })
            if (r.status === 401 || r.status === 403 || r.status === 404) {
              const data = (await r.json().catch(() => null)) as { error?: string } | null
              throw new Error(data?.error || `HTTP ${r.status}`)
            }
            if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`)
            res = r
            break
          } catch (e) {
            lastErr = e
            await sleep(Math.min(12000, 600 * 2 ** attempt))
          }
        }
        if (!res) throw lastErr instanceof Error ? lastErr : new Error('window failed')
        const body = res.body
        if (!body) throw new Error('no body')
        const before = received
        const reader = body.getReader()
        try {
          for (;;) {
            const { done, value } = await withTimeout(reader.read(), 60_000, 'stream')
            if (done) break
            if (!value || value.length === 0) continue
            await writable.write({ type: 'write', position: received, data: value })
            received += value.length
            reportPct()
          }
        } catch (e) {
          if (received === before) throw e // 本窗口一个字节都没进来：视为致命错误
          // 窗口中途断流/挂起：已落盘进度保留，while 从断点重开新窗口
        }
        if (received === before) break
      }
    }

    if (received < total) throw new Error('incomplete')
    opts.onPct?.(100)
    await writable.close()
    return 'done'
  } catch (e) {
    await writable.abort(e).catch(() => undefined)
    throw e
  }
}
