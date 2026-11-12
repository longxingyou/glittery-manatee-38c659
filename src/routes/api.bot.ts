import { createFileRoute } from '@tanstack/react-router'
import { and, asc, desc, eq, gt, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'

import * as dbApi from '../../db/index.js'
import { attachments, comments, users } from '../../db/schema.js'
import { getEnv } from '../lib/server-env.js'
import { safeKvDelete } from '../lib/cache.js'
import { BOT_MANIFEST } from '../lib/bot-manifest.js'

// ──────────────────────────────────────────────
// /api/bot：给站外自动化（QQ bot）用的管理接口。
//
// 为什么是 REST 而不是 MCP：只有一个调用方，MCP 会多出一层协议、一份客户端和
// 一套鉴权，收益为零。这里复用站内已有逻辑（savePost / 违禁词 / 缓存失效），
// 只补「没有浏览器 cookie 的身份」这一层。
//
// 鉴权两道关：
//   ① Authorization: Bearer <BOT_TOKEN>（Worker secret，未配置则整条路由 503）；
//   ② 请求最终以 BOT_EMAIL 账号落库，该邮箱必须同时出现在 ADMIN_EMAILS 里。
// 令牌泄露但邮箱不在管理员名单 → 只能读，不能写。
//
// 发布策略：posts.create / posts.update 永远写草稿，上线必须单独调 posts.publish。
// 这样即使 prompt 被注入，也无法一步「写内容 + 直接对外」。
// ──────────────────────────────────────────────

const DEFAULT_BOT_EMAIL = 'qqbot@syntaxgarden.local'
// 附件走 base64 直传：4MB 原文约 5.4MB，留出余量
const MAX_BODY_BYTES = 8 * 1024 * 1024

/**
 * 默认只开放「只读 + 建草稿」。发布、下架、删除、设置修改、用户处置等写操作
 * 一律 403——闸门放在服务端，而不是靠调用方自觉。需要扩权时显式配置
 * BOT_ALLOWED_ACTIONS（逗号分隔）覆盖本默认值。
 */
const DEFAULT_ALLOWED_ACTIONS = [
  'ping',
  'help',
  'posts.list',
  'posts.get',
  'posts.search',
  'posts.create',
  'comments.list',
  'categories.list',
  'feedback.list',
  'settings.get',
]

function allowedActions(): Set<string> {
  const raw = getEnv().BOT_ALLOWED_ACTIONS
  const list = raw
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_ACTIONS
  return new Set(list)
}

class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } })

/** 定时安全比较：先各自 SHA-256 再逐字节异或，避免按字节提前返回泄露前缀 */
async function tokenEquals(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder()
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ])
  const va = new Uint8Array(ha)
  const vb = new Uint8Array(hb)
  let diff = 0
  for (let i = 0; i < va.length; i++) diff |= (va[i] ?? 0) ^ (vb[i] ?? 0)
  return diff === 0
}

async function authenticate(request: Request): Promise<void> {
  const expected = getEnv().BOT_TOKEN
  if (!expected) throw new HttpError('站点未配置 BOT_TOKEN，/api/bot 已关闭。', 503)
  const raw = (request.headers.get('authorization') || '').trim()
  const got = /^Bearer\s+(.+)$/i.exec(raw)?.[1]?.trim()
  if (!got) throw new HttpError('缺少 Authorization: Bearer <token>。', 401)
  if (!(await tokenEquals(got, expected))) throw new HttpError('令牌无效。', 403)
}

type BotUser = { id: string; email: string; name: string }

/**
 * 解析 BOT_EMAIL 对应的站点账号；不存在则创建（随机密码，不对外公开，
 * 该账号只用于承载 bot 的操作痕迹，不用于网页登录）。
 */
async function getBotUser(): Promise<BotUser> {
  const env = getEnv()
  const email = (env.BOT_EMAIL || DEFAULT_BOT_EMAIL).trim().toLowerCase()
  const name = (env.BOT_NAME || email.split('@')[0] || 'bot').trim().slice(0, 40)

  const [found] = await dbApi.useDb().select().from(users).where(eq(users.email, email)).limit(1)
  if (found) {
    if (!found.confirmedAt) throw new HttpError(`bot 账号 ${email} 尚未完成邮箱验证。`, 409)
    return { id: found.id, email: found.email, name: found.displayName || name }
  }

  const password = dbApi.randomHex(24)
  const { salt, hash } = await dbApi.hashPassword(password)
  const id = dbApi.randomHex(16)
  await dbApi.useDb().insert(users).values({
    id,
    email,
    passwordHash: hash,
    passwordSalt: salt,
    displayName: name,
    confirmedAt: new Date(),
  })
  return { id, email, name }
}

