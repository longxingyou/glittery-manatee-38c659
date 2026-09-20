import { createFileRoute } from '@tanstack/react-router'
import { and, asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import * as dbApi from '../../db/index.js'
import { comments } from '../../db/schema.js'
import { renderMarkdown } from '../lib/markdown.js'
import { DEFAULT_SITE_DESCRIPTION, DEFAULT_SITE_TITLE } from '../lib/utils.js'

const commentSchema = z.object({
  postSlug: z.string().min(1).max(160),
  body: z.string().trim().min(2).max(4000),
  parentId: z.number().int().positive().optional(),
})

function xmlEscape(s: string) {
  return s.replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;' }[c]!))
}
function stripTags(html: string) {
  return html.replace(/<\/?[^>]+(>|$)/g, '').replace(/\s+/g, ' ').trim()
}
function filenameHeader(filename: string) {
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`
}

// GET /rss.xml（从 action 参数或原始路径分发）
export async function handleRss(request: Request): Promise<Response> {
  const posts = await dbApi.listPublishedPosts()
  const settings = await dbApi.getPublicSettings()
  const origin = new URL(request.url).origin
  const now = new Date().toUTCString()
  const items = posts.slice(0, 50).map((post) => {
    const link = `${origin}/posts/${encodeURIComponent(post.slug)}`
    const html = renderMarkdown(post.content || post.summary || '')
    const description = stripTags(html).slice(0, 500)
    const pubDate = isNaN(new Date(post.date).getTime())
      ? now
      : new Date(post.date).toUTCString()
    return `<item><title>${xmlEscape(post.title)}</title><link>${xmlEscape(link)}</link><guid isPermaLink="false">post-${post.id ?? post.slug}</guid><pubDate>${pubDate}</pubDate><description><![CDATA[${xmlEscape(description)}]]></description>${post.categories.map((c) => `<category>${xmlEscape(c)}</category>`).join('')}</item>`
  }).join('')
  const body = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${xmlEscape(settings.siteTitle || DEFAULT_SITE_TITLE)}</title><link>${xmlEscape(origin)}</link><atom:link href="${xmlEscape(origin + '/rss.xml')}" rel="self" type="application/rss+xml" /><description>${xmlEscape(settings.siteDescription || DEFAULT_SITE_DESCRIPTION)}</description><language>zh-CN</language><lastBuildDate>${now}</lastBuildDate>${items}</channel></rss>`
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

// GET /api/comments?action=file&id=ID&token=...
async function handleFileGet(_request: Request, url: URL): Promise<Response> {
  // 附件登录门禁：访客必须先登录（sg_auth cookie）才能下载
  const user = await dbApi.getCurrentUser()
  if (!user) return Response.json({ authRequired: true, error: '请先登录后查看与下载附件。' }, { status: 401 })
  const id = Number(url.searchParams.get('id'))
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: '附件标识不合法。' }, { status: 400 })
  const row = await dbApi.getAttachmentFullRow(id)
  if (!row) return Response.json({ error: '附件不存在。' }, { status: 404 })
  const token = url.searchParams.get('token') || ''
  if (row.passwordHash && row.passwordSalt) {
    if (!token) return Response.json({ locked: true, error: '此附件已加密，请提供密码后下载。' }, { status: 401 })
    const secret = await dbApi.getTokenSecret()
    const payload = await dbApi.verifyToken<{ aid: number }>(token, secret)
    if (!payload || payload.aid !== id) return Response.json({ locked: true, error: '下载令牌无效或已过期，请重新输入密码。' }, { status: 401 })
  }
  // 从 base64 恢复二进制并响应
  try {
    const bytes = Uint8Array.from(globalThis.atob(row.content || ''), (c) => c.charCodeAt(0))
    // 异步记录下载计数，不阻塞响应
    dbApi.recordDownload(id).catch(() => undefined)
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': row.mimeType || 'application/octet-stream',
        'Content-Length': String(bytes.length),
        'Content-Disposition': filenameHeader(row.filename),
        'Cache-Control': 'private, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return Response.json({ error: '附件内容读取失败。' }, { status: 500 })
  }
}

