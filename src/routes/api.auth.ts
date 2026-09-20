import { createFileRoute } from '@tanstack/react-router'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'

import * as dbApi from '../../db/index.js'
import { getEnv } from '../lib/server-env.js'

// ============================================================
// 自建账户 API（替代 Netlify Identity）
// GET  /api/auth?action=me
// GET  /api/auth?action=confirm&token=...   （邮件验证链接，302 回首页）
// POST /api/auth  body: { action, ... }
//   register | login | logout | forgot | reset | changePassword |
//   resendConfirmation | updateProfile | deleteAccount
// ============================================================

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const CONFIRM_TTL_MS = 24 * 60 * 60 * 1000
const RESET_TTL_MS = 60 * 60 * 1000

type AuthUser = { id: string; email: string; name: string }

function json(data: unknown, init?: number | ResponseInit, cookie?: string): Response {
  const headers = new Headers((typeof init === 'number' ? undefined : init?.headers) ?? undefined)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  headers.set('Cache-Control', 'no-store')
  if (cookie) headers.append('Set-Cookie', cookie)
  return new Response(JSON.stringify(data), {
    status: typeof init === 'number' ? init : (init?.status ?? 200),
    headers,
  })
}

function authCookie(token: string, secure: boolean): string {
  const parts = [
    `${dbApi.AUTH_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${dbApi.AUTH_COOKIE_MAX_AGE}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

function clearAuthCookie(secure: boolean): string {
  const parts = [`${dbApi.AUTH_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

// 令牌原文只出现在邮件链接里，库存 SHA-256 哈希
async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}

async function sendEmail(to: string, subject: string, link: string, lead: string, cta: string): Promise<void> {
  const apiKey = getEnv().RESEND_API_KEY
  const from = getEnv().RESEND_FROM || 'onboarding@resend.dev'
  const html = `<!doctype html><meta charset="utf-8"><div style="max-width:520px;margin:0 auto;font-family:ui-sans-serif,system-ui,sans-serif;color:#1f2937;line-height:1.7">
<p style="font-family:ui-monospace,Consolas,monospace;color:#0e7490;font-weight:700">Syntax Garden</p>
<p>${escapeHtml(lead)}</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 22px;background:#0e7490;color:#fff!important;text-decoration:none;border-radius:6px">${escapeHtml(cta)}</a></p>
<p style="color:#6b7280;font-size:13px;word-break:break-all">如果按钮无法点击，请复制此链接到浏览器：<br>${escapeHtml(link)}</p>
<p style="color:#9ca3af;font-size:12px">链接有效期 ${cta.includes('重置') ? '1' : '24'} 小时。如非本人操作，请忽略此邮件。</p>
</div>`
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`邮件服务暂不可用（${res.status}），请稍后重试。${detail ? ` ${detail.slice(0, 200)}` : ''}`)
  }
}

async function issueCookieFor(userId: string, email: string, secure: boolean): Promise<string> {
  const token = await dbApi.issueAuthToken(userId, email)
  return authCookie(token, secure)
}

/**
 * 面向用户的规范站点源。
 * 本站部署在跨账号代理之后：朋友账号的 Worker 把 wow.xn--fpr224a.mom
 * 转发到本 Worker 的 workers.dev，因此 request.url 的 origin 是 workers.dev，
 * 不能用于构造邮件链接。优先取 PUBLIC_ORIGIN（wrangler vars），缺省回退请求源。
 */
function publicOrigin(request: Request): string {
  const configured = (getEnv().PUBLIC_ORIGIN || '').trim().replace(/\/+$/, '')
  if (configured) return configured
  return new URL(request.url).origin
}

/**
 * 带 Set-Cookie 的 302 跳转。
 * 不能对 Response.redirect() 的结果 append 头——其 headers 按 Fetch 规范是
 * immutable 的，workerd 会抛 "Can't modify immutable headers"。
 * 必须新建 Response 并显式给 Location。
 */