/** 评论写操作后清 KV 列表缓存（其他 isolate 的进程内缓存最多再陈旧 60s） */
function invalidateCommentCache(postSlug: string) {
  void safeKvDelete(getEnv().SG_CACHE, `comments:${postSlug}`)
}

async function getCommentRow(id: number) {
  const [row] = await dbApi.useDb().select().from(comments).where(eq(comments.id, id)).limit(1)
  return row ?? null
}

const postRef = z.object({
  id: z.number().int().positive().optional(),
  slug: z.string().min(1).max(160).optional(),
})

async function resolvePost(ref: { id?: number; slug?: string }) {
  if (ref.id == null && !ref.slug) throw new HttpError('需要提供 id 或 slug。', 400)
  const post = ref.id != null
    ? await dbApi.getDbPostById(ref.id)
    : await dbApi.getDbPostBySlug(ref.slug!)
  // 只认库内文章：content/posts 下的静态 Markdown 属于仓库文件，改它要重新构建
  if (!post || post.id == null) throw new HttpError('文章不存在（静态 Markdown 文章不走此接口）。', 404)
  return { ...post, id: post.id }
}

const commentBody = z.string().trim().min(2).max(4000)

/** 评论：列表 */
async function commentsList(body: Record<string, unknown>) {
  const p = z.object({
    postSlug: z.string().max(160).optional(),
    status: z.enum(['published', 'deleted']).optional(),
    afterId: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).safeParse(body)
  if (!p.success) throw new HttpError('参数不合法。', 400)
  const { postSlug, status, afterId, limit = 30 } = p.data

  const where: SQL[] = []
  if (postSlug) where.push(eq(comments.postSlug, postSlug))
  if (status) where.push(eq(comments.status, status))
  if (afterId) where.push(gt(comments.id, afterId))

  const rows = await dbApi.useDb()
    .select({
      id: comments.id,
      postSlug: comments.postSlug,
      parentId: comments.parentId,
      userName: comments.userName,
      body: comments.body,
      status: comments.status,
      createdAt: comments.createdAt,
    })
    .from(comments)
    .where(where.length ? and(...where) : undefined)
    // 带 afterId 时按 id 升序，调用方拿最后一条的 id 作为下一次游标即可真增量
    .orderBy(afterId ? asc(comments.id) : desc(comments.id))
    .limit(limit)

  return {
    ok: true,
    comments: rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt).toISOString() })),
    nextAfterId: rows.length ? rows[rows.length - 1]!.id : afterId ?? null,
  }
}

/** 评论：回复（id 指向被回复评论）或新开顶层（postSlug + body） */
async function commentsReply(body: Record<string, unknown>, bot: BotUser) {
  const p = z.object({
    id: z.number().int().positive().optional(),
    postSlug: z.string().max(160).optional(),
    body: commentBody,
    parentId: z.number().int().positive().nullish(),
  }).safeParse(body)
  if (!p.success) throw new HttpError('评论需为 2–4000 个字符。', 422)
  const { id, postSlug, body: text } = p.data

  let targetSlug = postSlug ?? ''
  let parentId: number | null = p.data.parentId ?? null

  if (id != null) {
    const target = await getCommentRow(id)
    if (!target) throw new HttpError('回复目标不存在。', 404)
    if (target.status !== 'published') throw new HttpError('回复目标已被删除。', 400)
    targetSlug = target.postSlug
    // 站点只支持一层回复：回复「回复」时挂到它所属的顶层评论上
    parentId = target.parentId == null ? target.id : target.parentId
  } else {
    if (!targetSlug) throw new HttpError('需要提供 id（回复某条）或 postSlug（新开评论）。', 400)
    const post = await dbApi.getPublishedPost(targetSlug)
    if (!post) throw new HttpError('文章不存在或未发布。', 404)
  }

  if (parentId != null) {
    const parent = await getCommentRow(parentId)
    if (!parent || parent.postSlug !== targetSlug || parent.status !== 'published' || parent.parentId != null) {
      throw new HttpError('回复目标不存在或不可回复。', 400)
    }
  }

  const banned = await dbApi.containsBannedWord(text)
  if (banned) throw new HttpError(`内容命中违禁词（${banned}）。`, 422)

  const [created] = await dbApi.useDb()
    .insert(comments)
    .values({
      postSlug: targetSlug,
      body: text,
      parentId,
      userId: bot.id,
      userEmail: bot.email,
      userName: bot.name,
    })
    .returning()

  invalidateCommentCache(targetSlug)
  return {
    ok: true,
    comment: {
      id: created!.id,
      postSlug: created!.postSlug,
      parentId: created!.parentId,
      userName: created!.userName,
      body: created!.body,
      status: created!.status,
      createdAt: new Date(created!.createdAt).toISOString(),
    },
  }
}