// POST /api/comments?action=token&id=ID {password} → 返回下载令牌
async function handleTokenPost(request: Request, url: URL): Promise<Response> {
  const user = await dbApi.getCurrentUser()
  if (!user) return Response.json({ authRequired: true, error: '请先登录后查看与下载附件。' }, { status: 401 })
  const id = Number(url.searchParams.get('id'))
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: '附件标识不合法。' }, { status: 400 })
  const row = await dbApi.getAttachmentFullRow(id)
  if (!row) return Response.json({ error: '附件不存在。' }, { status: 404 })
  if (!row.passwordHash || !row.passwordSalt) {
    // 未上锁的无需令牌——直接签发短期令牌用于下载计数
    const secret = await dbApi.getTokenSecret()
    const token = await dbApi.signToken({ aid: id, exp: Date.now() + 600_000 }, secret)
    return Response.json({ token })
  }
  const parsed = z.object({ password: z.string().min(1).max(512) }).safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: '请输入密码。' }, { status: 400 })
  const ok = await dbApi.verifyPassword(parsed.data.password, row.passwordSalt, row.passwordHash)
  if (!ok) return Response.json({ error: '密码不正确。' }, { status: 401 })
  const secret = await dbApi.getTokenSecret()
  const token = await dbApi.signToken({ aid: id, exp: Date.now() + 600_000 }, secret)
  return Response.json({ token })
}

// POST /api/comments?action=upload  multipart/form-data：file, postSlug, password?
async function handleUploadPost(request: Request): Promise<Response> {
  const user = await dbApi.getCurrentUser()
  if (!user?.email) return Response.json({ error: '请先登录。' }, { status: 401 })
  // 管理员身份交给 insertAttachment 内部 requireAdmin 校验
  const formData = await request.formData().catch(() => null as unknown as FormData)
  if (!formData) return Response.json({ error: '请求体解析失败。' }, { status: 400 })
  const file = formData.get('file') as File | null
  const postSlug = String(formData.get('postSlug') || '').trim()
  const password = String(formData.get('password') || '')
  if (!file || !(file instanceof File)) return Response.json({ error: '请选择要上传的文件。' }, { status: 400 })
  if (!postSlug) return Response.json({ error: '缺少 postSlug。' }, { status: 400 })
  if (file.size === 0) return Response.json({ error: '文件为空。' }, { status: 400 })
  if (file.size > dbApi.MAX_ATTACHMENT_BYTES) {
    return Response.json({ error: `文件超过大小上限（${Math.round(dbApi.MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB）。` }, { status: 413 })
  }
  const buffer = new Uint8Array(await file.arrayBuffer())
  const base64Content = globalThis.btoa(String.fromCharCode(...buffer))
  try {
    const row = await dbApi.insertAttachment({
      postSlug,
      filename: file.name || 'unnamed',
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      base64Content,
      password: password || undefined,
    })
    return Response.json({ attachment: row }, { status: 201 })
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : '上传失败。' }, { status: 403 })
  }
}

// GET /api/comments?action=adminStatus → 管理员状态（服务端可读 cookie）
async function handleAdminStatusGet(): Promise<Response> {
  const status = await dbApi.getAdminStatus()
  return Response.json({ status }, {
    headers: { 'Cache-Control': 'private, no-store, must-revalidate' },
  })
}

// POST /api/comments?action=feedbackUpload  multipart：反馈附件（截图等），登录即可
async function handleFeedbackUploadPost(request: Request): Promise<Response> {
  const user = await dbApi.getCurrentUser()
  if (!user?.email) return Response.json({ error: '请先登录后再上传附件。' }, { status: 401 })
  const formData = await request.formData().catch(() => null as unknown as FormData)
  if (!formData) return Response.json({ error: '请求体解析失败。' }, { status: 400 })
  const file = formData.get('file') as File | null
  if (!file || !(file instanceof File)) return Response.json({ error: '请选择要上传的文件。' }, { status: 400 })
  if (file.size === 0) return Response.json({ error: '文件为空。' }, { status: 400 })
  if (file.size > dbApi.MAX_ATTACHMENT_BYTES) {
    return Response.json({ error: `文件超过大小上限（${Math.round(dbApi.MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB）。` }, { status: 413 })
  }
  const buffer = new Uint8Array(await file.arrayBuffer())
  const base64Content = globalThis.btoa(String.fromCharCode(...buffer))
  try {
    const row = await dbApi.insertFeedbackAttachment({
      filename: file.name || 'screenshot',
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      base64Content,
    })
    return Response.json({ attachment: row }, { status: 201 })
  } catch (e) {
    const status = e instanceof Error && /请先登录/.test(e.message) ? 401 : 400
    return Response.json({ error: e instanceof Error ? e.message : '上传失败。' }, { status })
  }
}

