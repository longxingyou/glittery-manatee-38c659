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
}

let workerEnv: Partial<ServerEnv> | null = null

export function setWorkerEnv(env: unknown): void {
  workerEnv = (env ?? {}) as Partial<ServerEnv>
}

export function getEnv(): Partial<ServerEnv> {
  if (workerEnv) return workerEnv
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env ?? {}
}
