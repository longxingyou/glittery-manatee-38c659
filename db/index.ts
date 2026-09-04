import { drizzle } from 'drizzle-orm/netlify-db'
import { desc, eq, sql, and, ne } from 'drizzle-orm'
import { getUser } from '@netlify/identity'
import { allPosts } from 'content-collections'

import * as schema from './schema.js'
import {
  DEFAULT_SITE_DESCRIPTION,
  DEFAULT_SITE_TITLE,
  type AdminSettings,
  type AdminStatus,
  type AttachmentPublic,
  type CategoryInfo,
  type PostData,
  type PostStatus,
  type SiteSettings,
} from '../src/lib/utils.js'

export const db = drizzle({ schema })

// ============================================================
// 运行时幂等建表（绕开 drizzle-kit migrate 受 NTFS ACL 限制的问题）
// ============================================================
let ensured: Promise<void> | null = null
export function ensureSchema(): Promise<void> {
  if (ensured) return ensured
  ensured = (async () => {
    try {
      const statements = [
        sql`CREATE TABLE IF NOT EXISTS comments (
          id SERIAL PRIMARY KEY,
          post_slug TEXT NOT NULL,
          user_id TEXT NOT NULL,
          user_name TEXT NOT NULL,
          user_email TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          edited_at TIMESTAMPTZ,
          status TEXT NOT NULL DEFAULT 'published',
          likes INTEGER NOT NULL DEFAULT 0
        )`,
        sql`CREATE INDEX IF NOT EXISTS comments_post_slug_idx ON comments (post_slug, created_at)`,
        sql`CREATE TABLE IF NOT EXISTS posts (
          id SERIAL PRIMARY KEY,
          slug TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL DEFAULT '',
          categories TEXT[] NOT NULL DEFAULT '{}'::text[],
          status TEXT NOT NULL DEFAULT 'draft',
          date TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ
        )`,
        sql`CREATE INDEX IF NOT EXISTS posts_date_idx ON posts (date)`,
        sql`CREATE TABLE IF NOT EXISTS categories (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
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
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
        sql`INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
      ]
      for (const s of statements) await db.execute(s)
    } catch (e) {
      ensured = null
      throw e
    }
  })()
  return ensured
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
  const p = pad + '='.padStart((4 - (pad.length % 4)) % 4, '=')
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
      { name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 120_000, hash: 'SHA-256' },
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
      { name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 120_000, hash: 'SHA-256' },
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
// ============================================================
async function getSettingsRow() {
  await ensureSchema()
  const rows = await db.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1)
  if (rows.length) return rows[0]!
  await db.insert(schema.settings).values({ id: 1 }).onConflictDoNothing()
  return (await db.select().from(schema.settings).where(eq(schema.settings.id, 1)).limit(1))[0]!
}

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
  }
}

export async function saveAdminSettings(input: AdminSettings) {
  await requireAdmin()
  const trimmedTitle = input.siteTitle.trim().slice(0, 120)
  const trimmedDesc = input.siteDescription.trim().slice(0, 500)
  await db
    .insert(schema.settings)
    .values({
      id: 1,
      siteTitle: trimmedTitle || null,
      siteDescription: trimmedDesc || null,
      customCss: input.customCss.slice(0, 100_000) || null,
      adminEmails: input.adminEmails.trim().slice(0, 2000) || null,
      updatedAt: sql`NOW()`,
    })
    .onConflictDoUpdate({
      target: schema.settings.id,
      set: {
        siteTitle: trimmedTitle || null,
        siteDescription: trimmedDesc || null,
        customCss: input.customCss.slice(0, 100_000) || null,
        adminEmails: input.adminEmails.trim().slice(0, 2000) || null,
        updatedAt: sql`NOW()`,
      },
    })
  return getAdminSettings()
}

export async function getTokenSecret(): Promise<string> {
  const row = await getSettingsRow()
  if (row.tokenSecret) return row.tokenSecret
  const secret = randomHex(32)
  await db
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
  const env = parseEmails(process.env.ADMIN_EMAILS || '')
  const settingsRow = parseEmails(
    // settings 的读取是异步的；此处只把 env 部分立即返回，settings 部分会合并到 getAdminStatus 中
    '',
  )
  return [...new Set([...env, ...settingsRow])]
}