// GET /api/comments?action=feedbackFile&id=ID → 反馈附件下载（本人或管理员）
async function handleFeedbackFileGet(url: URL): Promise<Response> {
  const id = Number(url.searchParams.get('id'))
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: '附件标识不合法。' }, { status: 400 })
  let row: Awaited<ReturnType<typeof dbApi.getFeedbackAttachmentRow>>
  try {
    row = await dbApi.getFeedbackAttachmentRow(id)
  } catch (e) {
    const status = e instanceof Error && /请先登录/.test(e.message) ? 401 : 403
    return Response.json({ error: e instanceof Error ? e.message : '无权访问。' }, { status })
  }
  if (!row) return Response.json({ error: '附件不存在。' }, { status: 404 })
  try {
    const bytes = Uint8Array.from(globalThis.atob(row.content || ''), (c) => c.charCodeAt(0))
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': row.mimeType || 'application/octet-stream',
        'Content-Length': String(bytes.length),
        'Content-Disposition': filenameHeader(row.filename),
        'Cache-Control': 'private, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return Response.json({ error: '附件内容读取失败。' }, { status: 500 })
  }
}

// 评论行的可序列化形状（返回给前台的统一结构）
// 注意：userId / userEmail 属于身份信息，绝不下发到前台；
//   - 本人判定由服务端计算为 mine 布尔值
//   - 邮箱搜索由服务端完成（emailQ 参数），仅返回命中的评论 id
type CommentPayload = {
  id: number
  parentId: number | null
  userName: string
  body: string
  createdAt: string
  editedAt: string | null
  status: string
  likes: number
  mine: boolean
  // 个性签名（Markdown 源，前台经 renderMarkdown 消毒渲染）；软删评论为空
  signature: string
  // 身份标签 id 列表（外显装饰；所有视角可见）
  tags: number[]
  // 仅管理员视角携带：评论者的不透明身份 id，用于个签管理/警告（访客无此字段）
  userKey?: string
}

type Viewer = { id: string; email: string; isAdmin: boolean } | null

const commentColumns = {
  id: comments.id,
  parentId: comments.parentId,
  userId: comments.userId,
  userName: comments.userName,
  userEmail: comments.userEmail,
  body: comments.body,
  createdAt: comments.createdAt,
  editedAt: comments.editedAt,
  status: comments.status,
  likes: comments.likes,
}

function toCommentPayload(row: {
  id: number
  parentId: number | null
  userId: string
  userName: string
  userEmail: string
  body: string
  createdAt: Date | string
  editedAt: Date | string | null
  status: string
  likes: number
}, viewer: Viewer, signatureMap: Record<string, string>, tagsMap: Record<string, number[]>): CommentPayload {
  const deleted = row.status !== 'published'
  // 本人判定在服务端完成：前台只需知道是否可编辑/删除，不需要知道身份标识
  const mine = !!viewer
    && !deleted
    && (row.userId === viewer.id || row.userEmail.toLowerCase() === viewer.email.toLowerCase())
  return {
    id: row.id,
    parentId: row.parentId,
    // 软删评论对前台隐藏正文与署名（仅在有保留回复时作为匿名占位出现）
    userName: deleted ? '' : row.userName,
    body: deleted ? '' : row.body,
    createdAt: new Date(row.createdAt).toISOString(),
    editedAt: row.editedAt ? new Date(row.editedAt).toISOString() : null,
    status: row.status,
    likes: row.likes,
    mine,
    signature: deleted ? '' : (signatureMap[row.userId] || ''),
    tags: deleted ? [] : (tagsMap[row.userId] || []),
    // userKey 仅对管理员下发（不透明 UUID，非邮箱等 PII）
    ...(viewer?.isAdmin && !deleted ? { userKey: row.userId } : {}),
  }
}

