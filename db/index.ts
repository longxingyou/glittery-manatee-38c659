import { drizzle } from 'drizzle-orm/neon-http'
import { neon } from '@neondatabase/serverless'
import { desc, eq, sql, and, ne, inArray, isNull, ilike } from 'drizzle-orm'
import { getCookie } from '@tanstack/react-start/server'
import { allPosts } from 'content-collections'

import * as schema from './schema.js'
import { getEnv } from '../src/lib/server-env.js'
import {
  DEFAULT_SITE_DESCRIPTION,
  DEFAULT_SITE_TITLE,
  type AdminSettings,
  type AdminStatus,
  type AttachmentPublic,
  type CategoryInfo,
  type PostData,
  type PostLanguage,
  type PostStatus,
  type SiteSettings,
  isPostLanguage,
} from '../src/lib/utils.js'

export { schema }

type Db = ReturnType<typeof drizzle<typeof schema>>

// 是否配置了 Neon 数据库（DATABASE_URL）。
// 未配置时所有"读"路径（文章/设置/分类/附件/评论列表）自动降级为静态内容 + 默认值；
// "写"路径（发文章/设置/评论/登录）抛出可读错误。
export function isDbConfigured(): boolean {
  return !!getEnv().DATABASE_URL
}

/**
 * 给 DB Promise 加硬超时。Neon 冷启动或网络异常时，底层 fetch 可能数十秒才失败，
 * 期间整个 Worker 请求被阻塞，Cloudflare 边缘会先返回 522。
 * 用 Promise.race 主动在 ms 后 reject，调用方 catch 后降级，保证页面能渲染。
 */
export function withDbTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时（>${ms / 1000}s），数据库可能正在冷启动`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * 读路径通用包装：直接执行查询；仅当报"表不存在"(Postgres 42P01) 时，
 * 才跑 ensureSchema() 建表后重试一次。
 * 稳态下（表早已建好）读请求永远不执行 ~40 条 DDL——冷启动关键路径只剩纯 SELECT，
 * 这是登录变慢、访客文章列表冷启动超时降级（看不到 DB 文章）的根因修复。
 */
export async function readWithSchemaFallback<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (!isUndefinedTableError(e)) throw e
    await ensureSchema()
    return fn()
  }
}

function isUndefinedTableError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code
  if (code === '42P01') return true
  const msg = e instanceof Error ? e.message : String(e)
  return /42P01|relation "[^"]+" does not exist|undefined_table/.test(msg)
}

// 旧名称兼容（探测脚本等外部引用）
export const netlifyDbConfigured = isDbConfigured

// =================================================================
// 模块级单例 drizzle 客户端。
//
// Cloudflare Workers 关键决策：使用 Neon serverless 的 **HTTP 驱动**
// （drizzle-orm/neon-http），而不是 WebSocket 的 Pool。
// 原因：Pool 持有的 WebSocket 连接与"首个创建它的请求"的 workerd
// 请求上下文绑定；后续请求复用空闲连接时，连接上的事件回调无法在新
// 请求上下文中续接，workerd 判定 Worker hung（即使启用
// no_handle_cross_request_promise_resolution 也不能恢复 socket 事件）。
// HTTP 驱动每条 SQL 都是一个无状态 fetch，天然无跨请求状态，最适合 Workers。
// 代价：不支持服务端事务（本站未使用），批量/RETURNING 均支持。
// =================================================================
let _db: Db | null = null

function buildClient(): Db {
  const connectionString = getEnv().DATABASE_URL
  if (!connectionString) {
    throw new Error('数据库未配置：缺少 DATABASE_URL（Neon 连接串）。')
  }
  try {
    // neon() 构造无 I/O；每条查询走一个 HTTPS POST
    const sqlClient = neon(connectionString)
    // drizzle 1.0 beta：client 放在配置对象中（neon-http 驱动）
    return drizzle({ client: sqlClient, schema })
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e)
    const err = new Error(
      `初始化 Neon 数据库客户端失败：${cause}。` +
      `请确认 DATABASE_URL（Neon Postgres 连接串）已通过 wrangler secret 或本地 .dev.vars 注入。`,
    )
    err.cause = e
    throw err
  }
}

export function useDb(): Db {
  if (!isDbConfigured()) {
    throw new Error(
      '数据库未配置（缺少 DATABASE_URL）。' +
      '本地浏览/搜索/RSS 等读功能自动降级为静态内容；' +
      '写操作（发布文章、评论、登录）需要在 .dev.vars 中配置 DATABASE_URL，或部署到 Cloudflare Workers 后设置同名 secret。',
    )
  }
  // 同步惰性单例：Pool 构造无 I/O；建表只能由 ensureSchema() 显式 await，
  // 不能在此 fire-and-forget（会触发 workerd 跨请求 Promise 上下文取消 → Worker hung）
  if (!_db) _db = buildClient()
  return _db
}

// 幂等建表（内部版，传入客户端调用；之前导出的 ensureSchema 保持兼容）
// 单飞控制：多个并发请求可能同时触发建表，多个并发
// CREATE TABLE IF NOT EXISTS 会在 pg_catalog 上竞态（23505 / 42P07），
// 因此全局只允许一个迁移在跑，且单语句容错。
// 注意：该单飞 Promise 会跨请求被 await，依赖 wrangler 配置中的
// no_handle_cross_request_promise_resolution 兼容标志，否则 workerd
// 会取消跨请求续体导致请求永久挂起。
let _schemaInflight: Promise<void> | null = null
async function ensureSchemaInternal(client: Db) {
  if (_schemaInflight) return _schemaInflight
  const run = (async () => {
    // 性能关键：全部 DDL 通过 Neon 的事务端点在【单次 HTTPS 请求】内批处理执行，
    // 而不是每条语句一个往返（冷启动时 40+ 次串行 RTT 是站点偶发变慢的主要来源）。
    // 整批是一个事务：与其它冷启动 isolate 并发竞态、撞 23505/42P07 时整体重试一次，
    // 第二轮所有 IF NOT EXISTS 均为空操作。
    for (let attempt = 0; ; attempt++) {
      // 每次尝试重新构建查询对象（execute 构建器不应跨批次复用）
      const statements = schemaStatements.map((s) => client.execute(s))
      try {
        await client.batch(statements as [typeof statements[number], ...(typeof statements[number])[]])
        return
      } catch (e) {
        const code = (e as { code?: string } | null)?.code
        if (attempt === 0 && (code === '23505' || code === '42P07')) continue
        throw e
      }
    }
  })()
  // 失败后清空缓存允许后续请求重试；成功后保持缓存（迁移不会回滚）
  run.catch(() => { if (_schemaInflight === run) _schemaInflight = null })
  _schemaInflight = run
  return run
}

const schemaStatements = [
    sql`CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      post_slug TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      user_email TEXT NOT NULL,
      body TEXT NOT NULL,
      parent_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      edited_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'published',
      likes INTEGER NOT NULL DEFAULT 0
    )`,
    sql`CREATE INDEX IF NOT EXISTS comments_post_slug_idx ON comments (post_slug, created_at)`,
    // 既有库的增量迁移：补齐回复/编辑/软删列与索引（幂等）
    sql`ALTER TABLE comments ADD COLUMN IF NOT EXISTS parent_id INTEGER`,
    sql`ALTER TABLE comments ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ`,
    sql`ALTER TABLE comments ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published'`,
    sql`CREATE INDEX IF NOT EXISTS comments_parent_id_idx ON comments (parent_id)`,
    sql`CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      categories TEXT[] NOT NULL DEFAULT '{}'::text[],
      status TEXT NOT NULL DEFAULT 'draft',
      date TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'zh',
      translation_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ
    )`,
    sql`CREATE INDEX IF NOT EXISTS posts_date_idx ON posts (date)`,
    // 既有库增量迁移：语言与翻译组列（幂等）
    sql`ALTER TABLE posts ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'zh'`,
    sql`ALTER TABLE posts ADD COLUMN IF NOT EXISTS translation_key TEXT`,
    sql`CREATE INDEX IF NOT EXISTS posts_translation_key_idx ON posts (translation_key)`,
    sql`CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      name_en TEXT,
      name_ru TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    // 既有库增量迁移：分类三语译名列（幂等）
    sql`ALTER TABLE categories ADD COLUMN IF NOT EXISTS name_en TEXT`,
    sql`ALTER TABLE categories ADD COLUMN IF NOT EXISTS name_ru TEXT`,
    sql`CREATE TABLE IF NOT EXISTS attachments (
      id SERIAL PRIMARY KEY,
      post_slug TEXT NOT NULL,
      filename TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      password_hash TEXT,
      password_salt TEXT,
      downloads INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    sql`CREATE INDEX IF NOT EXISTS attachments_post_slug_idx ON attachments (post_slug)`,
    sql`CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      site_title TEXT,
      site_description TEXT,
      custom_css TEXT,
      admin_emails TEXT,
      token_secret TEXT,
      banned_words TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    sql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS banned_words TEXT`,
    sql`INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
    // 用户资料（个签/昵称缓存）
    sql`CREATE TABLE IF NOT EXISTS profiles (
      user_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      signature TEXT NOT NULL DEFAULT '',
      signature_updated_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    // 管理员警告
    sql`CREATE TABLE IF NOT EXISTS warnings (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      message TEXT NOT NULL,
      issued_by TEXT NOT NULL,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    sql`CREATE INDEX IF NOT EXISTS warnings_user_id_idx ON warnings (user_id, created_at)`,
    // 用户反馈
    sql`CREATE TABLE IF NOT EXISTS feedback (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    )`,
    sql`CREATE INDEX IF NOT EXISTS feedback_status_idx ON feedback (status, created_at)`,
    // 反馈附件（私有）
    sql`CREATE TABLE IF NOT EXISTS feedback_attachments (
      id SERIAL PRIMARY KEY,
      feedback_id INTEGER,
      filename TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      owner_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    sql`CREATE INDEX IF NOT EXISTS feedback_attachments_fb_idx ON feedback_attachments (feedback_id)`,
    // 身份标签定义
    sql`CREATE TABLE IF NOT EXISTS user_tags (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '#7c3aed',
      effect TEXT NOT NULL DEFAULT 'solid',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    // profiles.tags 字段（若旧表无此列则补建）
    sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS tags TEXT NOT NULL DEFAULT ''`,
    // profiles.font_pref 字段（用户字体偏好；'' = 网站默认）
    sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS font_pref TEXT NOT NULL DEFAULT ''`,
    // 站点内容块（网站简介 / 友情链接，三语 Markdown，后台编辑）
    sql`CREATE TABLE IF NOT EXISTS site_content (
      key TEXT NOT NULL,
      lang TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (key, lang)
    )`,
    // 自建账户体系（替代 Netlify Identity）
    sql`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      confirmed_at TIMESTAMPTZ,
      confirm_token_hash TEXT,
      confirm_expires TIMESTAMPTZ,
      reset_token_hash TEXT,
      reset_expires TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
]

// 对外导出的幂等建表（懒取客户端再调用）
let _ensured: Promise<void> | null = null
export function ensureSchema(): Promise<void> {
  if (!isDbConfigured()) return Promise.resolve()
  if (_ensured) return _ensured
  const attempt = (async () => {
    const client = useDb()
    await ensureSchemaInternal(client)
  })()
  // 失败不缓存，允许后续请求重试（否则一次失败会永久拒绝）
  attempt.catch(() => { if (_ensured === attempt) _ensured = null })
  _ensured = attempt
  return _ensured
}

// ============================================================
// 加密工具：随机字节、PBKDF2 密码哈希（常量时间比对）、HMAC 令牌
// ============================================================
function toHex(bytes: Uint8Array) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}
function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(Math.floor(hex.length / 2))
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
function fromB64Url(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/')
  // 补齐到 4 的倍数；注意 need===0 时绝不能追加任何字符
  // （曾误用 '='.padStart(0)：它仍返回 1 个 '='，拼出非法填充导致 atob 抛错）
  const need = (4 - (pad.length % 4)) % 4
  const p = need ? pad + '='.repeat(need) : pad
  return Uint8Array.from(globalThis.atob(p), (c) => c.charCodeAt(0))
}
function toB64Url(bytes: Uint8Array): string {
  const b = globalThis.btoa(String.fromCharCode(...bytes))
  return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function randomHex(bytes = 32) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)))
}

