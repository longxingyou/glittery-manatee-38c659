import { index, integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const comments = pgTable(
  'comments',
  {
    id: serial('id').primaryKey(),
    postSlug: text('post_slug').notNull(),
    userId: text('user_id').notNull(),
    userName: text('user_name').notNull(),
    userEmail: text('user_email').notNull(),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    status: text('status').default('published').notNull(),
    likes: integer('likes').default(0).notNull(),
  },
  (table) => [index('comments_post_slug_idx').on(table.postSlug, table.createdAt)],
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => [index('posts_date_idx').on(table.date)],
)

export const categories = pgTable('categories', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
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

// 站点级单例设置（id 恒为 1）
export const settings = pgTable('settings', {
  id: integer('id').primaryKey().default(1),
  siteTitle: text('site_title'),
  siteDescription: text('site_description'),
  customCss: text('custom_css'),
  adminEmails: text('admin_emails'),
  tokenSecret: text('token_secret'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})