export async function getAdminStatus(): Promise<AdminStatus> {
  const user = await getUser().catch(() => null)
  const settingsRow = await getSettingsRow()
  const settingsEmails = parseEmails(settingsRow.adminEmails || '')
  const envEmails = parseEmails(process.env.ADMIN_EMAILS || '')
  const all = [...new Set([...envEmails, ...settingsEmails])]
  const email = user?.email || null
  const isAdmin = !!email && all.includes(email.toLowerCase())
  return {
    authed: !!email,
    email,
    isAdmin,
    adminConfigured: all.length > 0,
  }
}

export async function requireAdmin() {
  const user = await getUser().catch(() => null)
  if (!user?.email) throw new Error('请先使用 Netlify Identity 登录。')
  const settingsRow = await getSettingsRow()
  const all = new Set([
    ...parseEmails(process.env.ADMIN_EMAILS || ''),
    ...parseEmails(settingsRow.adminEmails || ''),
  ])
  if (!all.has(user.email.toLowerCase())) {
    throw new Error(`当前邮箱 ${user.email} 不在管理员名单内。`)
  }
  return { id: user.id, email: user.email, name: user.name || '' }
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
  }
}

export async function listDbPosts(includeDrafts = true): Promise<PostData[]> {
  await ensureSchema()
  const rows = await (includeDrafts
    ? db.select().from(schema.posts).orderBy(desc(schema.posts.date), desc(schema.posts.id))
    : db
        .select()
        .from(schema.posts)
        .where(eq(schema.posts.status, 'published'))
        .orderBy(desc(schema.posts.date), desc(schema.posts.id)))
  return rows.map(mapDbPost)
}

export async function listPublishedPosts(): Promise<PostData[]> {
  const dbPosts = await listDbPosts(false)
  const seen = new Set(dbPosts.map((p) => p.slug))
  const merged = [
    ...dbPosts,
    ...allPosts.filter((p) => !seen.has(p.slug)).map(mapStaticPost),
  ]
  merged.sort((a, b) => b.date.localeCompare(a.date))
  return merged
}

export async function getPublishedPost(slug: string): Promise<PostData | null> {
  const published = await listPublishedPosts()
  return published.find((p) => p.slug === slug) || null
}

export async function getDbPostById(id: number): Promise<PostData | null> {
  await ensureSchema()
  const rows = await db.select().from(schema.posts).where(eq(schema.posts.id, id)).limit(1)
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

  // 静态文章 slug 不可占用
  if (staticSlugs().has(slug) && !input.id) {
    throw new Error(`该路径「${slug}」已被静态文章占用，请换一个。`)
  }

  // slug 唯一性校验（DB 层面）
  const conflict = await db
    .select({ id: schema.posts.id })
    .from(schema.posts)
    .where(and(eq(schema.posts.slug, slug), input.id ? ne(schema.posts.id, input.id) : undefined))
    .limit(1)
  if (conflict.length) throw new Error(`路径「${slug}」已存在，请换一个。`)

  // 自动登记分类到 categories 表
  for (const name of categories) {
    if (name.length > 40) throw new Error(`分类名「${name}」过长（≤40 字符）。`)
    await db.insert(schema.categories).values({ name }).onConflictDoNothing()
  }

  if (input.id) {
    await db
      .update(schema.posts)
      .set({
        slug,
        title,
        summary: input.summary.slice(0, 1000),
        content: input.content,
        categories,
        status: input.status,
        date: input.date,
        updatedAt: sql`NOW()`,
      })
      .where(eq(schema.posts.id, input.id))
    return { id: input.id, slug }
  }
  const [ins] = await db
    .insert(schema.posts)
    .values({
      slug,
      title,
      summary: input.summary.slice(0, 1000),
      content: input.content,
      categories,
      status: input.status,
      date: input.date,
    })
    .returning({ id: schema.posts.id, slug: schema.posts.slug })
  return { id: ins.id, slug: ins.slug }
}

