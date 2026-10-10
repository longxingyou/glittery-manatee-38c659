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
  if (typeof window === 'undefined' || typeof window.showSaveFilePicker !== 'function') return false
  // 移动端 Chromium 系浏览器可能暴露 showSaveFilePicker，但 File System Access
  // 实现残缺（实测安卓上 createWritable/write 抛 InvalidStateError），且失败
  // 回退会导致弹两次保存框。手机一律走系统下载器（网关 /dl 整文件直连）。
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return false
  return true
}

/** 网关直连（gwDl）下载计数：浏览器直接导航到网关、不经 Worker 下载接口，
 *  点击时用 sendBeacon 补记一次（同标签导航/页面卸载也能送达）；Beacon 失败
 *  回退 keepalive fetch。 */
export function reportGatewayDownload(id: number) {
  const url = `/api/comments?action=record-download&id=${id}`
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try { if (navigator.sendBeacon(url)) return } catch { /* 回退 fetch */ }
  }
  void fetch(url, { method: 'POST', credentials: 'same-origin', keepalive: true }).catch(() => undefined)
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

/** 读取一块 Range 数据（带退避重试）；4xx 直接抛错终止。
 *  慢链路下一块可能传几分钟：建立连接限 60s，之后按"60s 无数据才中止"
 *  流式读取，并按到达字节回报增量进度 onDelta（重试前回滚本次已报进度）。 */
async function fetchChunk(
  url: string,
  start: number,
  end: number,
  credentials: RequestCredentials = 'same-origin',
  onDelta?: (bytes: number) => void,
): Promise<Uint8Array> {
  const want = end - start + 1
  let last: unknown = null
  for (let attempt = 0; attempt < CHUNK_MAX_RETRIES; attempt++) {
    let got = 0
    const ctrl = new AbortController()
    const headerTimer = setTimeout(() => ctrl.abort(), 60_000)
    try {
      const res = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
        credentials,
        signal: ctrl.signal,
      })
      clearTimeout(headerTimer)
      if (!res.ok || !res.body) {
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null
          throw new Error(data?.error || `HTTP ${res.status}`)
        }
        throw new Error(`HTTP ${res.status}`)
      }
      // 明确请求了 Range 却收到 200：数据起点不对，按可重试错误处理
      if (start > 0 && res.status !== 206) throw new Error(`HTTP ${res.status} (no range)`)
      const buf = new Uint8Array(want)
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await withTimeout(reader.read(), 60_000, 'chunk')
        if (done) break
        if (!value || value.length === 0) continue
        const n = Math.min(value.length, want - got)
        if (n <= 0) break
        buf.set(value.subarray(0, n), got)
        got += n
        onDelta?.(n)
        if (got >= want) break
      }
      if (got < want) throw new Error(`short (${got}/${want})`)
      return buf
    } catch (e) {
      if (got > 0) onDelta?.(-got) // 未遂块：回滚进度，重试时重新计
      last = e
      const msg = e instanceof Error ? e.message : String(e)
      if (/HTTP 4\d\d|令牌|无效/.test(msg)) throw e
      ctrl.abort()
      await sleep(Math.min(12000, 600 * 2 ** attempt))
    } finally {
      clearTimeout(headerTimer)
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

// ── 网关直连模式（本地 Bot API Server：file-urls → 每片一个签名 URL）──

/** 网关分片拉取块大小（片内 Range；写盘位置用全局文件偏移）。
 *  取 4MiB：慢链路上单块传输时间可控，中止重试的浪费小 */
const GW_CHUNK_BYTES = 4 * 1024 * 1024
const GW_CONCURRENCY = 6

interface GwFileUrls {
  total: number
  filename: string
  mimeType: string
  parts: Array<{ size: number; url: string }>
}

/** 拉取 file-urls 清单（登录 + 密码 token 门禁在 Worker 侧） */
export async function fetchGatewayFileUrls(id: number, token?: string): Promise<GwFileUrls> {
  const q = new URLSearchParams({ action: 'file-urls', id: String(id) })
  if (token) q.set('token', token)
  const res = await fetch(`/api/comments?${q.toString()}`, { credentials: 'same-origin' })
  const data = (await res.json().catch(() => null)) as (GwFileUrls & { error?: string }) | null
  if (!res.ok || !data || !Array.isArray(data.parts)) {
    throw new Error(data?.error || `HTTP ${res.status}`)
  }
  return data
}

/**
 * 网关直连下载：每片（90MiB/47MiB 都可能）独立签名 URL，Range 是相对单片的，
 * 这里把片内块映射到全局写盘偏移；6 路并发、断流重试，不占 Worker 带宽/CPU。
 */
export async function downloadAttachmentViaGateway(opts: {
  id: number
  token?: string
  filename: string
  sizeBytes: number
  onPct?: (pct: number) => void
}): Promise<DownloadResult> {
  const picker = window.showSaveFilePicker
  if (!picker) throw new Error('unsupported')

  const manifest = await fetchGatewayFileUrls(opts.id, opts.token)
  const total = Math.max(1, manifest.total || opts.sizeBytes)

  let handle: FSFileHandle
  try {
    handle = await picker({ suggestedName: manifest.filename || opts.filename })
  } catch {
    return 'cancelled'
  }
  const writable = await handle.createWritable()
  let received = 0
  const reportPct = () => opts.onPct?.(Math.min(99, Math.round((received / total) * 100)))

  try {
    // 任务表：片内块 → 全局写盘偏移
    interface Task { url: string; intraStart: number; intraEnd: number; globalPos: number }
    const tasks: Task[] = []
    let partOffset = 0
    for (const part of manifest.parts) {
      for (let s = 0; s < part.size; s += GW_CHUNK_BYTES) {
        tasks.push({
          url: part.url,
          intraStart: s,
          intraEnd: Math.min(s + GW_CHUNK_BYTES, part.size) - 1,
          globalPos: partOffset + s,
        })
      }
      partOffset += part.size
    }
    let cursor = 0
    const worker = async () => {
      for (;;) {
        const task = tasks[cursor++]
        if (!task) return
        // 网关是跨域签名 URL（无 cookie）；omit 避免触发 CORS 凭据模式。
        // 进度按流式到达的字节增量累计（未遂块重试前会负增量回滚）。
        const buf = await fetchChunk(task.url, task.intraStart, task.intraEnd, 'omit', (d) => {
          received += d
          reportPct()
        })
        await writable.write({ type: 'write', position: task.globalPos, data: buf as BufferSource })
      }
    }
    await Promise.all(Array.from({ length: Math.min(GW_CONCURRENCY, tasks.length) }, () => worker()))
    if (received < total) throw new Error('incomplete')
    opts.onPct?.(100)
    await writable.close()
    return 'done'
  } catch (e) {
    await writable.abort(e).catch(() => undefined)
    throw e
  }
}