const fileRouterCommentsGet = async (request: Request) => {
  const url = new URL(request.url)
  const postSlug = url.searchParams.get('post')
  if (!postSlug) return Response.json({ error: '缺少文章标识。' }, { status: 400 })

  // 本地无 DB：返回空评论列表，避免文章页评论区 500
  if (!dbApi.isDbConfigured()) return Response.json({ comments: [], emailMatchIds: null })

  // viewer 同时需要 isAdmin（决定 userKey 是否下发）
  const me = await dbApi.getCurrentUser()
  const adminStatus = me ? await dbApi.getAdminStatus() : null
  const viewer: Viewer = me ? { id: me.id, email: me.email, isAdmin: !!adminStatus?.isAdmin } : null

  const rows = await dbApi.useDb()
    .select(commentColumns)
    .from(comments)
    .where(eq(comments.postSlug, postSlug))
    .orderBy(asc(comments.createdAt), asc(comments.id))

  // 软删过滤：已发布评论全部保留；被软删的评论仅当其下还有保留的回复时
  // 才作为占位保留（回复默认保留），否则彻底隐藏。
  const kept = new Set<number>(rows.filter((r) => r.status === 'published').map((r) => r.id))
  for (const r of rows) {
    if (r.status !== 'published' && r.parentId == null) {
      const hasKeptReply = rows.some((c) => c.parentId === r.id && kept.has(c.id))
      if (hasKeptReply) kept.add(r.id)
    }
  }
  const visibleRows = rows.filter((r) => kept.has(r.id))
  // 批量取个签与标签（一次查询，不在循环中逐条查库）
  const userIds = visibleRows.map((r) => r.userId)
  const signatureMap = await dbApi.getSignatureMap(userIds).catch(() => ({}))
  const tagsMap = await dbApi.getTagsMap(userIds).catch(() => ({}))
  const visible = visibleRows.map((r) => toCommentPayload(r, viewer, signatureMap, tagsMap))

  // 邮箱搜索服务端化：邮箱不进入响应，匹配在这里完成，仅回传命中的评论 id
  let emailMatchIds: number[] | null = null
  const emailQ = url.searchParams.get('emailQ')?.trim()
  if (emailQ) {
    const isRegex = url.searchParams.get('emailMode') === 'regex'
    try {
      const re = isRegex ? new RegExp(emailQ, 'i') : null
      const needle = emailQ.toLowerCase()
      emailMatchIds = visibleRows
        .filter((r) => r.status === 'published'
          && (re ? re.test(r.userEmail) : r.userEmail.toLowerCase().includes(needle)))
        .map((r) => r.id)
    } catch {
      // 非法正则：无命中（前台也会同步提示正则无效）
      emailMatchIds = []
    }
  }

  // 评论数据按身份个性化（mine / userKey）且随时变更，禁止任何缓存，
  // 既避免改名/改签后浏览器显示旧数据，也防止 CDN 串号。
  return Response.json({ comments: visible, emailMatchIds }, {
    headers: { 'Cache-Control': 'private, no-store, must-revalidate' },
  })
}

const fileRouterCommentsPost = async (request: Request) => {
  const user = await dbApi.getCurrentUser()
  if (!user?.email) {
    return Response.json({ error: '请先登录并完成邮箱验证。' }, { status: 401 })
  }

  const parsed = commentSchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return Response.json({ error: '评论需为 2–4000 个字符。' }, { status: 422 })
  }
  const { postSlug, body, parentId } = parsed.data

  // 违禁词检测（个签/反馈共用同一词表）
  const banned = await dbApi.containsBannedWord(body)
  if (banned) {
    return Response.json({ error: `评论包含违禁内容（命中词：${banned}），请修改后重试。` }, { status: 422 })
  }

  // 回复校验：目标必须存在、属于同一篇文章、状态正常且本身是顶层评论（回复只有一层）
  if (parentId != null) {
    const [parent] = await dbApi.useDb()
      .select({ id: comments.id, postSlug: comments.postSlug, parentId: comments.parentId, status: comments.status })
      .from(comments)
      .where(eq(comments.id, parentId))
      .limit(1)
    if (!parent || parent.postSlug !== postSlug || parent.status !== 'published' || parent.parentId != null) {
      return Response.json({ error: '回复目标不存在或不可回复。' }, { status: 400 })
    }
  }

  const displayName = user.name || user.email.split('@')[0]

  const [created] = await dbApi.useDb()
    .insert(comments)
    .values({
      postSlug,
      body,
      parentId: parentId ?? null,
      userId: user.id,
      userEmail: user.email,
      userName: displayName,
    })
    .returning(commentColumns)

  const sigMap = await dbApi.getSignatureMap([user.id]).catch(() => ({}))
  const tagsMap = await dbApi.getTagsMap([user.id]).catch(() => ({}))
  const viewer: Viewer = { id: user.id, email: user.email, isAdmin: (await dbApi.getAdminStatus()).isAdmin }
  return Response.json({ comment: toCommentPayload(created!, viewer, sigMap, tagsMap) }, { status: 201 })
}