/** 评论：软删（cascade=true 连带删除其下回复） */
async function commentsHide(body: Record<string, unknown>) {
  const p = z.object({
    id: z.number().int().positive(),
    cascade: z.boolean().optional(),
  }).safeParse(body)
  if (!p.success) throw new HttpError('评论标识不合法。', 400)
  const { id, cascade } = p.data

  const row = await getCommentRow(id)
  if (!row) throw new HttpError('评论不存在。', 404)

  if (cascade) {
    await dbApi.useDb()
      .update(comments)
      .set({ status: 'deleted' })
      .where(and(eq(comments.parentId, id), eq(comments.status, 'published')))
  }
  await dbApi.useDb().update(comments).set({ status: 'deleted' }).where(eq(comments.id, id))
  invalidateCommentCache(row.postSlug)
  return { ok: true, id, postSlug: row.postSlug }
}

function todayInShanghai(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
}

const postFields = {
  slug: z.string().min(1).max(160).optional(),
  title: z.string().min(1).max(300).optional(),
  summary: z.string().max(1000).optional(),
  content: z.string().optional(),
  categories: z.array(z.string().max(60)).max(20).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  language: z.enum(['zh', 'en', 'ru']).optional(),
  translationKey: z.string().max(160).nullish(),
  downloadable: z.boolean().optional(),
}

/** 文章：列表（不含正文；带评论数，支持 keyword / offset 分页） */
async function postsList(body: Record<string, unknown>) {
  const p = z.object({
    status: z.enum(['draft', 'published', 'all']).optional(),
    keyword: z.string().max(100).optional(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }).safeParse(body)
  if (!p.success) throw new HttpError('参数不合法。', 400)
  const { status = 'all', keyword, offset = 0, limit = 50 } = p.data
  const kw = keyword?.trim().toLowerCase()

  const commentsCount = (async () => {
    try {
      return await dbApi.useDb()
        .select({ postSlug: comments.postSlug, n: sql<number>`count(*)::int` })
        .from(comments)
        .where(eq(comments.status, 'published'))
        .groupBy(comments.postSlug)
    } catch {
      return [] as { postSlug: string; n: number }[]
    }
  })()
  const [all, counts] = await Promise.all([dbApi.listDbPosts(true, false), commentsCount])
  const countOf = new Map<string, number>()
  for (const c of counts) countOf.set(c.postSlug, c.n)

  const matched = all.filter((x) => {
    if (status !== 'all' && x.status !== status) return false
    if (!kw) return true
    return [x.slug, x.title, x.summary, ...(x.categories ?? [])]
      .join(' ')
      .toLowerCase()
      .includes(kw)
  })

  const rows = matched.slice(offset, offset + limit).map((x) => ({
    id: x.id,
    slug: x.slug,
    title: x.title,
    summary: x.summary,
    status: x.status,
    date: x.date,
    categories: x.categories,
    language: x.language,
    commentCount: countOf.get(x.slug) ?? 0,
  }))
  return { ok: true, total: matched.length, offset, posts: rows }
}

/** 从 Markdown 源提取标题大纲（跳过围栏代码块，行号从 1 开始） */
function markdownHeadings(md: string): { level: number; text: string; line: number }[] {
  const out: { level: number; text: string; line: number }[] = []
  let fence = false
  md.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence
      return
    }
    if (fence) return
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (m) out.push({ level: m[1]!.length, text: m[2]!, line: i + 1 })
  })
  return out
}

/** 文章：详情（含完整 Markdown 源与带行号的标题大纲） */
async function postsGet(body: Record<string, unknown>) {
  const p = postRef.safeParse(body)
  if (!p.success) throw new HttpError('参数不合法。', 400)
  const post = await resolvePost(p.data)
  return { ok: true, post: { ...post, headings: markdownHeadings(post.content || '') } }
}

