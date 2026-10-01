/**
 * 浏览器端 MTProto 客户端工厂（仅客户端引用；切勿在服务端 import）。
 *
 * gramjs 在 Vite 浏览器 bundle 里默认仍 new w3cwebsocket（来自 Node `websocket`
 * 包，会把 http/tls 等拖进依赖图）；这里显式传入基于浏览器原生 WebSocket 的
 * socket 实现，接口对齐 gramjs 的 PromisedWebSockets（connect/read/write）。
 *
 * 传输与 Worker 侧一致：ConnectionTCPObfuscated over WSS（wss://*.web.telegram.org/apiws）。
 * 浏览器判定（window 存在）下 gramjs 的 DC 表本身就是 web 主机，无需改 IP。
 */
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'

class BrowserWsSocket {
  client: WebSocket | undefined
  private stream = new Uint8Array(0)
  closed = true
  private canRead: Promise<boolean> = Promise.resolve(true)
  private resolveRead: ((v: boolean) => void) | undefined

  async readExactly(n: number): Promise<Uint8Array> {
    let out = new Uint8Array(0)
    let remaining = n
    while (remaining > 0) {
      const part = await this.read(remaining)
      const merged = new Uint8Array(out.length + part.length)
      merged.set(out, 0)
      merged.set(part, out.length)
      out = merged
      remaining -= part.length
    }
    return out
  }

  async read(n: number): Promise<Uint8Array> {
    if (this.closed) throw new Error('WebSocket was closed')
    await this.canRead
    if (this.closed) throw new Error('WebSocket was closed')
    const out = this.stream.subarray(0, n)
    this.stream = this.stream.subarray(n)
    if (this.stream.length === 0) {
      this.canRead = new Promise<boolean>((resolve) => { this.resolveRead = resolve })
    }
    // 返回独立拷贝：subarray 视图在下次写入后可能失效
    return out.slice()
  }

  async readAll(): Promise<Uint8Array> {
    if (this.closed || !(await this.canRead)) throw new Error('WebSocket was closed')
    const out = this.stream
    this.stream = new Uint8Array(0)
    this.canRead = new Promise<boolean>((resolve) => { this.resolveRead = resolve })
    return out
  }

  async connect(port: number, ip: string, testServers = false): Promise<this> {
    this.stream = new Uint8Array(0)
    this.canRead = new Promise<boolean>((resolve) => { this.resolveRead = resolve })
    this.closed = false
    const proto = port === 443 ? 'wss' : 'ws'
    const url = `${proto}://${ip}:${port}/apiws${testServers ? '_test' : ''}`
    this.client = new WebSocket(url, 'binary')
    this.client.binaryType = 'arraybuffer'
    return new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error('no ws'))
      this.client.onopen = () => resolve(this)
      this.client.onerror = () => reject(new Error('无法连接 Telegram（请检查浏览器代理是否放行 wss://*.web.telegram.org）'))
      this.client.onclose = () => {
        this.closed = true
        this.resolveRead?.(false)
      }
      this.client.onmessage = (ev: MessageEvent) => {
        const chunk = new Uint8Array(ev.data as ArrayBuffer)
        const merged = new Uint8Array(this.stream.length + chunk.length)
        merged.set(this.stream, 0)
        merged.set(chunk, this.stream.length)
        this.stream = merged
        this.resolveRead?.(true)
      }
    })
  }

  write(data: Uint8Array): void {
    if (this.closed || !this.client) throw new Error('WebSocket was closed')
    this.client.send(data)
  }

  async close(): Promise<void> {
    this.closed = true
    try { this.client?.close() } catch { /* ignore */ }
  }
}

export interface MtBrowserClient {
  client: TelegramClient
  /** 断开并释放 socket */
  destroy(): Promise<void>
}

export async function createMtBrowserClient(apiId: number, apiHash: string, sessionString = ''): Promise<MtBrowserClient> {
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    networkSocket: BrowserWsSocket as never,
    autoReconnect: false,
    connectionRetries: 2,
    requestRetries: 2,
    retryDelay: 800,
    timeout: 25,
    useWSS: true,
  })
  ;(client as unknown as { setLogLevel(level: string): void }).setLogLevel('none')
  await client.connect()
  return {
    client,
    destroy: async () => {
      try { await client.disconnect() } catch { /* ignore */ }
    },
  }
}

/** 导出当前 StringSession（登录成功后保存到 KV） */
export function exportSessionString(client: TelegramClient): string {
  const s = client.session as unknown as { save(): string }
  return s.save()
}