function redirectWithCookie(path: string, origin: string, cookie?: string): Response {
  const headers = new Headers({ Location: new URL(path, origin).toString() })
  if (cookie) headers.append('Set-Cookie', cookie)
  return new Response(null, { status: 302, headers })
}

// ---------------- GET ----------------

async function handleMe(): Promise<Response> {
  const user = await dbApi.getCurrentUser()
  return json({ user: (user as AuthUser | null) ?? null })
}

async function handleConfirm(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const origin = publicOrigin(request)
  // 规范源是 https 时 cookie 必须带 Secure；回退到请求源时按其协议判断
  const secure = origin.startsWith('https:')
  const token = url.searchParams.get('token') || ''
  if (!token || token.length < 20) return redirectWithCookie('/?notice=bad-token', origin)
  try {
    await dbApi.ensureSchema()
    const tokenHash = await hashToken(token)
    const db = dbApi.useDb()
    const [row] = await db
      .select()
      .from(dbApi.schema.users)
      .where(and(eq(dbApi.schema.users.confirmTokenHash, tokenHash), isNull(dbApi.schema.users.confirmedAt)))
      .limit(1)
    if (!row) return redirectWithCookie('/?notice=bad-token', origin)
    if (!row.confirmExpires || row.confirmExpires.getTime() < Date.now()) {
      return redirectWithCookie('/?notice=token-expired', origin)
    }
    await db
      .update(dbApi.schema.users)
      .set({ confirmedAt: new Date(), confirmTokenHash: null, confirmExpires: null })
      .where(eq(dbApi.schema.users.id, row.id))
    dbApi.invalidateUserCache(row.id)
    const cookie = await issueCookieFor(row.id, row.email, secure)
    return redirectWithCookie('/?notice=email-confirmed', origin, cookie)
  } catch (e) {
    const msg = e instanceof Error ? e.message : '确认失败'
    return redirectWithCookie(`/?notice=${encodeURIComponent('confirm-failed:' + msg)}`, origin)
  }
}

// ---------------- POST actions ----------------

const registerSchema = z.object({
  email: z.string().trim().min(3).max(200),
  password: z.string().min(8).max(200),
  displayName: z.string().trim().max(20).optional(),
})

async function handleRegister(request: Request, body: unknown): Promise<Response> {
  const parsed = registerSchema.safeParse(body)
  if (!parsed.success) return json({ error: '请填写邮箱与至少 8 位的密码。' }, 400)
  const email = parsed.data.email.toLowerCase()
  if (!EMAIL_RE.test(email)) return json({ error: '邮箱格式不正确。' }, 400)
  const displayName = (parsed.data.displayName || '').slice(0, 20)

  await dbApi.ensureSchema()
  const db = dbApi.useDb()
  const { hash, salt } = await dbApi.hashPassword(parsed.data.password)
  const confirmToken = dbApi.randomHex(24)
  const tokenHash = await hashToken(confirmToken)
  const expires = new Date(Date.now() + CONFIRM_TTL_MS)

  const [existing] = await db.select().from(dbApi.schema.users).where(eq(dbApi.schema.users.email, email)).limit(1)
  if (existing?.confirmedAt) return json({ error: '该邮箱已注册，请直接登录。' }, 409)

  if (existing) {
    // 未完成验证的重复注册：更新密码与昵称，重发验证邮件
    await db
      .update(dbApi.schema.users)
      .set({ passwordHash: hash, passwordSalt: salt, displayName, confirmTokenHash: tokenHash, confirmExpires: expires })
      .where(eq(dbApi.schema.users.id, existing.id))
  } else {
    await db.insert(dbApi.schema.users).values({
      id: dbApi.randomHex(16),
      email,
      passwordHash: hash,
      passwordSalt: salt,
      displayName,
      confirmTokenHash: tokenHash,
      confirmExpires: expires,
    })
  }

  // 邮件服务未配置：拒绝注册，而不是静默自动确认
  if (!getEnv().RESEND_API_KEY) {
    return json({ error: '邮件服务尚未配置，暂时无法完成注册。请联系管理员。' }, 503)
  }

  const origin = publicOrigin(request)
  const link = `${origin}/api/auth?action=confirm&token=${confirmToken}`
  await sendEmail(email, '【Syntax Garden】请验证你的邮箱', link, '欢迎注册 Syntax Garden！请点击下方按钮完成邮箱验证：', '验证邮箱')
  return json({ ok: true, needsConfirmation: true })
}

