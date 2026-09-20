import { index, integer, pgTable, primaryKey, serial, text, timestamp } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// 自建账户体系（替代 Netlify Identity）：PBKDF2 密码哈希 + 邮箱验证 + 找回密码令牌
export const users = pgTable('users', {
  id: text('id').primaryKey(), // 随机 hex
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  passwordSalt: text('password_salt').notNull(),
  displayName: text('display_name').notNull().default(''),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  confirmTokenHash: text('confirm_token_hash'), // 邮箱验证令牌的 SHA-256（令牌原文只走邮件链接）
  confirmExpires: timestamp('confirm_expires', { withTimezone: true }),
  resetTokenHash: text('reset_token_hash'),
  resetExpires: timestamp('reset_expires', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const comments = pgTable(
  'comments',
  {
    id: serial('id').primaryKey(),
    postSlug: text('post_slug').notNull(),
    userId: text('user_id').notNull(),
    userName: text('user_name').notNull(),
    userEmail: text('user_email').notNull(),
    body: text('body').notNull(),
    parentId: integer('parent_id'), // 回复目标：NULL=顶层评论；否则指向顶层评论 id（回复只有一层）
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    status: text('status').default('published').notNull(), // published | deleted（软删，保留回复时作占位）
    likes: integer('likes').default(0).notNull(),
  },
  (table) => [
    index('comments_post_slug_idx').on(table.postSlug, table.createdAt),
    index('comments_parent_id_idx').on(table.parentId),
  ],
)

// 后台发布的文章（content/posts 下的 Markdown 为静态种子文章，运行时发布的文章存于此表）
export const posts = pgTable(
  'posts',
  {
    id: serial('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    content: text('content').notNull().default(''),
    categories: text('categories')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text('status').notNull().default('draft'), // draft | published
    date: text('date').notNull(),
    language: text('language').notNull().default('zh'), // zh | en | ru
    translationKey: text('translation_key'), // 同一篇文章的多语言版本共享此键（通常取原文 slug）
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => [index('posts_date_idx').on(table.date), index('posts_translation_key_idx').on(table.translationKey)],
)

export const categories = pgTable('categories', {
  id: serial('id').primaryKey(),
  // name 为权威中文名（同时是 posts.categories[] 与 /category/:name 的规范键）
  name: text('name').notNull().unique(),
  nameEn: text('name_en'), // 英文译名（空 = 回退显示中文名）
  nameRu: text('name_ru'), // 俄文译名（空 = 依次回退英文/中文）
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// 文章附件（二进制以 base64 存于 content 列；passwordHash 为空表示公开）
export const attachments = pgTable(
  'attachments',
  {
    id: serial('id').primaryKey(),
    postSlug: text('post_slug').notNull(),
    filename: text('filename').notNull(),
    content: text('content').notNull().default(''), // base64 编码的附件二进制
    mimeType: text('mime_type').notNull().default('application/octet-stream'),
    sizeBytes: integer('size_bytes').notNull().default(0),
    passwordHash: text('password_hash'),
    passwordSalt: text('password_salt'),
    downloads: integer('downloads').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('attachments_post_slug_idx').on(table.postSlug)],
)

// 用户资料：个签（Markdown 源）与昵称缓存（评论署名的权威来源）
export const profiles = pgTable(
  'profiles',
  {
    userId: text('user_id').primaryKey(), // 自建 users.id；已注销账户为 'deleted'
    email: text('email').notNull(),
    displayName: text('display_name').notNull().default(''),
    signature: text('signature').notNull().default(''), // Markdown 个签；渲染层负责消毒
    signatureUpdatedBy: text('signature_updated_by'), // null=本人；否则为管理员邮箱
    tags: text('tags').notNull().default(''), // 身份标签 id 列表，逗号分隔；对应 user_tags.id
    fontPref: text('font_pref').notNull().default(''), // 字体偏好 id（''=网站默认）；客户端另有 localStorage
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
)

// 站点内容块（用户中心展示；后台像文章一样按 Markdown 编辑）。key: about=网站简介, links=友情链接
export const siteContent = pgTable(
  'site_content',
  {
    key: text('key').notNull(), // about | links
    lang: text('lang').notNull(), // zh | en | ru
    body: text('body').notNull().default(''), // Markdown 源；渲染层负责消毒
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.key, table.lang] })],
)

// 身份标签定义（管理员自定义；仅外显装饰 + 方便管理员查找用户）
export const userTags = pgTable(
  'user_tags',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull().unique(),
    color: text('color').notNull().default('#7c3aed'), // 标签主色（hex）
    effect: text('effect').notNull().default('solid'), // solid | glow | gradient | outline
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
)

// 管理员对用户发出的警告
export const warnings = pgTable(
  'warnings',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id').notNull(),
    email: text('email').notNull(),
    message: text('message').notNull(),
    issuedBy: text('issued_by').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('warnings_user_id_idx').on(table.userId, table.createdAt)],
)

// 用户反馈（反馈附件存于 feedback_attachments）
export const feedback = pgTable(
  'feedback',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id').notNull(),
    email: text('email').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    status: text('status').notNull().default('open'), // open | resolved | dismissed
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [index('feedback_status_idx').on(table.status, table.createdAt)],
)

// 反馈附件（私有：仅反馈人本人与管理员可下载）
export const feedbackAttachments = pgTable(
  'feedback_attachments',
  {
    id: serial('id').primaryKey(),
    feedbackId: integer('feedback_id'), // 提交反馈前附件先上传，此时为 null；提交后回填
    filename: text('filename').notNull(),
    content: text('content').notNull().default(''), // base64
    mimeType: text('mime_type').notNull().default('application/octet-stream'),
    sizeBytes: integer('size_bytes').notNull().default(0),
    ownerId: text('owner_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('feedback_attachments_fb_idx').on(table.feedbackId)],
)

// 站点级单例设置（id 恒为 1）
export const settings = pgTable('settings', {
  id: integer('id').primaryKey().default(1),
  siteTitle: text('site_title'),
  siteDescription: text('site_description'),
  customCss: text('custom_css'),
  adminEmails: text('admin_emails'),
  tokenSecret: text('token_secret'),
  bannedWords: text('banned_words'), // 违禁词，逗号/换行分隔；与内置默认表合并生效
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})