/** 文章：全文检索（返回命中行上下文，供长文定位） */
async function postsSearch(body: Record<string, unknown>) {
  const p = z.object({
    q: z.string().trim().min(1).max(100),
    limit: z.number().int().min(1).max(50).optional(),
  }).safeParse(body)
  if (!p.success) throw new HttpError('q 必填，且不超过 100 字。', 400)
  const q = p.data.q.toLowerCase()
  const limit = p.data.limit ?? 20

  const [dbRows, published] = await Promise.all([
    dbApi.listDbPosts(true, true).catch(() => []),
    dbApi.listPublishedPostsDetailed(15_000, true)
      .then((r) => r.posts)
      .catch(() => []),
  ])
  // 静态文章先入表，库内文章覆盖同 slug（库里是最新稿，且含草稿）
  const bySlug = new Map<string, (typeof published)[number]>()
  for (const post of published) bySlug.set(post.slug, post)
  for (const post of dbRows) bySlug.set(post.slug, post)

  const results: {
    slug: string
    title: string
    status: string
    date: string
    matches: { line: number; text: string }[]
  }[] = []

  for (const post of bySlug.values()) {
    const lines = (post.content || '').split(/\r?\n/)
    const matches: { line: number; text: string }[] = []
    for (let i = 0; i < lines.length && matches.length < 3; i++) {
      const line = lines[i]
      if (!line || !line.toLowerCase().includes(q)) continue
      matches.push({ line: i + 1, text: line.trim().slice(0, 200) })
    }
    const titleHit = `${post.title} ${post.summary || ''}`.toLowerCase().includes(q)
    if (!matches.length && !titleHit) continue
    results.push({ slug: post.slug, title: post.title, status: post.status, date: post.date, matches })
  }

  results.sort(
    (a, b) =>
      Number(b.matches.length > 0) - Number(a.matches.length > 0) ||
      (b.date || '').localeCompare(a.date || ''),
  )
  return { ok: true, total: results.length, results: results.slice(0, limit) }
}

/** 文章：新建（强制草稿） */
async function postsCreate(body: Record<string, unknown>, bot: BotUser) {
  const p = z.object({
    slug: z.string().min(1).max(160),
    title: z.string().min(1).max(300),
    content: z.string().min(1),
    summary: z.string().max(1000).optional(),
    categories: z.array(z.string().max(60)).max(20).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    language: z.enum(['zh', 'en', 'ru']).optional(),
    translationKey: z.string().max(160).nullish(),
    downloadable: z.boolean().optional(),
  }).safeParse(body)
  if (!p.success) throw new HttpError('slug / title / content 为必填。', 400)
  const d = p.data

  const saved = await dbApi.savePost({
    slug: d.slug,
    title: d.title,
    summary: d.summary ?? '',
    content: d.content,
    categories: d.categories ?? [],
    // 固定草稿：上线必须显式调 posts.publish
    status: 'draft',
    date: d.date ?? todayInShanghai(),
    language: d.language ?? 'zh',
    translationKey: d.translationKey ?? null,
    downloadable: d.downloadable ?? false,
  }, bot.email)

  return { ok: true, id: saved.id, slug: saved.slug, status: 'draft' }
}

/** 文章：更新（保留原发布状态；只改传入的字段） */
async function postsUpdate(body: Record<string, unknown>, bot: BotUser) {
  const p = postRef.extend(postFields).safeParse(body)
  if (!p.success) throw new HttpError('参数不合法。', 400)
  const post = await resolvePost(p.data)
  const d = p.data

  const saved = await dbApi.savePost({
    id: post.id,
    slug: d.slug ?? post.slug,
    title: d.title ?? post.title,
    summary: d.summary ?? post.summary,
    content: d.content ?? post.content,
    categories: d.categories ?? post.categories,
    status: post.status,
    date: d.date ?? post.date,
    language: d.language ?? post.language,
    translationKey: d.translationKey === undefined ? post.translationKey : d.translationKey,
    downloadable: d.downloadable ?? post.downloadable,
  }, bot.email)

  return { ok: true, id: saved.id, slug: saved.slug, status: post.status }
}

/** 文章：上线 / 下架（独立一步，不重写正文） */
async function postsSetStatus(body: Record<string, unknown>, bot: BotUser, status: 'published' | 'draft') {
  const p = postRef.safeParse(body)
  if (!p.success) throw new HttpError('参数不合法。', 400)
  const post = await resolvePost(p.data)
  const out = await dbApi.setPostStatus(post.id, status, bot.email)
  return { ok: true, id: post.id, slug: out.slug, status }
}

/** 文章：删除（连带附件与缓存失效） */
async function postsDelete(body: Record<string, unknown>, bot: BotUser) {
  const p = postRef.safeParse(body)
  if (!p.success) throw new HttpError('参数不合法。', 400)
  const post = await resolvePost(p.data)
  await dbApi.deletePost(post.id, bot.email)
  return { ok: true, id: post.id, slug: post.slug }
}

/** 彩蛋：读取（含未启用的待审版本） */
async function eggGet(body: Record<string, unknown>, bot: BotUser) {
  const p = postRef.safeParse(body)
  if (!p.success) throw new HttpError('参数不合法。', 400)
  const post = await resolvePost(p.data)
  const egg = await dbApi.getPostEggAdmin(post.slug, bot.email)
  return { ok: true, egg }
}

