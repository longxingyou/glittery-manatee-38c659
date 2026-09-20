import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

// =================================================================
// 用户系统 Server Functions（需登录；越权操作在 db 层按身份拒绝）
// 注意：handler 链上不能用 `as unknown as` 断言（会破坏 Start 编译器识别）。
// =================================================================

// 当前用户资料面板数据（个签 / 昵称 / 未读警告数 / 统计）
export const myProfileFn = createServerFn({ method: 'GET' }).handler(async () => {
  const mod = await import('../../db/index.js')
  return mod.getMyProfile()
})

// 保存本人个签（Markdown；服务端做长度与违禁词校验）
export const saveSignatureFn = createServerFn({ method: 'POST' })
  .inputValidator((input) => z.object({ signature: z.string().max(500) }).parse(input))
  .handler(async ({ data }) => {
    const mod = await import('../../db/index.js')
    return mod.saveMySignature(data.signature)
  })

// 昵称联动：浏览器侧 Identity updateUser 成功后调用，传入新昵称同步评论署名
export const syncDisplayNameFn = createServerFn({ method: 'POST' })
  .inputValidator((input) =>
    z.object({ displayName: z.string().trim().min(1).max(20) }).parse(input),
  )
  .handler(async ({ data }) => {
    const mod = await import('../../db/index.js')
    return mod.syncDisplayName(data.displayName)
  })

// 保存本人字体偏好（'' = 取消字体、恢复默认；服务端白名单校验）
export const saveFontPrefFn = createServerFn({ method: 'POST' })
  .inputValidator((input) => z.object({ fontPref: z.string().max(40).default('') }).parse(input))
  .handler(async ({ data }) => {
    const mod = await import('../../db/index.js')
    return mod.saveMyFontPref(data.fontPref)
  })

// 我的警告列表
export const myWarningsFn = createServerFn({ method: 'GET' }).handler(async () => {
  const mod = await import('../../db/index.js')
  return mod.listMyWarnings()
})

// 警告全部标记已读
export const markWarningsReadFn = createServerFn({ method: 'POST' }).handler(async () => {
  const mod = await import('../../db/index.js')
  return mod.markMyWarningsRead()
})

// 提交反馈（可带附件 id；服务端违禁词 + 附件归属校验）
export const submitFeedbackFn = createServerFn({ method: 'POST' })
  .inputValidator((input) =>
    z
      .object({
        subject: z.string().trim().min(1).max(120),
        body: z.string().trim().min(2).max(4000),
        attachmentIds: z.array(z.number().int().positive()).max(6).default([]),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const mod = await import('../../db/index.js')
    return mod.submitFeedback(data)
  })

// 注销账户：要求显式确认文本 DELETE；评论匿名化保留，个人数据删除
export const deleteAccountFn = createServerFn({ method: 'POST' })
  .inputValidator((input) =>
    z.object({ confirm: z.literal('DELETE').or(z.literal('delete')) }).parse(input),
  )
  .handler(async () => {
    const mod = await import('../../db/index.js')
    return mod.anonymizeAccount()
  })

// 移除已上传但未提交的反馈附件（仅限本人孤儿行）
export const discardAttachmentFn = createServerFn({ method: 'POST' })
  .inputValidator((input) => z.object({ id: z.number().int().positive() }).parse(input))
  .handler(async ({ data }) => {
    const mod = await import('../../db/index.js')
    return mod.discardFeedbackAttachment(data.id)
  })

// 我的评论列表（不含个签；支持关键词搜正文）
export const myCommentsFn = createServerFn({ method: 'POST' })
  .inputValidator((input) =>
    z.object({ keyword: z.string().max(200).default('') }).parse(input),
  )
  .handler(async ({ data }) => {
    const mod = await import('../../db/index.js')
    return mod.listMyComments(data.keyword)
  })

// 全部身份标签定义（公开：评论区/用户中心渲染标签需要）
export const listUserTagsFn = createServerFn({ method: 'GET' }).handler(async () => {
  const mod = await import('../../db/index.js')
  return mod.listUserTags()
})