export async function hashPassword(password: string) {
  const salt = randomHex(16)
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const derived = new Uint8Array(
    (await crypto.subtle.deriveBits(
      // Cloudflare Workers 限制 PBKDF2 迭代次数 ≤ 100,000
      { name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 100_000, hash: 'SHA-256' },
      keyMaterial,
      256,
    )) as ArrayBuffer,
  )
  return { salt, hash: toHex(derived) }
}

export async function verifyPassword(password: string, salt: string, expectedHash: string) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const derived = new Uint8Array(
    (await crypto.subtle.deriveBits(
      // Cloudflare Workers 限制 PBKDF2 迭代次数 ≤ 100,000
      { name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 100_000, hash: 'SHA-256' },
      keyMaterial,
      256,
    )) as ArrayBuffer,
  )
  const got = fromHex(toHex(derived))
  const want = fromHex(expectedHash)
  if (got.length !== want.length) return false
  let diff = 0
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i]
  return diff === 0
}

export async function signToken<T extends Record<string, unknown>>(payload: T, secretHex: string): Promise<string> {
  const header = toB64Url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const body = toB64Url(new TextEncoder().encode(JSON.stringify(payload)))
  const key = await crypto.subtle.importKey(
    'raw',
    fromHex(secretHex) as Uint8Array<ArrayBuffer>,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`)))
  return `${header}.${body}.${toB64Url(mac)}`
}

export async function verifyToken<T extends Record<string, unknown>>(
  token: string,
  secretHex: string,
): Promise<T | null> {
  try {
    const [header64, body64, sig64] = token.split('.')
    if (!header64 || !body64 || !sig64) return null
    const key = await crypto.subtle.importKey(
      'raw',
      fromHex(secretHex) as Uint8Array<ArrayBuffer>,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    const ok = await crypto.subtle.verify(
      'HMAC',
      key,
      fromB64Url(sig64) as Uint8Array<ArrayBuffer>,
      new TextEncoder().encode(`${header64}.${body64}`),
    )
    if (!ok) return null
    const payload = JSON.parse(new TextDecoder().decode(fromB64Url(body64))) as T & { exp?: number }
    if (typeof payload.exp === 'number' && payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

// ============================================================
// 站点设置
// （getSettingsRow 的懒加载 / mock 回退版本在下面的 admin 鉴权段附近定义）
// ============================================================

export async function getPublicSettings(): Promise<SiteSettings> {
  const row = await getSettingsRow()
  return {
    siteTitle: row.siteTitle || DEFAULT_SITE_TITLE,
    siteDescription: row.siteDescription || DEFAULT_SITE_DESCRIPTION,
    customCss: row.customCss || '',
  }
}

export async function getAdminSettings(): Promise<AdminSettings> {
  const row = await getSettingsRow()
  return {
    siteTitle: row.siteTitle || DEFAULT_SITE_TITLE,
    siteDescription: row.siteDescription || DEFAULT_SITE_DESCRIPTION,
    customCss: row.customCss || '',
    adminEmails: row.adminEmails || '',
    bannedWords: row.bannedWords || '',
  }
}

export async function saveAdminSettings(input: AdminSettings) {
  await requireAdmin()
  const trimmedTitle = input.siteTitle.trim().slice(0, 120)
  const trimmedDesc = input.siteDescription.trim().slice(0, 500)
  const trimmedBanned = input.bannedWords.trim().slice(0, 5000)
  await useDb()
    .insert(schema.settings)
    .values({
      id: 1,
      siteTitle: trimmedTitle || null,
      siteDescription: trimmedDesc || null,
      customCss: input.customCss.slice(0, 100_000) || null,
      adminEmails: input.adminEmails.trim().slice(0, 2000) || null,
      bannedWords: trimmedBanned || null,
      updatedAt: sql`NOW()`,
    })
    .onConflictDoUpdate({
      target: schema.settings.id,
      set: {
        siteTitle: trimmedTitle || null,
        siteDescription: trimmedDesc || null,
        customCss: input.customCss.slice(0, 100_000) || null,
        adminEmails: input.adminEmails.trim().slice(0, 2000) || null,
        bannedWords: trimmedBanned || null,
        updatedAt: sql`NOW()`,
      },
    })
  return getAdminSettings()
}

export async function getTokenSecret(): Promise<string> {
  const row = await getSettingsRow()
  if (row.tokenSecret) return row.tokenSecret
  const secret = randomHex(32)
  await useDb()
    .update(schema.settings)
    .set({ tokenSecret: secret, updatedAt: sql`NOW()` })
    .where(eq(schema.settings.id, 1))
  return secret
}

// ============================================================
// 管理员鉴权
// ============================================================
function parseEmails(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[,;\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  )
}
export function adminEmailList(): string[] {
  // settings 的读取是异步的；此处只返回 env 部分，settings 部分在 getAdminStatus 中合并
  return parseEmails(getEnv().ADMIN_EMAILS || '')
}

// settings 行短 TTL 缓存：requireAdmin 内部会先经 getTokenSecret → getSettingsRow 查一次 settings，
// 随后又经 tryGetSettingsRowReadonly 再查一次同一行。缓存后同一次请求内不再重复往返。
// settings 行改动极少（站点标题/管理员邮箱），10s TTL 完全可接受。
let _settingsCache: { row: NonNullable<Awaited<ReturnType<typeof getSettingsRowInternalRaw>>>; at: number } | null = null
const SETTINGS_CACHE_TTL = 10_000

async function getSettingsRowInternalRaw(_useCached = true) {
  // 读优先：直接 SELECT，仅当 settings 表不存在(42P01)才建表后重试（readWithSchemaFallback）
  return readWithSchemaFallback(async () => {
    const client = useDb()
    const rows = await client.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1)
    if (rows[0]) return rows[0]
    await client.insert(schema.settings).values({ id: 1 }).onConflictDoNothing()
    return (await client.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1))[0]
  })
}

async function getSettingsRowInternal(useCached = true) {
  // 缓存命中时直接返回，跳过 ensureSchema + SELECT
  if (_settingsCache && Date.now() - _settingsCache.at < SETTINGS_CACHE_TTL) return _settingsCache.row
  const row = await getSettingsRowInternalRaw(useCached)
  if (row) _settingsCache = { row, at: Date.now() }
  return row
}

// 一个"useCached=false + ignore errors"的只读 settings 行读取：
// 优先返回 DB 中的真实 settings 行；若 DB 不可用返回 null。
// 用于 getAdminStatus / requireAdmin 这类"只要 env adminEmails 也能工作"的场景。
async function tryGetSettingsRowReadonly() {
  // 未配置数据库时直接短路，避免每次请求都走一遍"抛错→捕获"链路
  if (!isDbConfigured()) return null
  // 缓存命中时直接返回
  if (_settingsCache && Date.now() - _settingsCache.at < SETTINGS_CACHE_TTL) return _settingsCache.row
  try {
    return await getSettingsRowInternal(false)
  } catch {
    return null
  }
}

const EMPTY_SETTINGS_ROW = {
  id: 1,
  siteTitle: null as string | null,
  siteDescription: null as string | null,
  customCss: null as string | null,
  adminEmails: null as string | null,
  bannedWords: null as string | null,
  tokenSecret: null as string | null,
  updatedAt: new Date(),
}

// settings 行加载器：未配置数据库时退化为全空默认行。
// settings 只是站点标题/描述/CSS 的覆盖项，缺省值完全可用，不应让前台 500。
async function getSettingsRow() {
  try {
    return await getSettingsRowInternal(true)
  } catch (e) {
    if (!isDbConfigured()) return EMPTY_SETTINGS_ROW
    throw e
  }
}

// ============================================================
// 自建认证：HMAC JWT（sg_auth，httpOnly cookie）
// ============================================================

export const AUTH_COOKIE_NAME = 'sg_auth'
const AUTH_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 天
export const AUTH_COOKIE_MAX_AGE = Math.floor(AUTH_TTL_MS / 1000)

type AuthTokenPayload = { sub: string; email: string; exp: number }
export type CurrentUser = { id: string; email: string; name: string }

function readAuthToken(): string | null {
  try {
    return getCookie(AUTH_COOKIE_NAME) ?? null
  } catch {
    // 脱离请求上下文（探测脚本等）调用时没有 h3 event
    return null
  }
}

/** 为已验证用户签发认证 cookie 用的 JWT */
export async function issueAuthToken(userId: string, email: string): Promise<string> {
  const secret = await getTokenSecret()
  return signToken<AuthTokenPayload>(
    { sub: userId, email, exp: Date.now() + AUTH_TTL_MS },
    secret,
  )
}

// 30 秒短缓存：getCurrentUser 在同一请求里可能被多次调用（评论列表/状态/附件等）
const USER_CACHE_TTL = 30_000
const _userCache = new Map<string, { at: number; user: CurrentUser }>()

export function invalidateUserCache(userId?: string) {
  if (userId) _userCache.delete(userId)
  else _userCache.clear()
}

/**
 * 当前登录访客身份（供评论的发表/编辑/删除与附件下载门禁使用）。
 * 读取 sg_auth cookie 中的 HMAC JWT，并以 users 表为准补齐昵称。
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const token = readAuthToken()
  if (!token || !isDbConfigured()) return null
  try {
    const secret = await getTokenSecret()
    const payload = await verifyToken<AuthTokenPayload>(token, secret)
    if (!payload?.sub || !payload.email) return null
    const hit = _userCache.get(payload.sub)
    if (hit && Date.now() - hit.at < USER_CACHE_TTL) return hit.user
    const [row] = await useDb()
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, payload.sub))
      .limit(1)
    if (!row || !row.confirmedAt) return null
    const user: CurrentUser = {
      id: row.id,
      email: row.email,
      name: row.displayName || row.email.split('@')[0]!,
    }
    if (_userCache.size > 1000) _userCache.clear()
    _userCache.set(row.id, { at: Date.now(), user })
    return user
  } catch {
    return null
  }
}

function adminEmailsAll(settingsRow: { adminEmails: string | null } | null): Set<string> {
  return new Set([
    ...parseEmails(getEnv().ADMIN_EMAILS || ''),
    ...(settingsRow ? parseEmails(settingsRow.adminEmails || '') : []),
  ])
}

export async function getAdminStatus(): Promise<AdminStatus> {
  const settingsRow = await tryGetSettingsRowReadonly()
  const all = adminEmailsAll(settingsRow)
  const me = await getCurrentUser()
  const email = me?.email ?? null
  return {
    authed: !!me,
    email,
    isAdmin: !!me && all.has(me.email.toLowerCase()),
    adminConfigured: all.size > 0,
  }
}

export async function requireAdmin() {
  const me = await getCurrentUser()
  if (!me?.email) throw new Error('请先登录。')
  const all = adminEmailsAll(await tryGetSettingsRowReadonly())
  if (!all.has(me.email.toLowerCase())) {
    throw new Error(`当前邮箱 ${me.email} 不在管理员名单内。`)
  }
  return { id: me.id, email: me.email, name: me.name }
}

// ============================================================
// 文章（静态 + DB 合并）
// ============================================================
export function readingTime(content: string): number {
  const clean = content.replace(/[#*`>$\[\]()_-]/g, '')
  return Math.max(2, Math.ceil(clean.length / 500))
}

