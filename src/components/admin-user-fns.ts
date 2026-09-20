import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

// =================================================================
// 管理员：用户（评论者）管理 + 反馈处理
// 所有 fn 内部均经 requireAdmin() 二次鉴权
// =================================================================

// 评论者列表：昵称/邮箱/个签/评论数/警告数
export const listCommentersFn = createServerFn({ method: 'GET' }).handler(async () => {
  const mod = await import('../../db/index.js')
  return mod.adminListCommenters()
})

// 修改/清空指定用户的个签
export const adminSetSignatureFn = createServerFn({ method: 'POST' })
  .inputValidator((input) =>
    z.object({ userId: z.string().min(1).max(128), signature: z.string().max(500) }).parse(input),
  )
  .handler(async ({ data }) => {
    const mod = await import('../../db/index.js')
    return mod.adminSetSignature(data.userId, data.signature)
  })

// 向指定用户发出警告
export const issueWarningFn = createServerFn({ method: 'POST' })
  .inputValidator((input) =>
    z.object({ userId: z.string().min(1).max(128), message: z.string().trim().min(2).max(500) }).parse(input),
  )
  .handler(async ({ data }) => {
    const mod = await import('../../db/index.js')
    return mod.adminIssueWarning(data)
  })

// 反馈列表（含附件元数据）
export const listFeedbackFn = createServerFn({ method: 'GET' }).handler(async () => {
  const mod = await import('../../db/index.js')
  return mod.adminListFeedback()
})

// 更新反馈状态
export const feedbackStatusFn = createServerFn({ method: 'POST' })
  .inputValidator((input) =>
    z
      .object({ id: z.number().int().positive(), status: z.enum(['open', 'resolved', 'dismissed']) })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const mod = await import('../../db/index.js')
    return mod.adminSetFeedbackStatus(data.id, data.status)
  })

// 管理员评论搜索：scope=mine（自己）| all（所有人）| user（指定人，需 userId）
export const adminCommentsFn = createServerFn({ method: 'POST' })
  .inputValidator((input) =>
    z
      .object({
        scope: z.enum(['mine', 'all', 'user']),
        userId: z.string().min(1).max(128).optional(),
        keyword: z.string().max(200).default(''),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const mod = await import('../../db/index.js')
    return mod.adminListComments(data)
  })

// ---- 身份标签管理 ----
export const createUserTagFn = createServerFn({ method: 'POST' })
  .inputValidator((input) =>
    z
      .object({
        name: z.string().trim().min(1).max(20),
        color: z.string().regex(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i),
        effect: z.enum(['solid', 'glow', 'gradient', 'outline']),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const mod = await import('../../db/index.js')
    return mod.createUserTag(data)
  })

export const updateUserTagFn = createServerFn({ method: 'POST' })
  .inputValidator((input) =>
    z
      .object({
        id: z.number().int().positive(),
        name: z.string().trim().min(1).max(20).optional(),
        color: z.string().regex(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i).optional(),
        effect: z.enum(['solid', 'glow', 'gradient', 'outline']).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const mod = await import('../../db/index.js')
    return mod.updateUserTag(data.id, { name: data.name, color: data.color, effect: data.effect })
  })

export const deleteUserTagFn = createServerFn({ method: 'POST' })
  .inputValidator((input) => z.object({ id: z.number().int().positive() }).parse(input))
  .handler(async ({ data }) => {
    const mod = await import('../../db/index.js')
    return mod.deleteUserTag(data.id)
  })

// 给用户设置标签（覆盖式）
export const setUserTagsFn = createServerFn({ method: 'POST' })
  .inputValidator((input) =>
    z.object({ userId: z.string().min(1).max(128), tagIds: z.array(z.number().int().nonnegative()).max(20) }).parse(input),
  )
  .handler(async ({ data }) => {
    const mod = await import('../../db/index.js')
    return mod.setUserTags(data.userId, data.tagIds)
  })
