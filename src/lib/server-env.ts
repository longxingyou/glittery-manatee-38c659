/**
 * 服务端环境变量（Cloudflare Workers vars/secrets）。
 *
 * Worker 入口（worker.ts）在每次 fetch 时通过 setWorkerEnv 注入 env；
 * env 对同一 isolate 内所有请求相同，挂在模块级变量上没有并发串号风险。
 * 普通 Node 脚本（探测/迁移脚本）下回退 process.env。
 *
 * 该文件可被客户端 bundle 安全包含：不依赖任何 Node/Workers 专有模块，
 * 且仅在服务端函数执行路径中被真正调用。
 */

export interface ServerEnv {
  /** Neon Postgres 连接串 */
  DATABASE_URL?: string
  /** Resend API key（注册验证 / 找回密码邮件） */
  RESEND_API_KEY?: string
  /** 发件人地址（需在 Resend 验证域名）；缺省用 onboarding@resend.dev */
  RESEND_FROM?: string
  /**
   * 面向用户的规范站点源（如 https://wow.xn--fpr224a.mom）。
   * 跨账号代理架构下 Worker 收到的 request.url 永远是 workers.dev，
   * 邮件链接与验证跳转必须以此为准，否则国内用户打不开。
   */
  PUBLIC_ORIGIN?: string
  /** 管理员邮箱白名单（逗号/分号/空格分隔） */
  ADMIN_EMAILS?: string
  /** KV 缓存命名空间：公开数据（文章列表等）跨 colo 共享，绕过 CF→Neon 高延迟 */
  SG_CACHE?: KVNamespace
  /** Telegram Bot token（@BotFather 创建）：附件分片存储的代理凭据，仅 Worker 持有 */
  TG_BOT_TOKEN?: string
  /** 存文件的会话 id：bot 为管理员的私有频道/群组（如 -100xxxxxxxxxx） */
  TG_STORAGE_CHAT_ID?: string
  /** MTProto 应用凭据（可选；通常存 KV，由 /mt-setup 浏览器登录页写入） */
  TG_API_ID?: string
  TG_API_HASH?: string
}

/** Cloudflare Workers KV 命名空间的最小类型（避免依赖 @cloudflare/workers-types 全局） */
interface KVNamespace {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

let workerEnv: Partial<ServerEnv> | null = null

export function setWorkerEnv(env: unknown): void {
  workerEnv = (env ?? {}) as Partial<ServerEnv>
}

/**
 * Worker 的 ExecutionContext 桥：仅用于响应返回后的后台续跑（如 RSS 源
 * stale-while-revalidate 刷新）。每次请求由 worker.ts 注入。
 */
interface WaitUntilFn {
  waitUntil(promise: Promise<unknown>): void
}
let workerCtx: WaitUntilFn | null = null

export function setWorkerCtx(ctx: unknown): void {
  workerCtx = (ctx ?? null) as WaitUntilFn | null
}

/**
 * 当前请求 origin 桥：边缘缓存（caches.default）的键含 origin，
 * 文章保存后在 Server Function 内主动失效边缘 HTML 时需要用它拼键。
 * 每次 fetch 由 worker.ts 注入；模块变量按请求覆盖（isolate 内并发安全靠
 * 失效操作紧跟同一请求的 await 链执行，不存在跨请求借用）。
 */
let workerOrigin = ''

export function setWorkerRequest(request: Request): void {
  try {
    workerOrigin = new URL(request.url).origin
  } catch {
    workerOrigin = ''
  }
}

export function getWorkerOrigin(): string {
  return workerOrigin
}

/**
 * 在响应返回后继续执行后台任务：有 Worker ctx 时用 waitUntil 续期，
 * 否则尽力 fire-and-forget（普通 Node/无 ctx 环境不保证跑完）。
 */
export function runInBackground(task: Promise<unknown>): void {
  task.catch(() => undefined)
  if (workerCtx?.waitUntil) {
    try {
      workerCtx.waitUntil(task)
    } catch {
      // 某些非标准 ctx 会抛错；任务本身已在跑，忽略即可
    }
  }
}

export function getEnv(): Partial<ServerEnv> {
  if (workerEnv) return workerEnv
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env ?? {}
}

/**
 * 面向用户的规范站点源（如 https://wow.xn--fpr224a.mom）。
 *
 * 跨账号代理架构下，Worker 收到的 request.url 永远是 workers.dev，
 * 直接用它构造链接（RSS、sitemap、OG url）会把国内用户引到不可达地址。
 * 优先取 PUBLIC_ORIGIN；缺省回退请求源；客户端（head fn 客户端执行时）
 * 回退当前页面 origin。
 */
export function getPublicOrigin(request?: Request): string {
  const configured = (getEnv().PUBLIC_ORIGIN || '').trim().replace(/\/+$/, '')
  if (configured) return configured
  if (request) return new URL(request.url).origin
  if (typeof window !== 'undefined') return window.location.origin
  return ''
}