function mapStaticPost(p: {
  slug: string
  title: string
  summary: string
  categories: string[]
  date: string
  content: string
  readingTime?: number
}): PostData {
  return {
    id: null,
    slug: p.slug,
    title: p.title,
    summary: p.summary,
    content: p.content,
    categories: [...p.categories],
    date: p.date,
    readingTime: p.readingTime || readingTime(p.content),
    status: 'published',
    source: 'static',
    updatedAt: null,
    // 静态种子文章均为中文原文
    language: 'zh',
    translationKey: null,
  }
}

type DbPostRow = {
  id: number
  slug: string
  title: string
  summary: string
  content: string
  categories: string[]
  status: string
  date: string
  language: string | null
  translationKey: string | null
  createdAt: Date | string
  updatedAt: Date | string | null
}
function mapDbPost(row: DbPostRow): PostData {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    content: row.content,
    categories: [...row.categories],
    date: row.date,
    readingTime: readingTime(row.content),
    status: (row.status === 'draft' ? 'draft' : 'published') as PostStatus,
    source: 'db',
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    language: isPostLanguage(row.language) ? row.language : 'zh',
    translationKey: row.translationKey || null,
  }
}

export async function listDbPosts(includeDrafts = true): Promise<PostData[]> {
  // 本地无 DB：仅静态文章（listPublishedPosts 会自动合并 allPosts）
  if (!isDbConfigured()) return []
  // 读优先：直接 SELECT，表不存在才建表重试（稳态零 DDL）
  return readWithSchemaFallback(() =>
    (includeDrafts
      ? useDb().select().from(schema.posts).orderBy(desc(schema.posts.date), desc(schema.posts.id))
      : useDb()
          .select()
          .from(schema.posts)
          .where(eq(schema.posts.status, 'published'))
          .orderBy(desc(schema.posts.date), desc(schema.posts.id)))
      .then((rows) => rows.map(mapDbPost)))
}

export async function listPublishedPosts(): Promise<PostData[]> {
  // DB 部分 9s 超时：冷启动超时后降级为仅静态文章，页面仍可正常渲染
  const dbPosts = await withDbTimeout(listDbPosts(false), 9_000, '读取文章列表').catch(() => [])
  const seen = new Set(dbPosts.map((p) => p.slug))
  const merged = [
    ...dbPosts,
    ...allPosts.filter((p) => !seen.has(p.slug)).map(mapStaticPost),
  ]
  merged.sort((a, b) => b.date.localeCompare(a.date))
  return merged
}

export async function getPublishedPost(slug: string): Promise<PostData | null> {
  // 优先查静态文章（构建时已编译入内存，零成本）
  const staticHit = allPosts.find((p) => p.slug === slug)
  if (staticHit) return mapStaticPost(staticHit)
  // 静态未命中再查库（仅按 slug + status='published' 单条查询，不拉全表）
  if (!isDbConfigured()) return null
  // 读优先：直接 SELECT，表不存在才建表重试
  return readWithSchemaFallback(async () => {
    const rows = await useDb()
      .select()
      .from(schema.posts)
      .where(and(eq(schema.posts.slug, slug), eq(schema.posts.status, 'published')))
      .limit(1)
    return rows[0] ? mapDbPost(rows[0]) : null
  })
}

export async function getDbPostById(id: number): Promise<PostData | null> {
  if (!isDbConfigured()) return null
  await ensureSchema()
  const rows = await useDb().select().from(schema.posts).where(eq(schema.posts.id, id)).limit(1)
  return rows[0] ? mapDbPost(rows[0]) : null
}

/** 按 slug 取库内文章（含草稿）；调用方自行做管理员鉴权 */
export async function getDbPostBySlug(slug: string): Promise<PostData | null> {
  if (!isDbConfigured()) return null
  await ensureSchema()
  const rows = await useDb().select().from(schema.posts).where(eq(schema.posts.slug, slug)).limit(1)
  return rows[0] ? mapDbPost(rows[0]) : null
}

export function staticSlugs(): Set<string> {
  return new Set(allPosts.map((p) => p.slug))
}

export type PostSaveInput = {
  id?: number | null
  slug: string
  title: string
  summary: string
  content: string
  categories: string[]
  status: PostStatus
  date: string
  language?: PostLanguage
  /** 翻译组键；空串/省略视为独立文章 */
  translationKey?: string | null
}