const loginSchema = z.object({
  email: z.string().trim().min(3).max(200),
  password: z.string().min(1).max(200),
})

async function handleLogin(body: unknown, secure: boolean): Promise<Response> {
  const parsed = loginSchema.safeParse(body)
  if (!parsed.success) return json({ error: '请输入邮箱与密码。' }, 400)
  const email = parsed.data.email.toLowerCase()
  if (!EMAIL_RE.test(email)) return json({ error: '邮箱或密码不正确。' }, 401)
  await dbApi.ensureSchema()
  const [row] = await dbApi.useDb().select().from(dbApi.schema.users).where(eq(dbApi.schema.users.email, email)).limit(1)
  if (!row) return json({ error: '邮箱或密码不正确。' }, 401)
  const ok = await dbApi.verifyPassword(parsed.data.password, row.passwordSalt, row.passwordHash)
  if (!ok) return json({ error: '邮箱或密码不正确。' }, 401)
  if (!row.confirmedAt) {
    return json({ error: '邮箱尚未验证，请先查收验证邮件完成激活。', needConfirm: true }, 403)
  }
  const cookie = await issueCookieFor(row.id, row.email, secure)
  return json({ user: { id: row.id, email: row.email, name: row.displayName || row.email.split('@')[0] } }, 200, cookie)
}

const forgotSchema = z.object({ email: z.string().trim().min(3).max(200) })

async function handleForgot(request: Request, body: unknown): Promise<Response> {
  const parsed = forgotSchema.safeParse(body)
  const generic = { ok: true, message: '若该邮箱已注册，重置密码邮件稍后会送达，请查收收件箱或垃圾邮件。' }
  if (!parsed.success) return json(generic)
  const email = parsed.data.email.toLowerCase()
  if (!EMAIL_RE.test(email) || !getEnv().RESEND_API_KEY) return json(generic)
  try {
    await dbApi.ensureSchema()
    const db = dbApi.useDb()
    const [row] = await db.select().from(dbApi.schema.users).where(eq(dbApi.schema.users.email, email)).limit(1)
    if (!row || !row.confirmedAt) return json(generic)
    const resetToken = dbApi.randomHex(24)
    await db
      .update(dbApi.schema.users)
      .set({ resetTokenHash: await hashToken(resetToken), resetExpires: new Date(Date.now() + RESET_TTL_MS) })
      .where(eq(dbApi.schema.users.id, row.id))
    const origin = publicOrigin(request)
    const link = `${origin}/?reset-token=${resetToken}`
    await sendEmail(email, '【Syntax Garden】重置你的密码', link, '我们收到了重置密码的请求，请点击下方按钮设置新密码（链接 1 小时内有效）：', '重置密码')
  } catch {
    // 不暴露发送失败导致的账户枚举差异；用户可稍后再试
  }
  return json(generic)
}

const resetSchema = z.object({ token: z.string().min(20).max(200), password: z.string().min(8).max(200) })