// PATCH /api/comments { id, body } → 编辑评论（本人或管理员），记录最后编辑时间
async function handleCommentPatch(request: Request): Promise<Response> {
  const user = await dbApi.getCurrentUser()
  if (!user?.email) return Response.json({ error: '请先登录。' }, { status: 401 })

  const parsed = z.object({ id: z.number().int().positive(), body: z.string().trim().min(2).max(4000) })
    .safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: '评论需为 2–4000 个字符。' }, { status: 422 })

  const [row] = await dbApi.useDb().select(commentColumns).from(comments).where(eq(comments.id, parsed.data.id)).limit(1)
  if (!row) return Response.json({ error: '评论不存在。' }, { status: 404 })
  if (row.status !== 'published') return Response.json({ error: '该评论已删除，无法编辑。' }, { status: 400 })

  const status = await dbApi.getAdminStatus()
  const isOwner = row.userId === user.id || row.userEmail.toLowerCase() === user.email.toLowerCase()
  if (!status.isAdmin && !isOwner) {
    return Response.json({ error: '只能编辑自己的评论。' }, { status: 403 })
  }

  // 违禁词检测（管理员编辑同样拦截，避免违规内容留存）
  const banned = await dbApi.containsBannedWord(parsed.data.body)
  if (banned) {
    return Response.json({ error: `评论包含违禁内容（命中词：${banned}），请修改后重试。` }, { status: 422 })
  }

  const [updated] = await dbApi.useDb()
    .update(comments)
    .set({ body: parsed.data.body, editedAt: sql`NOW()` })
    .where(eq(comments.id, parsed.data.id))
    .returning(commentColumns)
  const sigMap = await dbApi.getSignatureMap([updated!.userId]).catch(() => ({}))
  const tagsMap = await dbApi.getTagsMap([updated!.userId]).catch(() => ({}))
  const viewer: Viewer = { id: user.id, email: user.email, isAdmin: status.isAdmin }
  return Response.json({ comment: toCommentPayload(updated!, viewer, sigMap, tagsMap) })
}

// DELETE /api/comments?id=ID&cascade=1 → 软删评论；cascade 仅管理员可用，级联软删全部直接回复
async function handleCommentDelete(_request: Request, url: URL): Promise<Response> {
  const user = await dbApi.getCurrentUser()
  if (!user?.email) return Response.json({ error: '请先登录。' }, { status: 401 })

  const id = Number(url.searchParams.get('id'))
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: '评论标识不合法。' }, { status: 400 })

  const [row] = await dbApi.useDb().select(commentColumns).from(comments).where(eq(comments.id, id)).limit(1)
  if (!row) return Response.json({ error: '评论不存在。' }, { status: 404 })

  const status = await dbApi.getAdminStatus()
  const isOwner = row.userId === user.id || row.userEmail.toLowerCase() === user.email.toLowerCase()
  if (!status.isAdmin && !isOwner) {
    return Response.json({ error: '只能删除自己的评论。' }, { status: 403 })
  }

  const cascade = url.searchParams.get('cascade') === '1'
  if (cascade && !status.isAdmin) {
    return Response.json({ error: '仅管理员可以级联删除全部回复。' }, { status: 403 })
  }

  // 级联：软删该评论下的全部保留回复（回复只有一层，直接子级即全部）
  if (cascade) {
    await dbApi.useDb()
      .update(comments)
      .set({ status: 'deleted' })
      .where(and(eq(comments.parentId, id), eq(comments.status, 'published')))
  }
  // 软删本体（正文保留在库中，前台隐藏；若有保留回复则显示占位）
  await dbApi.useDb().update(comments).set({ status: 'deleted' }).where(eq(comments.id, id))
  return Response.json({ ok: true })
}

export const Route = createFileRoute('/api/comments')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const action = url.searchParams.get('action')
        if (action === 'file') return handleFileGet(request, url)
        if (action === 'feedbackFile') return handleFeedbackFileGet(url)
        if (action === 'adminStatus') return handleAdminStatusGet()
        if (action === 'rss') return handleRss(request)
        return fileRouterCommentsGet(request)
      },
      POST: async ({ request }) => {
        const url = new URL(request.url)
        const action = url.searchParams.get('action')
        if (action === 'token') return handleTokenPost(request, url)
        if (action === 'upload') return handleUploadPost(request)
        if (action === 'feedbackUpload') return handleFeedbackUploadPost(request)
        return fileRouterCommentsPost(request)
      },
      PATCH: async ({ request }) => handleCommentPatch(request),
      DELETE: async ({ request }) => handleCommentDelete(request, new URL(request.url)),
    },
  },
})