export async function savePost(input: PostSaveInput): Promise<{ id: number; slug: string }> {
  await requireAdmin()
  await ensureSchema()

  const slug = input.slug
    .toLowerCase()
    .trim()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 160)
  if (!slug) throw new Error('路径（slug）不能为空。')
  const title = input.title.trim()
  if (!title) throw new Error('文章标题不能为空。')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error('日期格式必须为 YYYY-MM-DD。')
  const categories = Array.from(new Set(input.categories.map((c) => c.trim()).filter(Boolean))).slice(0, 20)
  const language: PostLanguage = isPostLanguage(input.language) ? input.language : 'zh'
  const translationKey = (input.translationKey || '').trim().slice(0, 160) || null

  // 静态文章 slug 不可占用
  if (staticSlugs().has(slug) && !input.id) {
    throw new Error(`该路径「${slug}」已被静态文章占用，请换一个。`)
  }

  // slug 唯一性校验 + 翻译组同语言查重：两条件独立，并行化省一次往返
  const slugConflictPromise = useDb()
    .select({ id: schema.posts.id })
    .from(schema.posts)
    .where(and(eq(schema.posts.slug, slug), input.id ? ne(schema.posts.id, input.id) : undefined))
    .limit(1)
  const dupLangPromise = translationKey
    ? useDb()
        .select({ id: schema.posts.id })
        .from(schema.posts)
        .where(and(
          eq(schema.posts.translationKey, translationKey),
          eq(schema.posts.language, language),
          input.id ? ne(schema.posts.id, input.id) : undefined,
        ))
        .limit(1)
    : Promise.resolve([])
  const [conflict, dupLang] = await Promise.all([slugConflictPromise, dupLangPromise])
  if (conflict.length) throw new Error(`路径「${slug}」已存在，请换一个。`)
  if (translationKey && dupLang.length) throw new Error(`该语言版本已存在于翻译组「${translationKey}」中。`)

  // 自动登记分类到 categories 表：批量插入而非逐条 await
  for (const name of categories) {
    if (name.length > 40) throw new Error(`分类名「${name}」过长（≤40 字符）。`)
  }
  if (categories.length) {
    await useDb().insert(schema.categories).values(categories.map((name) => ({ name }))).onConflictDoNothing()
  }

  // 翻译组键约定为原文 slug：首次关联时把锚点文章补进同一组（与文章写入无依赖，并行）
  const anchorPromise = translationKey
    ? useDb()
        .update(schema.posts)
        .set({ translationKey })
        .where(and(eq(schema.posts.slug, translationKey), isNull(schema.posts.translationKey)))
    : Promise.resolve()
  if (input.id) {
    await Promise.all([
      useDb()
        .update(schema.posts)
        .set({
          slug,
          title,
          summary: input.summary.slice(0, 1000),
          content: input.content,
          categories,
          status: input.status,
          date: input.date,
          language,
          translationKey,
          updatedAt: sql`NOW()`,
        })
        .where(eq(schema.posts.id, input.id)),
      anchorPromise,
    ])
    return { id: input.id, slug }
  }
  const [ins] = await useDb()
    .insert(schema.posts)
    .values({
      slug,
      title,
      summary: input.summary.slice(0, 1000),
      content: input.content,
      categories,
      status: input.status,
      date: input.date,
      language,
      translationKey,
    })
    .returning({ id: schema.posts.id, slug: schema.posts.slug })
  await anchorPromise
  return { id: ins.id, slug: ins.slug }
}

export async function deletePost(id: number): Promise<void> {
  await requireAdmin()
  await ensureSchema()
  const rows = await useDb().select({ postSlug: schema.posts.slug }).from(schema.posts).where(eq(schema.posts.id, id)).limit(1)
  if (!rows.length) return
  // 删除附件
  const atts = await useDb()
    .select({ id: schema.attachments.id })
    .from(schema.attachments)
    .where(eq(schema.attachments.postSlug, rows[0]!.postSlug))
  for (const a of atts) await useDb().delete(schema.attachments).where(eq(schema.attachments.id, a.id))
  await useDb().delete(schema.posts).where(eq(schema.posts.id, id))
}

// ============================================================
// 分类
// ============================================================
export function listAllStaticCategoryNames(): string[] {
  const names = allPosts.flatMap((p: { categories: string[] }) => p.categories as string[]) as string[]
  return Array.from(new Set(names)).sort()
}

export async function listCategoryInfo(): Promise<CategoryInfo[]> {
  // 纯静态分类（零 DB），作为未配置 DB 或冷启动超时时的降级
  const buildStatic = (): CategoryInfo[] => {
    const staticCountBy = new Map<string, number>()
    for (const p of allPosts) for (const c of p.categories) {
      staticCountBy.set(c, (staticCountBy.get(c) || 0) + 1)
    }
    return Array.from(new Set([...staticCountBy.keys(), ...listAllStaticCategoryNames()]))
      .sort()
      .map((name) => ({ id: 0, name, nameEn: null, nameRu: null, dbCount: 0, staticCount: staticCountBy.get(name) || 0, builtin: staticCountBy.has(name) }))
  }

  // 本地无 DB：仅静态分类
  if (!isDbConfigured()) return buildStatic()

  // DB 查询（含 ensureSchema 建表）整体 7s 超时：冷启动时降级为纯静态分类，
  // 避免 root loader 的 Promise.all 被本查询拖到 522。
  // 读优先：表不存在(42P01)时 readWithSchemaFallback 自动建表重试；
  // 整体再套 7s 超时，冷启动过慢时降级纯静态分类，避免 root loader 被拖到 522。
  return withDbTimeout(readWithSchemaFallback(listCategoryInfoFromDb), 7_000, '读取分类').catch(() => buildStatic())
}

async function listCategoryInfoFromDb(): Promise<CategoryInfo[]> {
  // 读优先：两条 SELECT 直接执行，表不存在才整体建表重试（由调用处 listCategoryInfo 不再包 ensure）
  const dbCountBy = new Map<string, number>()
  const dbRows = await useDb()
    .select({
      name: sql<string>`unnest(${schema.posts.categories})`,
    })
    .from(schema.posts)
  for (const r of dbRows) {
    dbCountBy.set(r.name, (dbCountBy.get(r.name) || 0) + 1)
  }
  const staticCountBy = new Map<string, number>()
  for (const p of allPosts) for (const c of p.categories) {
    staticCountBy.set(c, (staticCountBy.get(c) || 0) + 1)
  }
  const categoryRows = await useDb()
    .select({
      id: schema.categories.id,
      name: schema.categories.name,
      nameEn: schema.categories.nameEn,
      nameRu: schema.categories.nameRu,
    })
    .from(schema.categories)
  const rowByName = new Map(categoryRows.map((r) => [r.name, r]))
  const allNames = Array.from(new Set([...categoryRows.map((r) => r.name), ...listAllStaticCategoryNames()])).sort()
  return allNames.map((name) => {
    const row = rowByName.get(name)
    return {
      id: row?.id || 0,
      name,
      nameEn: row?.nameEn || null,
      nameRu: row?.nameRu || null,
      dbCount: dbCountBy.get(name) || 0,
      staticCount: staticCountBy.get(name) || 0,
      // 静态文件衍生的分类恒为 builtin：即便已登记入 categories 表补译名，
      // 也不可改名/删除（改名会与 Markdown frontmatter 脱节）
      builtin: staticCountBy.has(name),
    }
  })
}

/** 规范化译名输入：去空白、空串 → null、限长 */
function normTranslation(v: string | null | undefined): string | null {
  const s = (v ?? '').trim()
  if (!s) return null
  return s.slice(0, 40)
}

export async function createCategory(
  name: string,
  translations?: { nameEn?: string | null; nameRu?: string | null },
): Promise<{ id: number; name: string }> {
  await requireAdmin()
  const trimmed = name.trim()
  if (!trimmed) throw new Error('分类名不能为空。')
  if (trimmed.length > 40) throw new Error('分类名长度需 ≤ 40 字符。')
  await ensureSchema()
  await useDb()
    .insert(schema.categories)
    .values({ name: trimmed, nameEn: normTranslation(translations?.nameEn), nameRu: normTranslation(translations?.nameRu) })
    .onConflictDoNothing()
  const row = (await useDb().select({ id: schema.categories.id, name: schema.categories.name }).from(schema.categories).where(eq(schema.categories.name, trimmed)).limit(1))[0]
  if (!row) throw new Error('分类创建失败。')
  return row
}

/**
 * 新建/编辑分类（含三语译名）。
 * - id 为空：按权威名 name upsert（静态衍生分类也由此“登记入行”，随后可写译名）；
 * - id 存在且 name 改变：同步 array_replace 所有 DB 文章的分类数组；
 *   静态 Markdown 衍生的分类（builtin）禁止改权威名，只能改译名。
 */
