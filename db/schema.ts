import { index, integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'

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