export async function deletePost(id: number): Promise<void> {
  await requireAdmin()
  await ensureSchema()
  const rows = await db.select({ postSlug: schema.posts.slug }).from(schema.posts).where(eq(schema.posts.id, id)).limit(1)
  if (!rows.length) return
  // 删除附件
  const atts = await db
    .select({ id: schema.attachments.id })
    .from(schema.attachments)
    .where(eq(schema.attachments.postSlug, rows[0]!.postSlug))
  for (const a of atts) await db.delete(schema.attachments).where(eq(schema.attachments.id, a.id))
  await db.delete(schema.posts).where(eq(schema.posts.id, id))
}

// ============================================================
// 分类
// ============================================================
export function listAllStaticCategoryNames(): string[] {
  const names = allPosts.flatMap((p: { categories: string[] }) => p.categories as string[]) as string[]
  return Array.from(new Set(names)).sort()
}

export async function listCategoryInfo(): Promise<CategoryInfo[]> {
  await ensureSchema()
  const dbCountBy = new Map<string, number>()
  const dbRows = await db
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
  const categoryRows = await db.select({ id: schema.categories.id, name: schema.categories.name }).from(schema.categories)
  const idBy = new Map(categoryRows.map((r) => [r.name, r.id]))
  const allNames = Array.from(new Set([...categoryRows.map((r) => r.name), ...listAllStaticCategoryNames()])).sort()
  return allNames.map((name) => ({
    id: idBy.get(name) || 0,
    name,
    dbCount: dbCountBy.get(name) || 0,
    staticCount: staticCountBy.get(name) || 0,
    // 只有静态文件衍生、且 categories 表中没记录的才是 builtin（不可删）
    builtin: !idBy.has(name) && staticCountBy.has(name),
  }))
}

export async function createCategory(name: string): Promise<{ id: number; name: string }> {
  await requireAdmin()
  const trimmed = name.trim()
  if (!trimmed) throw new Error('分类名不能为空。')
  if (trimmed.length > 40) throw new Error('分类名长度需 ≤ 40 字符。')
  await ensureSchema()
  await db.insert(schema.categories).values({ name: trimmed }).onConflictDoNothing()
  const row = (await db.select({ id: schema.categories.id, name: schema.categories.name }).from(schema.categories).where(eq(schema.categories.name, trimmed)).limit(1))[0]
  if (!row) throw new Error('分类创建失败。')
  return row
}

export async function deleteCategory(id: number): Promise<void> {
  await requireAdmin()
  await ensureSchema()
  const rows = await db.select({ name: schema.categories.name }).from(schema.categories).where(eq(schema.categories.id, id)).limit(1)
  if (!rows.length) return
  // 从 DB 文章的分类数组中剔除
  await db.execute(sql`UPDATE posts SET categories = array_remove(categories, ${rows[0]!.name}) WHERE ${rows[0]!.name} = ANY(categories)`)
  await db.delete(schema.categories).where(eq(schema.categories.id, id))
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
  await ensureSchema()
  const rows = await db
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
  await requireAdmin()
  await ensureSchema()
  const rows = postSlug
    ? await db
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
    : await db
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
        .orderBy(desc(schema.attachments.id))
  return rows.map(toPublic)
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
  const [row] = await db
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
  const rows = await db
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
    await db
      .update(schema.attachments)
      .set({ passwordHash: null, passwordSalt: null })
      .where(eq(schema.attachments.id, id))
    return
  }
  const { salt, hash } = await hashPassword(password)
  await db
    .update(schema.attachments)
    .set({ passwordHash: hash, passwordSalt: salt })
    .where(eq(schema.attachments.id, id))
}

export async function deleteAttachment(id: number): Promise<void> {
  await requireAdmin()
  await ensureSchema()
  await db.delete(schema.attachments).where(eq(schema.attachments.id, id))
}

export async function recordDownload(id: number) {
  try {
    await db
      .update(schema.attachments)
      .set({ downloads: sql`${schema.attachments.downloads} + 1` })
      .where(eq(schema.attachments.id, id))
  } catch {
    // 记录下载次数失败不影响下载本身
  }
}