export async function saveCategory(input: {
  id?: number | null
  name: string
  nameEn?: string | null
  nameRu?: string | null
}): Promise<{ id: number; name: string }> {
  await requireAdmin()
  await ensureSchema()
  const name = input.name.trim()
  if (!name) throw new Error('分类名不能为空。')
  if (name.length > 40) throw new Error('分类名长度需 ≤ 40 字符。')
  const nameEn = normTranslation(input.nameEn)
  const nameRu = normTranslation(input.nameRu)
  const db = useDb()

  if (input.id) {
    const rows = await db
      .select({ id: schema.categories.id, name: schema.categories.name })
      .from(schema.categories)
      .where(eq(schema.categories.id, input.id))
      .limit(1)
    const current = rows[0]
    if (!current) throw new Error('分类不存在或已被删除。')
    if (current.name === name) {
      await db.update(schema.categories).set({ nameEn, nameRu }).where(eq(schema.categories.id, current.id))
      return { id: current.id, name }
    }
    // 权威名变更：静态文章仍引用旧名时禁止（会与 Markdown frontmatter 脱节）
    if (listAllStaticCategoryNames().includes(current.name)) {
      throw new Error('静态文章内置分类的中文名不可修改，只能补充英文/俄文译名。')
    }
    const dup = await db
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(and(eq(schema.categories.name, name), ne(schema.categories.id, current.id)))
      .limit(1)
    if (dup.length) throw new Error(`分类「${name}」已存在。`)
    // 同步 DB 文章分类数组中的旧名
    await db.execute(
      sql`UPDATE posts SET categories = array_replace(categories, ${current.name}, ${name}) WHERE ${current.name} = ANY(categories)`,
    )
    await db.update(schema.categories).set({ name, nameEn, nameRu }).where(eq(schema.categories.id, current.id))
    return { id: current.id, name }
  }

  // id 为空：若同名行已存在（含静态衍生分类首次补译名），只更新译名
  const existing = (await db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(eq(schema.categories.name, name))
    .limit(1))[0]
  if (existing) {
    await db.update(schema.categories).set({ nameEn, nameRu }).where(eq(schema.categories.id, existing.id))
    return { id: existing.id, name }
  }
  const [ins] = await db
    .insert(schema.categories)
    .values({ name, nameEn, nameRu })
    .returning({ id: schema.categories.id, name: schema.categories.name })
  if (!ins) throw new Error('分类创建失败。')
  return ins
}

export async function deleteCategory(id: number): Promise<void> {
  await requireAdmin()
  await ensureSchema()
  const rows = await useDb().select({ name: schema.categories.name }).from(schema.categories).where(eq(schema.categories.id, id)).limit(1)
  if (!rows.length) return
  // 静态文章衍生的分类不可删除（即便已登记行补译名；删除行只会丢译名且与前端门禁矛盾）
  if (listAllStaticCategoryNames().includes(rows[0]!.name)) {
    throw new Error('静态文章内置分类不可删除；删除对应静态文件即可。')
  }
  // 从 DB 文章的分类数组中剔除
  await useDb().execute(sql`UPDATE posts SET categories = array_remove(categories, ${rows[0]!.name}) WHERE ${rows[0]!.name} = ANY(categories)`)
  await useDb().delete(schema.categories).where(eq(schema.categories.id, id))
}

// ============================================================
// 附件（二进制以 base64 存 attachments.content）
// ============================================================
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024 // 4MB

function toPublic(row: {
  id: number
  postSlug: string
  filename: string
  mimeType: string
  sizeBytes: number
  downloads: number
  createdAt: Date | string
  passwordHash: string | null
}): AttachmentPublic {
  return {
    id: row.id,
    postSlug: row.postSlug,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    downloads: row.downloads,
    createdAt: new Date(row.createdAt).toISOString(),
    locked: !!row.passwordHash,
  }
}

export async function listAttachmentsPublic(postSlug: string): Promise<AttachmentPublic[]> {
  // 本地无 DB：附件面板隐藏
  if (!isDbConfigured()) return []
  await ensureSchema()
  const rows = await useDb()
    .select({
      id: schema.attachments.id,
      postSlug: schema.attachments.postSlug,
      filename: schema.attachments.filename,
      mimeType: schema.attachments.mimeType,
      sizeBytes: schema.attachments.sizeBytes,
      downloads: schema.attachments.downloads,
      createdAt: schema.attachments.createdAt,
      passwordHash: schema.attachments.passwordHash,
    })
    .from(schema.attachments)
    .where(eq(schema.attachments.postSlug, postSlug))
    .orderBy(schema.attachments.id)
  return rows.map(toPublic)
}

export async function listAttachmentsAdmin(postSlug?: string): Promise<AttachmentPublic[]> {
  // 读优先：直接 SELECT，表不存在(42P01)才建表重试（稳态零 DDL）。
  // Neon 冷启动偶发查询失败时，额外整体重试一次（冷启动错误第二次通常成功）。
  const query = () => {
    const q = useDb()
      .select({
        id: schema.attachments.id,
        postSlug: schema.attachments.postSlug,
        filename: schema.attachments.filename,
        mimeType: schema.attachments.mimeType,
        sizeBytes: schema.attachments.sizeBytes,
        downloads: schema.attachments.downloads,
        createdAt: schema.attachments.createdAt,
        passwordHash: schema.attachments.passwordHash,
      })
      .from(schema.attachments)
    return (postSlug
      ? q.where(eq(schema.attachments.postSlug, postSlug)).orderBy(schema.attachments.id)
      : q.orderBy(desc(schema.attachments.id)))
  }

  return readWithSchemaFallback(async () => {
    try {
      return (await query()).map(toPublic)
    } catch (e) {
      // Neon 冷启动/瞬时网络错误：等待 600ms 重试一次，避免偶发失败直接抛给仪表盘
      if (isUndefinedTableError(e)) throw e
      await new Promise((r) => setTimeout(r, 600))
      return (await query()).map(toPublic)
    }
  })
}

export async function insertAttachment(params: {
  postSlug: string
  filename: string
  mimeType: string
  sizeBytes: number
  base64Content: string
  password?: string
}): Promise<AttachmentPublic> {
  await requireAdmin()
  await ensureSchema()
  const passwordRow = params.password && params.password.length > 0 ? await hashPassword(params.password) : null
  const [row] = await useDb()
    .insert(schema.attachments)
    .values({
      postSlug: params.postSlug,
      filename: params.filename,
      mimeType: params.mimeType || 'application/octet-stream',
      sizeBytes: params.sizeBytes,
      content: params.base64Content,
      passwordHash: passwordRow?.hash || null,
      passwordSalt: passwordRow?.salt || null,
    })
    .returning({
      id: schema.attachments.id,
      postSlug: schema.attachments.postSlug,
      filename: schema.attachments.filename,
      mimeType: schema.attachments.mimeType,
      sizeBytes: schema.attachments.sizeBytes,
      downloads: schema.attachments.downloads,
      createdAt: schema.attachments.createdAt,
      passwordHash: schema.attachments.passwordHash,
    })
  return toPublic(row!)
}

export async function getAttachmentFullRow(id: number): Promise<{
  id: number
  postSlug: string
  filename: string
  content: string
  mimeType: string
  sizeBytes: number
  passwordHash: string | null
  passwordSalt: string | null
} | null> {
  await ensureSchema()
  const rows = await useDb()
    .select({
      id: schema.attachments.id,
      postSlug: schema.attachments.postSlug,
      filename: schema.attachments.filename,
      content: schema.attachments.content,
      mimeType: schema.attachments.mimeType,
      sizeBytes: schema.attachments.sizeBytes,
      passwordHash: schema.attachments.passwordHash,
      passwordSalt: schema.attachments.passwordSalt,
    })
    .from(schema.attachments)
    .where(eq(schema.attachments.id, id))
    .limit(1)
  return rows[0] || null
}

export async function setAttachmentPassword(id: number, password: string | null): Promise<void> {
  await requireAdmin()
  if (!password || password.trim() === '') {
    await useDb()
      .update(schema.attachments)
      .set({ passwordHash: null, passwordSalt: null })
      .where(eq(schema.attachments.id, id))
    return
  }
  const { salt, hash } = await hashPassword(password)
  await useDb()
    .update(schema.attachments)
    .set({ passwordHash: hash, passwordSalt: salt })
    .where(eq(schema.attachments.id, id))
}

export async function deleteAttachment(id: number): Promise<void> {
  await requireAdmin()
  await ensureSchema()
  await useDb().delete(schema.attachments).where(eq(schema.attachments.id, id))
}

export async function recordDownload(id: number) {
  try {
    await useDb()
      .update(schema.attachments)
      .set({ downloads: sql`${schema.attachments.downloads} + 1` })
      .where(eq(schema.attachments.id, id))
  } catch {
    // 记录下载次数失败不影响下载本身
  }
}

// ============================================================
// 用户系统：资料（个签）/ 警告 / 反馈 / 注销
// ============================================================

export const MAX_SIGNATURE_CHARS = 500
export const MAX_FEEDBACK_BODY_CHARS = 4000
// 昵称：2–20 字符。过长会撑破评论头部、挤压日期与个签，故收紧上限。
export const MAX_DISPLAY_NAME_CHARS = 20

// 内置违禁词兜底表（与 settings.banned_words 合并；不区分大小写、子串匹配）
const DEFAULT_BANNED_WORDS = [
  '赌博', '博彩', '色情', '代开发票', '刷单', '私服', '外挂',
  'fuck', 'shit', 'cunt', 'nigger',
]

export type MyProfileView = {
  userId: string
  email: string
  displayName: string
  signature: string
  signatureUpdatedBy: string | null
  tags: number[]
  fontPref: string
  unreadWarnings: number
  commentsCount: number
  feedbackCount: number
}

export type WarningItem = {
  id: number
  message: string
  issuedBy: string
  readAt: string | null
  createdAt: string
}

export type CommenterAdminView = {
  userId: string
  email: string
  displayName: string
  signature: string
  signatureUpdatedBy: string | null
  tags: number[]
  commentCount: number
  warningCount: number
  createdAt: string | null
}

export type FeedbackAdminItem = {
  id: number
  userId: string
  email: string
  subject: string
  body: string
  status: string
  createdAt: string
  resolvedAt: string | null
  attachments: { id: number; filename: string; mimeType: string; sizeBytes: number }[]
}