async function handleReset(body: unknown, secure: boolean): Promise<Response> {
  const parsed = resetSchema.safeParse(body)
  if (!parsed.success) return json({ error: '新密码至少需要 8 位。' }, 400)
  await dbApi.ensureSchema()
  const db = dbApi.useDb()
  const tokenHash = await hashToken(parsed.data.token)
  const [row] = await db
      .select()
      .from(dbApi.schema.users)
      .where(eq(dbApi.schema.users.resetTokenHash, tokenHash))
      .limit(1)
  if (!row || !row.resetExpires || row.resetExpires.getTime() < Date.now()) {
    return json({ error: '重置链接无效或已过期，请重新申请。' }, 400)
  }
  const { hash, salt } = await dbApi.hashPassword(parsed.data.password)
  await db
    .update(dbApi.schema.users)
    .set({
      passwordHash: hash,
      passwordSalt: salt,
      resetTokenHash: null,
      resetExpires: null,
      confirmedAt: row.confirmedAt ?? new Date(),
      confirmTokenHash: null,
      confirmExpires: null,
    })
    .where(eq(dbApi.schema.users.id, row.id))
  dbApi.invalidateUserCache(row.id)
  const cookie = await issueCookieFor(row.id, row.email, secure)
  return json({ user: { id: row.id, email: row.email, name: row.displayName || row.email.split('@')[0] } }, 200, cookie)
}

async function handleChangePassword(body: unknown): Promise<Response> {
  const user = await dbApi.getCurrentUser()
  if (!user) return json({ error: '请先登录。', authRequired: true }, 401)
  const parsed = z.object({ password: z.string().min(8).max(200) }).safeParse(body)
  if (!parsed.success) return json({ error: '新密码至少需要 8 位。' }, 400)
  const { hash, salt } = await dbApi.hashPassword(parsed.data.password)
  await dbApi
    .useDb()
    .update(dbApi.schema.users)
    .set({ passwordHash: hash, passwordSalt: salt })
    .where(eq(dbApi.schema.users.id, user.id))
  return json({ ok: true })
}

async function handleUpdateProfile(body: unknown): Promise<Response> {
  const user = await dbApi.getCurrentUser()
  if (!user) return json({ error: '请先登录。', authRequired: true }, 401)
  const parsed = z.object({ displayName: z.string().trim().min(1).max(20) }).safeParse(body)
  if (!parsed.success) return json({ error: '昵称需为 1–20 个字符。' }, 400)
  const { displayName } = await dbApi.syncDisplayName(parsed.data.displayName)
  return json({ user: { id: user.id, email: user.email, name: displayName } })
}

async function handleDeleteAccount(secure: boolean): Promise<Response> {
  const user = await dbApi.getCurrentUser()
  if (!user) return json({ error: '请先登录。', authRequired: true }, 401)
  await dbApi.anonymizeAccount()
  return json({ ok: true }, { status: 200, headers: { 'Set-Cookie': clearAuthCookie(secure) } })
}

async function handleLogout(secure: boolean): Promise<Response> {
  return json({ ok: true }, { status: 200, headers: { 'Set-Cookie': clearAuthCookie(secure) } })
}

async function handlePost(request: Request): Promise<Response> {
  const secure = new URL(request.url).protocol === 'https:'
  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    return json({ error: '请求体不是合法 JSON。' }, 400)
  }
  const action = (body as { action?: string } | null)?.action
  try {
    switch (action) {
      case 'register':
        return await handleRegister(request, body)
      case 'login':
        return await handleLogin(body, secure)
      case 'logout':
        return await handleLogout(secure)
      case 'forgot':
        return await handleForgot(request, body)
      case 'reset':
        return await handleReset(body, secure)
      case 'changePassword':
        return await handleChangePassword(body)
      case 'resendConfirmation':
        // 复用 register（未确认账户会重发邮件）
        return await handleRegister(request, body)
      case 'updateProfile':
        return await handleUpdateProfile(body)
      case 'deleteAccount':
        return await handleDeleteAccount(secure)
      default:
        return json({ error: `未知操作：${String(action)}` }, 400)
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : '服务器开小差了，请稍后重试。'
    return json({ error: message }, 500)
  }
}

export const Route = createFileRoute('/api/auth')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const action = url.searchParams.get('action')
        try {
          if (action === 'me') return await handleMe()
          if (action === 'confirm') return await handleConfirm(request)
          return json({ error: '未知操作。' }, 400)
        } catch (e) {
          const message = e instanceof Error ? e.message : '服务器开小差了，请稍后重试。'
          return json({ error: message }, 500)
        }
      },
      POST: async ({ request }) => handlePost(request),
    },
  },
})