/** 彩蛋：写入（整页 HTML 或 Markdown 源，正文不再走普通 Markdown 渲染） */
async function eggSet(body: Record<string, unknown>, bot: BotUser) {
  const p = postRef.extend({
    html: z.string().min(1),
    renderMd: z.boolean().optional(),
    enabled: z.boolean().optional(),
  }).safeParse(body)
  if (!p.success) throw new HttpError('html 不能为空。', 400)
  const post = await resolvePost(p.data)
  if (new TextEncoder().encode(p.data.html).byteLength > dbApi.POST_EGG_MAX_BYTES) {
    throw new HttpError('彩蛋内容超过 512KB 上限，请精简或改用附件。', 413)
  }
  const egg = await dbApi.savePostEgg({
    slug: post.slug,
    html: p.data.html,
    renderMd: p.data.renderMd ?? false,
    // 与后台编辑器一致：默认直接启用
    enabled: p.data.enabled ?? true,
  }, bot.email)
  return { ok: true, egg }
}

/** 彩蛋：删除 */
async function eggDelete(body: Record<string, unknown>, bot: BotUser) {
  const p = postRef.safeParse(body)
  if (!p.success) throw new HttpError('参数不合法。', 400)
  const post = await resolvePost(p.data)
  await dbApi.deletePostEgg(post.slug, bot.email)
  return { ok: true, slug: post.slug }
}

/** 附件：列表（含密码锁/游客可见/预览状态） */
async function attachmentsList(body: Record<string, unknown>) {
  const p = z.object({ postSlug: z.string().max(160).optional() }).safeParse(body)
  if (!p.success) throw new HttpError('参数不合法。', 400)
  const rows = await dbApi.listAttachmentsAdmin(p.data.postSlug)
  return { ok: true, attachments: rows }
}

/** 附件：base64 上传（解码后 ≤4MB） */
async function attachmentsUpload(body: Record<string, unknown>, bot: BotUser) {
  const p = z.object({
    postSlug: z.string().min(1).max(160),
    filename: z.string().min(1).max(255),
    mimeType: z.string().max(255).optional(),
    base64: z.string().min(1),
    password: z.string().max(512).optional(),
    guestVisible: z.boolean().optional(),
  }).safeParse(body)
  if (!p.success) throw new HttpError('postSlug / filename / base64 为必填。', 400)
  const d = p.data

  // 允许挂在库内文章或已发布的静态文章上；其余视为路径写错
  const known = (await dbApi.getPublishedPost(d.postSlug)) || (await dbApi.getDbPostBySlug(d.postSlug))
  if (!known) throw new HttpError(`文章 ${d.postSlug} 不存在。`, 404)

  const base64 = d.base64.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new HttpError('base64 内容不合法。', 400)
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  } catch {
    throw new HttpError('base64 解码失败。', 400)
  }
  if (bytes.byteLength === 0) throw new HttpError('文件为空。', 400)
  if (bytes.byteLength > dbApi.MAX_ATTACHMENT_BYTES) {
    throw new HttpError(`文件超过 ${Math.round(dbApi.MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB 上限。`, 413)
  }

  const row = await dbApi.insertAttachment({
    postSlug: d.postSlug,
    filename: d.filename,
    mimeType: d.mimeType || 'application/octet-stream',
    sizeBytes: bytes.byteLength,
    base64Content: base64,
    password: d.password || undefined,
  }, bot.email)
  if (d.guestVisible) await dbApi.setAttachmentGuestVisible(row.id, true, bot.email)
  return { ok: true, attachment: { ...row, guestVisible: d.guestVisible === true } }
}

async function requireAttachmentId(id: number) {
  const [row] = await dbApi.useDb()
    .select({ id: attachments.id })
    .from(attachments)
    .where(eq(attachments.id, id))
    .limit(1)
  if (!row) throw new HttpError('附件不存在。', 404)
}

/** 附件：改下载密码 / 游客可见 */
async function attachmentsUpdate(body: Record<string, unknown>, bot: BotUser) {
  const p = z.object({
    id: z.number().int().positive(),
    password: z.string().max(512).optional(),
    guestVisible: z.boolean().optional(),
  }).safeParse(body)
  if (!p.success) throw new HttpError('id 不合法。', 400)
  const { id, password, guestVisible } = p.data
  if (password === undefined && guestVisible === undefined) {
    throw new HttpError('至少提供 password 或 guestVisible。', 400)
  }
  await requireAttachmentId(id)
  if (password !== undefined) {
    await dbApi.setAttachmentPassword(id, password.trim() ? password : null, bot.email)
  }
  if (guestVisible !== undefined) {
    await dbApi.setAttachmentGuestVisible(id, guestVisible, bot.email)
  }
  return { ok: true, id }
}