/** 读取全部违禁词（内置 + 站点设置），供写操作前校验 */
export async function getBannedWords(): Promise<string[]> {
  try {
    const row = await getSettingsRow()
    const custom = (row.bannedWords || '')
      .split(/[,，、\n\r;；\t]+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 2)
    return [...new Set([...DEFAULT_BANNED_WORDS, ...custom])]
  } catch {
    return DEFAULT_BANNED_WORDS
  }
}

/** 命中违禁词则返回该词（小写），否则 null */
export async function containsBannedWord(text: string): Promise<string | null> {
  const lower = text.toLowerCase()
  for (const word of await getBannedWords()) {
    if (lower.includes(word.toLowerCase())) return word
  }
  return null
}

// ---------- 资料 / 个签 ----------

async function upsertProfile(user: { id: string; email: string; name: string }, displayName?: string) {
  await ensureSchema()
  const name = (displayName ?? user.name ?? '').slice(0, MAX_DISPLAY_NAME_CHARS)
  // 首次插入写入昵称；冲突时只同步邮箱——昵称归 syncDisplayName 单独管理，
  // 不能在这里用登录快照覆盖用户/管理员已改的昵称。
  await useDb()
    .insert(schema.profiles)
    .values({ userId: user.id, email: user.email.toLowerCase(), displayName: name })
    .onConflictDoUpdate({
      target: schema.profiles.userId,
      set: { email: user.email.toLowerCase(), updatedAt: sql`NOW()` },
    })
}

/** 当前用户的资料面板数据（含未读警告数等） */
export async function getMyProfile(): Promise<MyProfileView> {
  const user = await getCurrentUser()
  if (!user?.email) throw new Error('请先登录。')
  await ensureSchema()
  await upsertProfile(user)
  const [profile] = await useDb().select().from(schema.profiles).where(eq(schema.profiles.userId, user.id)).limit(1)
  const [commentAgg] = await useDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.comments)
    .where(and(eq(schema.comments.userId, user.id), eq(schema.comments.status, 'published')))
  const [feedbackAgg] = await useDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.feedback)
    .where(eq(schema.feedback.userId, user.id))
  const [warnAgg] = await useDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.warnings)
    .where(and(eq(schema.warnings.userId, user.id), isNull(schema.warnings.readAt)))
  return {
    userId: user.id,
    email: user.email,
    displayName: profile?.displayName || user.name,
    signature: profile?.signature || '',
    signatureUpdatedBy: profile?.signatureUpdatedBy ?? null,
    tags: parseTagIds(profile?.tags || ''),
    fontPref: profile?.fontPref || '',
    unreadWarnings: warnAgg?.n ?? 0,
    commentsCount: commentAgg?.n ?? 0,
    feedbackCount: feedbackAgg?.n ?? 0,
  }
}

/** 保存本人个签（Markdown；违禁词检测；长度上限） */
export async function saveMySignature(signatureRaw: string): Promise<{ signature: string; updatedBy: string | null }> {
  const user = await getCurrentUser()
  if (!user?.email) throw new Error('请先登录。')
  const signature = signatureRaw.slice(0, MAX_SIGNATURE_CHARS)
  const banned = await containsBannedWord(signature)
  if (banned) throw new Error(`个签包含违禁内容（命中词：${banned}），请修改后重试。`)
  await ensureSchema()
  await upsertProfile(user)
  await useDb()
    .update(schema.profiles)
    .set({ signature, signatureUpdatedBy: null, updatedAt: sql`NOW()` })
    .where(eq(schema.profiles.userId, user.id))
  return { signature, updatedBy: null }
}

/** 合法字体偏好 id 白名单（'' = 网站默认；与 src/lib/font-prefs.ts 保持一致） */
const FONT_PREF_IDS = new Set([
  'zh-sans', 'zh-serif', 'zh-wenkai',
  'zh-smiley', 'zh-kuaile', 'zh-mashan', 'zh-lisu',
  'en-inter', 'en-lora',
  'en-playfair', 'en-syne', 'en-caveat',
  'ru-inter', 'ru-manrope', 'ru-ptserif',
  'ru-yeseva', 'ru-marck',
])

/** 保存本人字体偏好（白名单校验；'' 即取消字体、恢复默认） */
export async function saveMyFontPref(fontPrefRaw: string): Promise<{ fontPref: string }> {
  const user = await getCurrentUser()
  if (!user?.email) throw new Error('请先登录。')
  const fontPref = fontPrefRaw || ''
  if (fontPref && !FONT_PREF_IDS.has(fontPref)) throw new Error('不支持的字体选项。')
  await ensureSchema()
  await upsertProfile(user)
  await useDb()
    .update(schema.profiles)
    .set({ fontPref, updatedAt: sql`NOW()` })
    .where(eq(schema.profiles.userId, user.id))
  return { fontPref }
}

/**
 * 修改昵称：同步 users.displayName、profiles 与全部历史评论署名。
 * 服务端做长度与违禁词校验，并刷新当前请求的用户缓存。
 */
export async function syncDisplayName(displayName?: string): Promise<{ displayName: string; updatedComments: number }> {
  const user = await getCurrentUser()
  if (!user?.email) throw new Error('请先登录。')
  const name = (displayName?.trim() || user.name || '').slice(0, MAX_DISPLAY_NAME_CHARS)
  if (!name) throw new Error('昵称不能为空。')
  const banned = await containsBannedWord(name)
  if (banned) throw new Error(`昵称包含违禁内容（命中词：${banned}）。`)
  await ensureSchema()
  await upsertProfile(user, name)
  // 账户表昵称（getCurrentUser 的权威来源）
  await useDb()
    .update(schema.users)
    .set({ displayName: name })
    .where(eq(schema.users.id, user.id))
  invalidateUserCache(user.id)
  // upsert 冲突时不覆盖昵称，这里显式同步（新插入行本就是该值，幂等）
  await useDb()
    .update(schema.profiles)
    .set({ displayName: name, updatedAt: sql`NOW()` })
    .where(eq(schema.profiles.userId, user.id))
  const updated = await useDb()
    .update(schema.comments)
    .set({ userName: name })
    .where(sql`${schema.comments.userId} = ${user.id} OR LOWER(${schema.comments.userEmail}) = LOWER(${user.email})`)
  return { displayName: name, updatedComments: updated.rowCount ?? 0 }
}

/** 评论列表批量取个签：userId → signature（只取有个签的行） */
export async function getSignatureMap(userIds: string[]): Promise<Record<string, string>> {
  const ids = [...new Set(userIds.filter((id) => id && !id.startsWith('deleted')))]
  if (ids.length === 0) return {}
  await ensureSchema()
  const rows = await useDb()
    .select({ userId: schema.profiles.userId, signature: schema.profiles.signature })
    .from(schema.profiles)
    .where(inArray(schema.profiles.userId, ids))
  const map: Record<string, string> = {}
  for (const r of rows) if (r.signature) map[r.userId] = r.signature
  return map
}

// ---------- 警告 ----------

