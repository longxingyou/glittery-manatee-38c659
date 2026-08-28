import { createFileRoute } from '@tanstack/react-router'
import { getUser } from '@netlify/identity'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '../../db/index.js'
import { comments } from '../../db/schema.js'

const commentSchema = z.object({
  postSlug: z.string().min(1).max(160),
  body: z.string().trim().min(2).max(4000),
})

export const Route = createFileRoute('/api/comments')({
  server: {
    handlers: {
      GET: async ({ request }) => {
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
      },
      POST: async ({ request }) => {
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
      },
    },
  },
})