/** 附件：删除（连带 R2/TG 对象与预览产物） */
async function attachmentsDelete(body: Record<string, unknown>, bot: BotUser) {
  const p = z.object({ id: z.number().int().positive() }).safeParse(body)
  if (!p.success) throw new HttpError('id 不合法。', 400)
  await requireAttachmentId(p.data.id)
  await dbApi.deleteAttachment(p.data.id, bot.email)
  return { ok: true, id: p.data.id }
}

/** 分类：列表（含静态分类与译名） */
async function categoriesList() {
  return { ok: true, categories: await dbApi.listCategoryInfo() }
}

/** 分类：新建 / 补译名 / 改名（静态内置分类只能补译名） */
async function categoriesUpsert(body: Record<string, unknown>, bot: BotUser) {
  const p = z.object({
    id: z.number().int().positive().nullish(),
    name: z.string().trim().min(1).max(40),
    nameEn: z.string().max(40).nullish(),
    nameRu: z.string().max(40).nullish(),
  }).safeParse(body)
  if (!p.success) throw new HttpError('name 不能为空且不超过 40 字。', 400)
  const saved = await dbApi.saveCategory({
    id: p.data.id ?? null,
    name: p.data.name,
    nameEn: p.data.nameEn ?? null,
    nameRu: p.data.nameRu ?? null,
  }, bot.email)
  return { ok: true, category: saved }
}

/** 分类：删除（内置分类不可删） */
async function categoriesDelete(body: Record<string, unknown>, bot: BotUser) {
  const p = z.object({ id: z.number().int().positive() }).safeParse(body)
  if (!p.success) throw new HttpError('id 不合法。', 400)
  await dbApi.deleteCategory(p.data.id, bot.email)
  return { ok: true, id: p.data.id }
}