export async function listMyWarnings(): Promise<WarningItem[]> {
  const user = await getCurrentUser()
  if (!user?.email) throw new Error('请先登录。')
  await ensureSchema()
  const rows = await useDb()
    .select()
    .from(schema.warnings)
    .where(eq(schema.warnings.userId, user.id))
    .orderBy(desc(schema.warnings.createdAt))
    .limit(100)
  return rows.map((r) => ({
    id: r.id,
    message: r.message,
    issuedBy: r.issuedBy,
    readAt: r.readAt ? new Date(r.readAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
  }))
}

export async function markMyWarningsRead(): Promise<{ ok: true }> {
  const user = await getCurrentUser()
  if (!user?.email) throw new Error('请先登录。')
  await useDb()
    .update(schema.warnings)
    .set({ readAt: sql`NOW()` })
    .where(and(eq(schema.warnings.userId, user.id), isNull(schema.warnings.readAt)))
  return { ok: true }
}

// ---------- 反馈 ----------

export async function insertFeedbackAttachment(input: {
  filename: string
  mimeType: string
  sizeBytes: number
  base64Content: string
}): Promise<{ id: number; filename: string; sizeBytes: number }> {
  const user = await getCurrentUser()
  if (!user?.email) throw new Error('请先登录后再上传附件。')
  if (input.sizeBytes === 0) throw new Error('文件为空。')
  if (input.sizeBytes > MAX_ATTACHMENT_BYTES) {
    throw new Error(`附件超过大小上限（${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB）。`)
  }
  // 类型白名单：截图/文档/压缩包
  const allowed = /^(image\/|application\/pdf|application\/zip|text\/|application\/octet-stream)/i
  if (!allowed.test(input.mimeType)) {
    throw new Error('仅支持图片、PDF、文本或压缩包附件。')
  }
  await ensureSchema()
  const [row] = await useDb()
    .insert(schema.feedbackAttachments)
    .values({
      feedbackId: null,
      filename: input.filename.slice(0, 200),
      content: input.base64Content,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      ownerId: user.id,
    })
    .returning({ id: schema.feedbackAttachments.id })
  return { id: row.id, filename: input.filename, sizeBytes: input.sizeBytes }
}

/** 反馈附件下载鉴权：仅附件所属反馈的提交人或管理员可取 */
export async function getFeedbackAttachmentRow(id: number): Promise<{
  filename: string
  mimeType: string
  content: string
  sizeBytes: number
} | null> {
  const user = await getCurrentUser()
  if (!user?.email) throw new Error('请先登录。')
  const [row] = await useDb()
    .select()
    .from(schema.feedbackAttachments)
    .where(eq(schema.feedbackAttachments.id, id))
    .limit(1)
  if (!row) return null
  const status = await getAdminStatus()
  const owner = row.ownerId === user.id
  if (!status.isAdmin && !owner) throw new Error('无权访问该附件。')
  return { filename: row.filename, mimeType: row.mimeType, content: row.content, sizeBytes: row.sizeBytes }
}

/** 移除"已上传但尚未随反馈提交"的附件（仅限本人的孤儿行；已归属反馈的不可删） */
export async function discardFeedbackAttachment(id: number): Promise<{ ok: true }> {
  const user = await getCurrentUser()
  if (!user?.email) throw new Error('请先登录。')
  await ensureSchema()
  await useDb()
    .delete(schema.feedbackAttachments)
    .where(and(
      eq(schema.feedbackAttachments.id, id),
      eq(schema.feedbackAttachments.ownerId, user.id),
      isNull(schema.feedbackAttachments.feedbackId),
    ))
  return { ok: true }
}

export async function submitFeedback(input: { subject: string; body: string; attachmentIds: number[] }): Promise<{ id: number }> {
  const user = await getCurrentUser()
  if (!user?.email) throw new Error('请先登录。')
  const subject = input.subject.trim().slice(0, 120)
  const body = input.body.trim().slice(0, MAX_FEEDBACK_BODY_CHARS)
  if (!subject) throw new Error('请填写反馈标题。')
  if (body.length < 2) throw new Error('请填写反馈内容（至少 2 个字符）。')
  const banned = await containsBannedWord(`${subject}\n${body}`)
  if (banned) throw new Error(`反馈内容包含违禁内容（命中词：${banned}），请修改后重试。`)
  const ids = input.attachmentIds.filter((n) => Number.isInteger(n) && n > 0).slice(0, 6)
  await ensureSchema()
  const [row] = await useDb()
    .insert(schema.feedback)
    .values({ userId: user.id, email: user.email.toLowerCase(), subject, body })
    .returning({ id: schema.feedback.id })
  if (ids.length > 0) {
    // 仅绑定本人上传且尚未归属的附件，防止 IDOR 绑定他人附件
    await useDb()
      .update(schema.feedbackAttachments)
      .set({ feedbackId: row.id })
      .where(and(inArray(schema.feedbackAttachments.id, ids), eq(schema.feedbackAttachments.ownerId, user.id), isNull(schema.feedbackAttachments.feedbackId)))
  }
  return { id: row.id }
}

// ---------- 注销（内容保留 + 身份断联） ----------

export async function anonymizeAccount(): Promise<{
  anonymizedComments: number
  deletedFeedback: number
  accountDeleted: boolean
}> {
  const user = await getCurrentUser()
  if (!user?.email) throw new Error('请先登录。')
  await ensureSchema()
  // 1) 评论内容保留（讨论结构完整），身份信息断联：署名匿名、邮箱清空、归属改为 'deleted'
  const updated = await useDb()
    .update(schema.comments)
    .set({ userName: '已注销用户', userEmail: '', userId: 'deleted' })
    .where(sql`${schema.comments.userId} = ${user.id} OR LOWER(${schema.comments.userEmail}) = LOWER(${user.email})`)
  // 2) 个人资料与警告删除
  await useDb().delete(schema.profiles).where(eq(schema.profiles.userId, user.id))
  await useDb().delete(schema.warnings).where(eq(schema.warnings.userId, user.id))
  // 3) 反馈及其附件、未提交的孤儿附件全部删除
  const fbRows = await useDb().select({ id: schema.feedback.id }).from(schema.feedback).where(eq(schema.feedback.userId, user.id))
  const fbIds = fbRows.map((r) => r.id)
  if (fbIds.length > 0) {
    await useDb().delete(schema.feedbackAttachments).where(inArray(schema.feedbackAttachments.feedbackId, fbIds))
  }
  const deletedFeedback = await useDb().delete(schema.feedback).where(eq(schema.feedback.userId, user.id))
  await useDb().delete(schema.feedbackAttachments).where(eq(schema.feedbackAttachments.ownerId, user.id))

  // 4) 删除自建账户（评论已断联，users 行可以直接删）
  await useDb().delete(schema.users).where(eq(schema.users.id, user.id))
  invalidateUserCache(user.id)
  return { anonymizedComments: updated.rowCount ?? 0, deletedFeedback: deletedFeedback.rowCount ?? 0, accountDeleted: true }
}

// ============================================================
// 管理员：评论者管理 / 警告 / 反馈处理
// ============================================================

export async function adminListCommenters(): Promise<CommenterAdminView[]> {
  await requireAdmin()
  await ensureSchema()
  const agg = await useDb()
    .select({
      userId: schema.comments.userId,
      userName: sql<string>`max(${schema.comments.userName})`,
      email: sql<string>`max(${schema.comments.userEmail})`,
      commentCount: sql<number>`count(*)::int`,
    })
    .from(schema.comments)
    .where(and(eq(schema.comments.status, 'published'), sql`${schema.comments.userId} NOT LIKE 'deleted%'`))
    .groupBy(schema.comments.userId)
  const ids = agg.map((r) => r.userId)
  const profileRows = ids.length
    ? await useDb().select().from(schema.profiles).where(inArray(schema.profiles.userId, ids))
    : []
  const profileMap = new Map(profileRows.map((p) => [p.userId, p]))
  const warnRows = ids.length
    ? await useDb()
        .select({ userId: schema.warnings.userId, n: sql<number>`count(*)::int` })
        .from(schema.warnings)
        .where(inArray(schema.warnings.userId, ids))
        .groupBy(schema.warnings.userId)
    : []
  const warnMap = new Map(warnRows.map((w) => [w.userId, w.n]))
  return agg.map((r) => {
    const p = profileMap.get(r.userId)
    return {
      userId: r.userId,
      email: (p?.email || r.email || '').toLowerCase(),
      displayName: p?.displayName || r.userName,
      signature: p?.signature || '',
      signatureUpdatedBy: p?.signatureUpdatedBy ?? null,
      tags: parseTagIds(p?.tags || ''),
      commentCount: r.commentCount,
      warningCount: warnMap.get(r.userId) ?? 0,
      createdAt: p?.createdAt ? new Date(p.createdAt).toISOString() : null,
    }
  }).sort((a, b) => b.commentCount - a.commentCount)
}

/** 管理员修改/清空他人个签（管理行为不做违禁词拦截——用于处置违规内容） */
export async function adminSetSignature(userId: string, signature: string): Promise<{ signature: string; updatedBy: string }> {
  const admin = await requireAdmin()
  if (!userId || userId.startsWith('deleted')) throw new Error('目标用户不存在。')
  await ensureSchema()
  const sig = signature.slice(0, MAX_SIGNATURE_CHARS)
  // upsert 后再更新：用户可能从未打开过资料面板
  await useDb()
    .insert(schema.profiles)
    .values({ userId, email: '', displayName: '' })
    .onConflictDoNothing({ target: schema.profiles.userId })
  await useDb()
    .update(schema.profiles)
    .set({ signature: sig, signatureUpdatedBy: admin.email, updatedAt: sql`NOW()` })
    .where(eq(schema.profiles.userId, userId))
  return { signature: sig, updatedBy: admin.email }
}

export async function adminIssueWarning(input: { userId: string; message: string }): Promise<{ id: number }> {
  const admin = await requireAdmin()
  const userId = input.userId.trim()
  const message = input.message.trim().slice(0, 500)
  if (!userId || userId.startsWith('deleted')) throw new Error('目标用户不存在。')
  if (message.length < 2) throw new Error('警告内容至少 2 个字符。')
  await ensureSchema()
  // 目标邮箱取资料表或评论表（profiles 可能不存在）
  let email = ''
  const [p] = await useDb().select().from(schema.profiles).where(eq(schema.profiles.userId, userId)).limit(1)
  if (p?.email) email = p.email
  if (!email) {
    const [c] = await useDb().select().from(schema.comments).where(eq(schema.comments.userId, userId)).limit(1)
    email = (c?.userEmail || '').toLowerCase()
  }
  const [row] = await useDb()
    .insert(schema.warnings)
    .values({ userId, email, message, issuedBy: admin.email })
    .returning({ id: schema.warnings.id })
  return { id: row.id }
}

export async function adminListFeedback(): Promise<FeedbackAdminItem[]> {
  await requireAdmin()
  await ensureSchema()
  const rows = await useDb()
    .select()
    .from(schema.feedback)
    .orderBy(desc(schema.feedback.createdAt))
    .limit(200)
  if (rows.length === 0) return []
  const fbIds = rows.map((r) => r.id)
  const atts = await useDb()
    .select()
    .from(schema.feedbackAttachments)
    .where(inArray(schema.feedbackAttachments.feedbackId, fbIds))
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    email: r.email,
    subject: r.subject,
    body: r.body,
    status: r.status,
    createdAt: new Date(r.createdAt).toISOString(),
    resolvedAt: r.resolvedAt ? new Date(r.resolvedAt).toISOString() : null,
    attachments: atts
      .filter((a) => a.feedbackId === r.id)
      .map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes })),
  }))
}

export async function adminSetFeedbackStatus(id: number, status: 'open' | 'resolved' | 'dismissed'): Promise<{ ok: true }> {
  await requireAdmin()
  await useDb()
    .update(schema.feedback)
    .set({ status, resolvedAt: status === 'open' ? null : sql`NOW()` })
    .where(eq(schema.feedback.id, id))
  return { ok: true }
}

