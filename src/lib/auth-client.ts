// 自建账户体系的浏览器客户端（替代 @netlify/identity）
// 服务端：/api/auth（HMAC JWT 存于 httpOnly 的 sg_auth cookie）

export type AuthUser = { id: string; email: string; name: string }

export class AuthRequestError extends Error {
  status: number
  data: Record<string, unknown>
  constructor(message: string, status: number, data: Record<string, unknown>) {
    super(message)
    this.name = 'AuthRequestError'
    this.status = status
    this.data = data
  }
}

let cached: AuthUser | null | undefined
let inflight: Promise<AuthUser | null> | null = null
const listeners = new Set<(user: AuthUser | null) => void>()

function setCachedUser(user: AuthUser | null) {
  cached = user
  for (const fn of listeners) {
    try { fn(user) } catch { /* 监听器异常不影响其他订阅 */ }
  }
  window.dispatchEvent(new CustomEvent('sg-auth-change', { detail: user }))
}

/** 订阅登录态变化（对齐旧 onAuthChange 的退订用法） */
export function onAuthChange(fn: (user: AuthUser | null) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** 获取当前登录用户（单次内存缓存；force 用于登录/登出后的强制刷新） */
export function getUser(force = false): Promise<AuthUser | null> {
  if (!force && cached !== undefined) return Promise.resolve(cached)
  if (!force && inflight) return inflight
  const request = (async () => {
    try {
      const res = await fetch('/api/auth?action=me', { credentials: 'same-origin' })
      if (!res.ok) return null
      const data = (await res.json().catch(() => ({}))) as { user?: AuthUser | null }
      return data.user ?? null
    } catch {
      return null
    }
  })()
  inflight = request.then((u) => {
    cached = u
    return u
  })
  return inflight.finally(() => { inflight = null }) as Promise<AuthUser | null>
}

async function postAuth(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch('/api/auth', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new AuthRequestError(
      typeof data.error === 'string' ? data.error : '操作失败，请稍后重试。',
      res.status,
      data,
    )
  }
  return data
}

export async function login(email: string, password: string): Promise<AuthUser> {
  const data = await postAuth({ action: 'login', email, password })
  const user = data.user as AuthUser
  setCachedUser(user)
  return user
}

export type SignupResult = {
  user?: AuthUser
  needsConfirmation?: boolean
  autoConfirmed?: boolean
}

export async function signup(email: string, password: string, displayName?: string): Promise<SignupResult> {
  const data = await postAuth({ action: 'register', email, password, displayName })
  const user = data.user as AuthUser | undefined
  if (user) setCachedUser(user)
  return {
    user,
    needsConfirmation: !!data.needsConfirmation,
    autoConfirmed: !!data.autoConfirmed,
  }
}

export async function logout(): Promise<void> {
  try {
    await postAuth({ action: 'logout' })
  } finally {
    setCachedUser(null)
  }
}

export async function requestPasswordReset(email: string): Promise<string> {
  const data = await postAuth({ action: 'forgot', email })
  return typeof data.message === 'string' ? data.message : '若该邮箱已注册，重置邮件稍后送达。'
}

export async function resetPassword(token: string, password: string): Promise<AuthUser> {
  const data = await postAuth({ action: 'reset', token, password })
  const user = data.user as AuthUser
  setCachedUser(user)
  return user
}

/** 重新发送验证邮件（服务端复用 register 逻辑：要求 email + password） */
export async function resendConfirmation(email: string, password: string): Promise<{ needsConfirmation?: boolean; autoConfirmed?: boolean; user?: AuthUser }> {
  const data = await postAuth({ action: 'resendConfirmation', email, password })
  const user = data.user as AuthUser | undefined
  if (user) setCachedUser(user)
  return {
    user,
    needsConfirmation: !!data.needsConfirmation,
    autoConfirmed: !!data.autoConfirmed,
  }
}

export async function changePassword(password: string): Promise<void> {
  await postAuth({ action: 'changePassword', password })
}

export async function updateDisplayName(displayName: string): Promise<AuthUser> {
  const data = await postAuth({ action: 'updateProfile', displayName })
  const user = data.user as AuthUser
  setCachedUser(user)
  return user
}

export async function deleteAccount(): Promise<void> {
  await postAuth({ action: 'deleteAccount' })
  setCachedUser(null)
}

const NOTICE_TEXT: Record<string, string> = {
  'email-confirmed': '邮箱验证成功，已自动登录。',
  'bad-token': '验证链接无效。',
  'token-expired': '验证链接已过期，请重新登录或注册。',
}

/**
 * 读取并清理 URL 上的认证参数：
 * - ?notice=email-confirmed|bad-token|token-expired|confirm-failed:...
 * - ?reset-token=...（找回密码邮件落地）
 * 仅在浏览器端调用一次。
 */
export function consumeUrlAuthParams(): { notice?: string; resetToken?: string } {
  if (typeof window === 'undefined') return {}
  const url = new URL(window.location.href)
  const rawNotice = url.searchParams.get('notice')
  const resetToken = url.searchParams.get('reset-token')
  if (rawNotice || resetToken) {
    url.searchParams.delete('notice')
    url.searchParams.delete('reset-token')
    window.history.replaceState(null, '', url.pathname + url.search + url.hash)
  }
  let notice: string | undefined
  if (rawNotice) {
    if (rawNotice.startsWith('confirm-failed:')) notice = decodeURIComponent(rawNotice.slice('confirm-failed:'.length))
    else notice = NOTICE_TEXT[rawNotice] ?? rawNotice
  }
  return { notice, resetToken: resetToken ?? undefined }
}