/** 管理员邮箱脱敏：ab***@example.com */
function maskEmails(raw: string): string {
  return raw
    .split(/[,\n;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((email) => {
      const [user, domain] = email.split('@')
      const head = (user || '').slice(0, 2)
      return domain ? `${head}***@${domain}` : `${head}***`
    })
    .join(', ')
}

/** 站点设置：读取（管理员邮箱脱敏；违禁词保留，便于写前自查） */
async function settingsGet() {
  const s = await dbApi.getAdminSettings()
  return { ok: true, settings: { ...s, adminEmails: maskEmails(s.adminEmails) } }
}

/** 站点设置：局部更新（只传要改的字段） */
async function settingsUpdate(body: Record<string, unknown>, bot: BotUser) {
  const p = z.object({
    siteTitle: z.string().max(120).optional(),
    siteDescription: z.string().max(500).optional(),
    customCss: z.string().max(100_000).optional(),
    adminEmails: z.string().max(2000).optional(),
    bannedWords: z.string().max(5000).optional(),
  }).safeParse(body)
  if (!p.success) throw new HttpError('参数不合法。', 400)
  const current = await dbApi.getAdminSettings()
  const saved = await dbApi.saveAdminSettings({
    siteTitle: p.data.siteTitle ?? current.siteTitle,
    siteDescription: p.data.siteDescription ?? current.siteDescription,
    customCss: p.data.customCss ?? current.customCss,
    adminEmails: p.data.adminEmails ?? current.adminEmails,
    bannedWords: p.data.bannedWords ?? current.bannedWords,
  }, bot.email)
  return { ok: true, settings: saved }
}

/** 站点内容块（about / links × zh|en|ru） */
async function siteContentList() {
  return { ok: true, contents: await dbApi.listSiteContent() }
}

async function siteContentSave(body: Record<string, unknown>, bot: BotUser) {
  const p = z.object({
    key: z.enum(['about', 'links']),
    lang: z.enum(['zh', 'en', 'ru']),
    body: z.string().max(20_000),
  }).safeParse(body)
  if (!p.success) throw new HttpError('key 需为 about|links，lang 需为 zh|en|ru。', 400)
  const saved = await dbApi.saveSiteContent(p.data, bot.email)
  return { ok: true, content: saved }
}

/** 用户：评论者列表（含邮箱、个签、标签、警告数） */
async function usersList(body: Record<string, unknown>, bot: BotUser) {
  const p = z.object({ keyword: z.string().max(120).optional() }).safeParse(body)
  if (!p.success) throw new HttpError('参数不合法。', 400)
  const all = await dbApi.adminListCommenters(bot.email)
  const kw = p.data.keyword?.trim().toLowerCase()
  const rows = kw
    ? all.filter((u) =>
        u.userId.toLowerCase().includes(kw) ||
        u.email.toLowerCase().includes(kw) ||
        (u.displayName || '').toLowerCase().includes(kw),
      )
    : all
  return { ok: true, users: rows }
}

async function usersSetSignature(body: Record<string, unknown>, bot: BotUser) {
  const p = z.object({
    userId: z.string().min(1).max(80),
    signature: z.string().max(2000),
  }).safeParse(body)
  if (!p.success) throw new HttpError('userId 与 signature 为必填。', 400)
  return { ok: true, ...(await dbApi.adminSetSignature(p.data.userId, p.data.signature, bot.email)) }
}

async function usersSetTags(body: Record<string, unknown>, bot: BotUser) {
  const p = z.object({
    userId: z.string().min(1).max(80),
    tagIds: z.array(z.number().int().positive()).max(20),
  }).safeParse(body)
  if (!p.success) throw new HttpError('userId / tagIds 不合法。', 400)
  const res = await dbApi.setUserTags(p.data.userId, p.data.tagIds, bot.email)
  return { ok: true, ...res }
}

async function usersWarn(body: Record<string, unknown>, bot: BotUser) {
  const p = z.object({
    userId: z.string().min(1).max(80),
    message: z.string().trim().min(2).max(500),
  }).safeParse(body)
  if (!p.success) throw new HttpError('userId 必填，message 需 2–500 字。', 400)
  return { ok: true, ...(await dbApi.adminIssueWarning(p.data, bot.email)) }
}

/** 身份标签定义 */
async function userTagsList() {
  return { ok: true, tags: await dbApi.listUserTags() }
}

async function userTagsCreate(body: Record<string, unknown>, bot: BotUser) {
  const p = z.object({
    name: z.string().trim().min(1).max(20),
    color: z.string().regex(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i).optional(),
    effect: z.enum(['solid', 'glow', 'gradient', 'outline']).optional(),
  }).safeParse(body)
  if (!p.success) throw new HttpError('name 必填，color 需为 #hex。', 400)
  const tag = await dbApi.createUserTag({
    name: p.data.name,
    color: p.data.color ?? '#7c3aed',
    effect: p.data.effect ?? 'solid',
  }, bot.email)
  return { ok: true, tag }
}

async function userTagsUpdate(body: Record<string, unknown>, bot: BotUser) {
  const p = z.object({
    id: z.number().int().positive(),
    name: z.string().trim().min(1).max(20).optional(),
    color: z.string().regex(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i).optional(),
    effect: z.enum(['solid', 'glow', 'gradient', 'outline']).optional(),
  }).safeParse(body)
  if (!p.success) throw new HttpError('id 不合法。', 400)
  const { id, ...patch } = p.data
  const tag = await dbApi.updateUserTag(id, patch, bot.email)
  return { ok: true, tag }
}

async function userTagsDelete(body: Record<string, unknown>, bot: BotUser) {
  const p = z.object({ id: z.number().int().positive() }).safeParse(body)
  if (!p.success) throw new HttpError('id 不合法。', 400)
  await dbApi.deleteUserTag(p.data.id, bot.email)
  return { ok: true, id: p.data.id }
}

/** 用户反馈 */
async function feedbackList(body: Record<string, unknown>, bot: BotUser) {
  const p = z.object({ status: z.enum(['open', 'resolved', 'dismissed', 'all']).optional() }).safeParse(body)
  if (!p.success) throw new HttpError('参数不合法。', 400)
  const all = await dbApi.adminListFeedback(bot.email)
  // 默认只看 open：待处理才是 bot 需要动的
  const status = p.data.status ?? 'open'
  return { ok: true, status, feedback: status === 'all' ? all : all.filter((f) => f.status === status) }
}

async function feedbackSetStatus(body: Record<string, unknown>, bot: BotUser) {
  const p = z.object({
    id: z.number().int().positive(),
    status: z.enum(['open', 'resolved', 'dismissed']),
  }).safeParse(body)
  if (!p.success) throw new HttpError('id / status 不合法。', 400)
  await dbApi.adminSetFeedbackStatus(p.data.id, p.data.status, bot.email)
  return { ok: true, id: p.data.id, status: p.data.status }
}

const handlers: Record<string, (body: Record<string, unknown>, bot: BotUser) => Promise<unknown>> = {
  'comments.list': (b) => commentsList(b),
  'comments.reply': (b, bot) => commentsReply(b, bot),
  'comments.hide': (b) => commentsHide(b),
  'comments.delete': (b) => commentsHide(b),
  'posts.list': (b) => postsList(b),
  'posts.get': (b) => postsGet(b),
  'posts.create': (b, bot) => postsCreate(b, bot),
  'posts.update': (b, bot) => postsUpdate(b, bot),
  'posts.publish': (b, bot) => postsSetStatus(b, bot, 'published'),
  'posts.unpublish': (b, bot) => postsSetStatus(b, bot, 'draft'),
  'posts.delete': (b, bot) => postsDelete(b, bot),
  'posts.egg.get': (b, bot) => eggGet(b, bot),
  'posts.egg.set': (b, bot) => eggSet(b, bot),
  'posts.egg.delete': (b, bot) => eggDelete(b, bot),
  'attachments.list': (b) => attachmentsList(b),
  'attachments.upload': (b, bot) => attachmentsUpload(b, bot),
  'attachments.update': (b, bot) => attachmentsUpdate(b, bot),
  'attachments.delete': (b, bot) => attachmentsDelete(b, bot),
  'categories.list': () => categoriesList(),
  'categories.upsert': (b, bot) => categoriesUpsert(b, bot),
  'categories.delete': (b, bot) => categoriesDelete(b, bot),
  'settings.get': () => settingsGet(),
  'settings.update': (b, bot) => settingsUpdate(b, bot),
  'siteContent.list': () => siteContentList(),
  'siteContent.save': (b, bot) => siteContentSave(b, bot),
  'users.list': (b, bot) => usersList(b, bot),
  'users.setSignature': (b, bot) => usersSetSignature(b, bot),
  'users.setTags': (b, bot) => usersSetTags(b, bot),
  'users.warn': (b, bot) => usersWarn(b, bot),
  'userTags.list': () => userTagsList(),
  'userTags.create': (b, bot) => userTagsCreate(b, bot),
  'userTags.update': (b, bot) => userTagsUpdate(b, bot),
  'userTags.delete': (b, bot) => userTagsDelete(b, bot),
  'feedback.list': (b, bot) => feedbackList(b, bot),
  'feedback.setStatus': (b, bot) => feedbackSetStatus(b, bot),
  help: async () => ({ ok: true, ...BOT_MANIFEST }),
}

export const Route = createFileRoute('/api/bot')({
  server: {
    handlers: {
      // GET 无需令牌：返回「当前开放」的自描述清单 + Markdown/LaTeX 语法速查。
      // 未开放的 action 不出现，避免 bot 去试一个注定 403 的调用。
      GET: async () => {
        const allowed = allowedActions()
        return json({
          ok: true,
          ...BOT_MANIFEST,
          actions: BOT_MANIFEST.actions.filter((a) => allowed.has(a.name)),
          allowedActions: [...allowed],
        })
      },
      POST: async ({ request }) => {
        try {
          await authenticate(request)

          const raw = await request.text()
          if (raw.length > MAX_BODY_BYTES) throw new HttpError('请求体过大。', 413)
          let body: Record<string, unknown>
          try {
            body = JSON.parse(raw) as Record<string, unknown>
          } catch {
            throw new HttpError('请求体必须是 JSON。', 400)
          }

          const action = typeof body.action === 'string' ? body.action : ''
          if (!action) throw new HttpError('缺少 action。', 400)
          const handler = action === 'ping' ? null : handlers[action]
          if (action !== 'ping' && !handler) throw new HttpError(`未知 action：${action}`, 400)

          // 服务端闸门：默认只放只读 + 建草稿，其余一律拒绝（不依赖调用方自觉）
          const allowed = allowedActions()
          if (!allowed.has(action)) {
            throw new HttpError(
              `action「${action}」未对 bot 开放。当前开放：${[...allowed].join('、')}`,
              403,
            )
          }

          // 建表检查放在 ping 之前：首次调用也要能解析/创建 bot 账号
          await dbApi.ensureSchema()
          const bot = await getBotUser()
          // ping 只回状态与动作数，不重复吐整份清单
          if (!handler) return json({ ok: true, bot, actions: allowed.size })

          try {
            return json(await handler(body, bot))
          } catch (e) {
            // 把「不在管理员名单」翻译成可操作的提示，避免 bot 拿到一串 SQL/权限原文
            if (e instanceof Error && /管理员名单/.test(e.message)) {
              throw new HttpError(
                `BOT_EMAIL（${bot.email}）不在管理员名单，写操作会被拒绝。请在后台「设置 → 管理员邮箱」加入该邮箱后重试。`,
                403,
              )
            }
            throw e
          }
        } catch (e) {
          if (e instanceof HttpError) return json({ ok: false, error: e.message }, e.status)
          return json({ ok: false, error: e instanceof Error ? e.message : '内部错误。' }, 500)
        }
      },
    },
  },
})