/** 反馈附件下载 URL（复用 /api/comments 路由分发） */
export function feedbackFileUrl(id: number) {
  return `/api/comments?action=feedbackFile&id=${encodeURIComponent(id)}`
}

// ============================================================
// 身份标签
// ============================================================

export type UserTag = { id: number; name: string; color: string; effect: 'solid' | 'glow' | 'gradient' | 'outline' }

const TAG_EFFECTS = new Set(['solid', 'glow', 'gradient', 'outline'])

function parseTagIds(raw: string): number[] {
  return raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0)
}

/** 全部标签定义（公开：评论区/用户中心渲染标签时需要） */
export async function listUserTags(): Promise<UserTag[]> {
  await ensureSchema()
  const rows = await useDb().select().from(schema.userTags).orderBy(schema.userTags.id)
  return rows.map((r) => ({ id: r.id, name: r.name, color: r.color, effect: (r.effect as UserTag['effect']) || 'solid' }))
}

export async function createUserTag(input: { name: string; color: string; effect: string }): Promise<UserTag> {
  await requireAdmin()
  await ensureSchema()
  const name = input.name.trim().slice(0, 20)
  if (!name) throw new Error('标签名不能为空。')
  const effect = TAG_EFFECTS.has(input.effect) ? input.effect : 'solid'
  const color = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(input.color) ? input.color : '#7c3aed'
  const [row] = await useDb()
    .insert(schema.userTags)
    .values({ name, color, effect })
    .onConflictDoNothing({ target: schema.userTags.name })
    .returning()
  if (!row) throw new Error('标签名已存在。')
  return { id: row.id, name: row.name, color: row.color, effect: row.effect as UserTag['effect'] }
}

export async function updateUserTag(id: number, input: { name?: string; color?: string; effect?: string }): Promise<UserTag> {
  await requireAdmin()
  await ensureSchema()
  const set: Record<string, unknown> = {}
  if (input.name !== undefined) {
    const name = input.name.trim().slice(0, 20)
    if (!name) throw new Error('标签名不能为空。')
    set.name = name
  }
  if (input.color !== undefined) set.color = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(input.color) ? input.color : '#7c3aed'
  if (input.effect !== undefined) set.effect = TAG_EFFECTS.has(input.effect) ? input.effect : 'solid'
  if (Object.keys(set).length === 0) throw new Error('没有需要更新的字段。')
  const [row] = await useDb().update(schema.userTags).set(set).where(eq(schema.userTags.id, id)).returning()
  if (!row) throw new Error('标签不存在。')
  return { id: row.id, name: row.name, color: row.color, effect: row.effect as UserTag['effect'] }
}

export async function deleteUserTag(id: number): Promise<{ ok: true }> {
  await requireAdmin()
  await ensureSchema()
  await useDb().delete(schema.userTags).where(eq(schema.userTags.id, id))
  // 同步清理所有用户资料中对该标签的引用
  const all = await useDb().select({ userId: schema.profiles.userId, tags: schema.profiles.tags }).from(schema.profiles)
  for (const p of all) {
    const ids = parseTagIds(p.tags).filter((t) => t !== id)
    await useDb().update(schema.profiles).set({ tags: ids.join(',') }).where(eq(schema.profiles.userId, p.userId))
  }
  return { ok: true }
}

/** 给用户设置标签（覆盖式；tagIds 为空表示清空） */
export async function setUserTags(userId: string, tagIds: number[]): Promise<{ tags: number[] }> {
  await requireAdmin()
  if (!userId || userId.startsWith('deleted')) throw new Error('目标用户不存在。')
  await ensureSchema()
  const valid = Array.from(new Set(tagIds.filter((n) => Number.isFinite(n) && n > 0)))
  await useDb()
    .insert(schema.profiles)
    .values({ userId, email: '', displayName: '' })
    .onConflictDoNothing({ target: schema.profiles.userId })
  await useDb()
    .update(schema.profiles)
    .set({ tags: valid.join(','), updatedAt: sql`NOW()` })
    .where(eq(schema.profiles.userId, userId))
  return { tags: valid }
}

/** 批量取用户的标签 id 列表（评论注入用） */
export async function getTagsMap(userIds: string[]): Promise<Record<string, number[]>> {
  if (userIds.length === 0) return {}
  await ensureSchema()
  const rows = await useDb()
    .select({ userId: schema.profiles.userId, tags: schema.profiles.tags })
    .from(schema.profiles)
    .where(inArray(schema.profiles.userId, userIds))
  const map: Record<string, number[]> = {}
  for (const r of rows) map[r.userId] = parseTagIds(r.tags)
  return map
}

// ============================================================
// 个人评论管理 / 管理员评论搜索
// ============================================================

export type UserComment = {
  id: number
  postSlug: string
  postTitle: string
  body: string
  createdAt: string
  editedAt: string | null
  status: string
  userName: string
  userId: string
}

/** 批量取文章标题（静态 + 数据库） */
async function getPostTitleMap(slugs: string[]): Promise<Record<string, string>> {
  const map: Record<string, string> = {}
  if (slugs.length === 0) return map
  const all = await listPublishedPosts()
  for (const p of all) map[p.slug] = p.title
  return map
}

/** 当前用户的评论列表（不含个签；支持关键词搜正文） */
export async function listMyComments(keyword = ''): Promise<UserComment[]> {
  const user = await getCurrentUser()
  if (!user?.email) throw new Error('请先登录。')
  await ensureSchema()
  const kw = keyword.trim()
  const conds = [eq(schema.comments.userId, user.id), eq(schema.comments.status, 'published')]
  if (kw) conds.push(ilike(schema.comments.body, `%${kw}%`))
  const rows = await useDb()
    .select()
    .from(schema.comments)
    .where(and(...conds))
    .orderBy(desc(schema.comments.createdAt))
    .limit(200)
  const titleMap = await getPostTitleMap(rows.map((r) => r.postSlug))
  return rows.map((r) => ({
    id: r.id,
    postSlug: r.postSlug,
    postTitle: titleMap[r.postSlug] || r.postSlug,
    body: r.body,
    createdAt: new Date(r.createdAt).toISOString(),
    editedAt: r.editedAt ? new Date(r.editedAt).toISOString() : null,
    status: r.status,
    userName: r.userName,
    userId: r.userId,
  }))
}

/** 管理员评论搜索：scope=mine|all|user；普通用户仅 mine */
export async function adminListComments(input: {
  scope: 'mine' | 'all' | 'user'
  userId?: string
  keyword?: string
}): Promise<UserComment[]> {
  const admin = await requireAdmin()
  await ensureSchema()
  const kw = (input.keyword || '').trim()
  const conds = [eq(schema.comments.status, 'published')]
  if (input.scope === 'mine') conds.push(eq(schema.comments.userId, admin.id))
  else if (input.scope === 'user' && input.userId) conds.push(eq(schema.comments.userId, input.userId))
  if (kw) conds.push(ilike(schema.comments.body, `%${kw}%`))
  const rows = await useDb()
    .select()
    .from(schema.comments)
    .where(and(...conds))
    .orderBy(desc(schema.comments.createdAt))
    .limit(300)
  const titleMap = await getPostTitleMap(rows.map((r) => r.postSlug))
  return rows.map((r) => ({
    id: r.id,
    postSlug: r.postSlug,
    postTitle: titleMap[r.postSlug] || r.postSlug,
    body: r.body,
    createdAt: new Date(r.createdAt).toISOString(),
    editedAt: r.editedAt ? new Date(r.editedAt).toISOString() : null,
    status: r.status,
    userName: r.userName,
    userId: r.userId,
  }))
}

// ============================================================
// 站点内容块：网站简介(about) / 友情链接(links)，三语 Markdown
// ============================================================

export const SITE_CONTENT_KEYS = ['about', 'links'] as const
export type SiteContentKey = (typeof SITE_CONTENT_KEYS)[number]
export const SITE_CONTENT_LANGS = ['zh', 'en', 'ru'] as const
export type SiteContentLang = (typeof SITE_CONTENT_LANGS)[number]

export type SiteContentRow = { key: string; lang: string; body: string; updatedAt: string | null }

/** 读取全部站点内容块（公开；不存在的块返回空串） */
export async function listSiteContent(): Promise<SiteContentRow[]> {
  await ensureSchema()
  const rows = await useDb().select().from(schema.siteContent)
  return rows.map((r) => ({
    key: r.key,
    lang: r.lang,
    body: r.body || '',
    updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
  }))
}

/** 保存单个内容块（管理员；键/语言白名单；长度上限；upsert） */
export async function saveSiteContent(input: {
  key: string
  lang: string
  body: string
}): Promise<{ key: string; lang: string; body: string }> {
  await requireAdmin()
  if (!SITE_CONTENT_KEYS.includes(input.key as SiteContentKey)) throw new Error('不支持的内容块。')
  if (!SITE_CONTENT_LANGS.includes(input.lang as SiteContentLang)) throw new Error('不支持的语言。')
  const body = (input.body || '').slice(0, 20000)
  await ensureSchema()
  await useDb()
    .insert(schema.siteContent)
    .values({ key: input.key, lang: input.lang, body, updatedAt: sql`NOW()` })
    .onConflictDoUpdate({
      target: [schema.siteContent.key, schema.siteContent.lang],
      set: { body, updatedAt: sql`NOW()` },
    })
  return { key: input.key, lang: input.lang, body }
}

