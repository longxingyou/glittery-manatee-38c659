import { createFileRoute } from '@tanstack/react-router'
import { getUser } from '@netlify/identity'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '../../db/index.js'
import * as dbApi from '../../db/index.js'
import { comments } from '../../db/schema.js'
import { renderMarkdown } from '../lib/markdown.js'
import { DEFAULT_SITE_DESCRIPTION, DEFAULT_SITE_TITLE } from '../lib/utils.js'

const commentSchema = z.object({
  postSlug: z.string().min(1).max(160),
  body: z.string().trim().min(2).max(4000),
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
  const user = await getUser().catch(() => null)
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
  return Response.json({ status })
}

const fileRouterCommentsGet = async (request: Request) => {
  const postSlug = new URL(request.url).searchParams.get('post')
  if (!postSlug) return Response.json({ error: '缺少文章标识。' }, { status: 400 })

  const rows = await db
    .select({
      id: comments.id,
      userName: comments.userName,
      body: comments.body,
      createdAt: comments.createdAt,
      likes: comments.likes,
    })
    .from(comments)
    .where(and(eq(comments.postSlug, postSlug), eq(comments.status, 'published')))
    .orderBy(asc(comments.createdAt))

  return Response.json({ comments: rows })
}

const fileRouterCommentsPost = async (request: Request) => {
  const user = await getUser()
  if (!user?.email) {
    return Response.json({ error: '请先登录并完成邮箱验证。' }, { status: 401 })
  }

  const parsed = commentSchema.safeParse(await request.json())
  if (!parsed.success) {
    return Response.json({ error: '评论需为 2–4000 个字符。' }, { status: 422 })
  }

  const displayName =
    user.name ||
    (typeof user.userMetadata?.full_name === 'string' ? user.userMetadata.full_name : '') ||
    user.email.split('@')[0]

  const [created] = await db
    .insert(comments)
    .values({
      postSlug: parsed.data.postSlug,
      body: parsed.data.body,
      userId: user.id,
      userEmail: user.email,
      userName: displayName,
    })
    .returning({
      id: comments.id,
      userName: comments.userName,
      body: comments.body,
      createdAt: comments.createdAt,
      likes: comments.likes,
    })

  return Response.json({ comment: created }, { status: 201 })
}

export const Route = createFileRoute('/api/comments')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const action = url.searchParams.get('action')
        if (action === 'file') return handleFileGet(request, url)
        if (action === 'adminStatus') return handleAdminStatusGet()
        if (action === 'rss') return handleRss(request)
        return fileRouterCommentsGet(request)
      },
      POST: async ({ request }) => {
        const url = new URL(request.url)
        const action = url.searchParams.get('action')
        if (action === 'token') return handleTokenPost(request, url)
        if (action === 'upload') return handleUploadPost(request)
        return fileRouterCommentsPost(request)
      },
    },
  },
})

// RSS handler 具名导出（router.tsx 中 /rss.xml 编程式路由引用）
export const rssHandler = handleRss
