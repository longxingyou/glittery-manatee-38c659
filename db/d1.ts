/**
 * X岛本地搜索索引 — D1 原生查询层。
 *
 * 放弃 Drizzle D1 driver：schema 太小、FTS5 触发器不在 Drizzle 表达范围内。
 * 所有查询用 `db.prepare(sql).bind(...)` 原生 SQL。
 *
 * 函数签名与 db/index.ts 同名（加 D1 后缀），便于 shim 替换：
 *   - 读路径（主站 shim 调用）：searchXdnmbIndexD1 / findXdnmbThreadByPostIdD1 /
 *     getXdnmbIndexStatsD1 / getXdnmbIndexThreadD1
 *   - 写路径（爬虫 Worker 调用）：upsert 系列 + recrawl 队列 + settings
 *
 * D1Database 类型与 src/lib/server-env.ts 的最小定义结构兼容；
 * 此处单独声明避免跨项目导入耦合（爬虫 Worker 也直接引用本文件）。
 */

/** D1 数据库最小类型（结构兼容 server-env.ts 与 @cloudflare/workers-types） */
export interface D1Database {
  prepare(sql: string): D1PreparedStatement
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = unknown>(): Promise<T | null>
  all<T = unknown>(): Promise<{ results?: T[]; success: boolean }>
  run(): Promise<{ success: boolean; meta?: { changes?: number } }>
}

// ──────────────── 返回类型（与 db/index.ts 保持一致） ────────────────

export type XdnmbIndexThreadInfo = {
  id: number
  fid: number | null
  title: string
  content: string
  replyCount: number
  lastReplyId: number
  sage: number
  admin: number
  indexedAt: string
}

export type XdnmbIndexPostInfo = {
  id: number
  threadId: number
  content: string
  userHash: string
  now: string
  sage: number
  admin: number
  indexedAt: string
}

export type XdnmbSearchHit = {
  id: number
  threadId: number
  title: string
  snippet: string
  now: string
  userHash: string
  isMain: boolean
}

export type XdnmbIndexCursorInfo = {
  kind: string
  targetId: string
  page: number
  round: number
  updatedAt: string
}

/** unixepoch 整数 → ISO 字符串（与 Neon TIMESTAMPTZ 输出保持一致） */
function isoFromEpoch(epoch: number | null | undefined): string {
  if (!epoch || epoch <= 0) return new Date(0).toISOString()
  return new Date(epoch * 1000).toISOString()
}

/**
 * 把用户查询转为 FTS5 trigram 短语查询。
 * trigram tokenizer 对 >= 3 字符的查询走倒排；< 3 字符回退内部 GLOB 扫描。
 * 用双引号包裹做字面短语匹配（等价于子串搜索），内部双引号转义为 ""。
 */
function ftsPhrase(q: string): string {
  return '"' + q.replace(/"/g, '""') + '"'
}

// ──────────────── 读路径（主站 shim 调用） ────────────────

/**
 * 全论坛搜索：在本地索引里按关键词查 threads.title/content 与 posts.content。
 * trigram FTS5 短语匹配 = 子串搜索（与原 Neon ILIKE %q% 行为一致）。
 * 返回 threadId 去重后的命中列表。
 */
export async function searchXdnmbIndexD1(
  db: D1Database,
  q: string,
  limit = 50,
): Promise<XdnmbSearchHit[]> {
  const term = q.trim().slice(0, 100)
  if (!term) return []
  const lmt = Math.max(1, Math.min(100, limit | 0))
  const phrase = ftsPhrase(term)

  // 主楼命中（threads_fts 命中 title 或 content）
  const threadRes = await db
    .prepare(
      `SELECT t.id, t.title, t.content
       FROM threads_fts
       JOIN xdnmb_index_threads t ON t.id = threads_fts.rowid
       WHERE threads_fts MATCH ?1 AND t.deleted_at IS NULL
       LIMIT ?2`,
    )
    .bind(phrase, lmt)
    .all<{ id: number; title: string; content: string }>()
    .catch(() => ({ results: [], success: false }))

  // 回复命中（posts_fts 命中 content，JOIN threads 取标题）
  const postRes = await db
    .prepare(
      `SELECT p.id, p.thread_id, p.content, p.user_hash, p.now, t.title
       FROM posts_fts
       JOIN xdnmb_index_posts p ON p.id = posts_fts.rowid
       JOIN xdnmb_index_threads t ON t.id = p.thread_id
       WHERE posts_fts MATCH ?1 AND p.deleted_at IS NULL AND t.deleted_at IS NULL
       LIMIT ?2`,
    )
    .bind(phrase, lmt * 2)
    .all<{ id: number; thread_id: number; content: string; user_hash: string; now: string; title: string }>()
    .catch(() => ({ results: [], success: false }))

  const seen = new Set<number>()
  const hits: XdnmbSearchHit[] = []
  for (const r of threadRes.results ?? []) {
    const tid = Number(r.id)
    if (seen.has(tid)) continue
    seen.add(tid)
    hits.push({
      id: tid,
      threadId: tid,
      title: r.title || '',
      snippet: (r.content || '').slice(0, 200),
      now: '',
      userHash: '',
      isMain: true,
    })
  }
  for (const r of postRes.results ?? []) {
    const tid = Number(r.thread_id)
    if (seen.has(tid)) continue
    seen.add(tid)
    hits.push({
      id: Number(r.id),
      threadId: tid,
      title: r.title || '',
      snippet: (r.content || '').slice(0, 200),
      now: r.now || '',
      userHash: r.user_hash || '',
      isMain: false,
    })
  }
  return hits.slice(0, lmt)
}

/** >>No.xxx 直跳核心：从楼层 ID 反查父串 ID */
export async function findXdnmbThreadByPostIdD1(
  db: D1Database,
  postId: number,
): Promise<{ threadId: number; post: XdnmbIndexPostInfo } | null> {
  const r = await db
    .prepare(
      `SELECT id, thread_id, content, user_hash, now, sage, admin, indexed_at
       FROM xdnmb_index_posts
       WHERE id = ?1 AND deleted_at IS NULL
       LIMIT 1`,
    )
    .bind(postId)
    .first<{
      id: number
      thread_id: number
      content: string
      user_hash: string
      now: string
      sage: number
      admin: number
      indexed_at: number
    }>()
  if (!r) return null
  return {
    threadId: Number(r.thread_id),
    post: {
      id: Number(r.id),
      threadId: Number(r.thread_id),
      content: r.content || '',
      userHash: r.user_hash || '',
      now: r.now || '',
      sage: Number(r.sage ?? 0),
      admin: Number(r.admin ?? 0),
      indexedAt: isoFromEpoch(r.indexed_at),
    },
  }
}

/** 取本地索引统计（前端显示覆盖量 + 爬虫健康度） */
export async function getXdnmbIndexStatsD1(db: D1Database): Promise<{
  threads: number
  posts: number
  cursors: number
  recrawlPending: number
  deletedThreads: number
  deletedPosts: number
}> {
  const [t, p, c, rq, dt, dp] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS c FROM xdnmb_index_threads WHERE deleted_at IS NULL').first<{ c: number }>(),
    db.prepare('SELECT COUNT(*) AS c FROM xdnmb_index_posts WHERE deleted_at IS NULL').first<{ c: number }>(),
    db.prepare('SELECT COUNT(*) AS c FROM xdnmb_index_cursors').first<{ c: number }>(),
    db.prepare("SELECT COUNT(*) AS c FROM xdnmb_index_recrawl_queue WHERE status='pending'").first<{ c: number }>(),
    db.prepare('SELECT COUNT(*) AS c FROM xdnmb_index_threads WHERE deleted_at IS NOT NULL').first<{ c: number }>(),
    db.prepare('SELECT COUNT(*) AS c FROM xdnmb_index_posts WHERE deleted_at IS NOT NULL').first<{ c: number }>(),
  ])
  return {
    threads: Number(t?.c ?? 0),
    posts: Number(p?.c ?? 0),
    cursors: Number(c?.c ?? 0),
    recrawlPending: Number(rq?.c ?? 0),
    deletedThreads: Number(dt?.c ?? 0),
    deletedPosts: Number(dp?.c ?? 0),
  }
}

/** 取一个串的已索引游标（lastReplyId / replyCount，用于增量判断） */
export async function getXdnmbIndexThreadD1(
  db: D1Database,
  id: number,
): Promise<XdnmbIndexThreadInfo | null> {
  const r = await db
    .prepare(
      `SELECT id, fid, title, content, reply_count, last_reply_id, sage, admin, indexed_at
       FROM xdnmb_index_threads
       WHERE id = ?1 AND deleted_at IS NULL
       LIMIT 1`,
    )
    .bind(id)
    .first<{
      id: number
      fid: number | null
      title: string
      content: string
      reply_count: number
      last_reply_id: number
      sage: number
      admin: number
      indexed_at: number
    }>()
  if (!r) return null
  return {
    id: Number(r.id),
    fid: r.fid == null ? null : Number(r.fid),
    title: r.title || '',
    content: r.content || '',
    replyCount: Number(r.reply_count ?? 0),
    lastReplyId: Number(r.last_reply_id ?? 0),
    sage: Number(r.sage ?? 0),
    admin: Number(r.admin ?? 0),
    indexedAt: isoFromEpoch(r.indexed_at),
  }
}

// ──────────────── 写路径（爬虫 Worker 调用） ────────────────

/** upsert 串主楼（爬虫调用） */
export async function upsertXdnmbIndexThreadD1(
  db: D1Database,
  input: {
    id: number
    fid?: number | null
    title?: string
    content?: string
    replyCount?: number
    lastReplyId?: number
    sage?: number
    admin?: number
  },
): Promise<void> {
  const id = Number(input.id)
  if (!Number.isFinite(id) || id <= 0) return
  await db
    .prepare(
      `INSERT INTO xdnmb_index_threads (id, fid, title, content, reply_count, last_reply_id, sage, admin, indexed_at, crawled_at, deleted_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, unixepoch(), unixepoch(), NULL)
       ON CONFLICT(id) DO UPDATE SET
         fid = COALESCE(excluded.fid, xdnmb_index_threads.fid),
         title = excluded.title,
         content = excluded.content,
         reply_count = excluded.reply_count,
         last_reply_id = excluded.last_reply_id,
         sage = excluded.sage,
         admin = excluded.admin,
         indexed_at = unixepoch(),
         deleted_at = NULL`,
    )
    .bind(
      id,
      input.fid ?? null,
      (input.title || '').slice(0, 200),
      (input.content || '').slice(0, 8000),
      Number(input.replyCount ?? 0),
      Number(input.lastReplyId ?? 0),
      Number(input.sage ?? 0),
      Number(input.admin ?? 0),
    )
    .run()
}

/** 批量 upsert 楼层（爬虫调用） */
export async function upsertXdnmbIndexPostsD1(
  db: D1Database,
  posts: Array<{
    id: number
    threadId: number
    content?: string
    userHash?: string
    now?: string
    sage?: number
    admin?: number
  }>,
): Promise<void> {
  const batch = posts.slice(0, 100)
  if (batch.length === 0) return
  // D1 单条 prepare + bind 最稳；批量用事务串行 run
  const stmt = db.prepare(
    `INSERT INTO xdnmb_index_posts (id, thread_id, content, user_hash, now, sage, admin, indexed_at, deleted_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, unixepoch(), NULL)
     ON CONFLICT(id) DO UPDATE SET
       thread_id = excluded.thread_id,
       content = excluded.content,
       user_hash = excluded.user_hash,
       now = excluded.now,
       sage = excluded.sage,
       admin = excluded.admin,
       indexed_at = unixepoch(),
       deleted_at = NULL`,
  )
  await Promise.all(
    batch.map((p) =>
      stmt
        .bind(
          Number(p.id),
          Number(p.threadId),
          (p.content || '').slice(0, 4000),
          (p.userHash || '').slice(0, 24),
          (p.now || '').slice(0, 40),
          Number(p.sage ?? 0),
          Number(p.admin ?? 0),
        )
        .run(),
    ),
  )
}

/** 取一个串所有已索引楼层 ID（回扫 diff 用） */
export async function getStoredPostIdsD1(db: D1Database, threadId: number): Promise<number[]> {
  const res = await db
    .prepare('SELECT id FROM xdnmb_index_posts WHERE thread_id = ?1 AND deleted_at IS NULL')
    .bind(threadId)
    .all<{ id: number }>()
  return (res.results ?? []).map((r) => Number(r.id))
}

/** 软删楼层（回扫 diff 发现缺失的楼层） */
export async function markPostsDeletedD1(db: D1Database, ids: number[]): Promise<void> {
  if (ids.length === 0) return
  // D1 不便于 IN (...) 绑定数组；逐条 update（量小，diff 缺失一般 < 50）
  const stmt = db.prepare(
    'UPDATE xdnmb_index_posts SET deleted_at = unixepoch() WHERE id = ?1 AND deleted_at IS NULL',
  )
  await Promise.all(ids.map((id) => stmt.bind(Number(id)).run()))
}

// ──────────────── 爬虫游标（cron 推进） ────────────────

export async function getXdnmbIndexCursorD1(
  db: D1Database,
  kind: string,
  targetId: string,
): Promise<XdnmbIndexCursorInfo | null> {
  const r = await db
    .prepare('SELECT kind, target_id, page, round, updated_at FROM xdnmb_index_cursors WHERE kind = ?1 AND target_id = ?2 LIMIT 1')
    .bind(String(kind), String(targetId))
    .first<{ kind: string; target_id: string; page: number; round: number; updated_at: number }>()
  if (!r) return null
  return {
    kind: r.kind,
    targetId: r.target_id,
    page: Number(r.page ?? 1),
    round: Number(r.round ?? 0),
    updatedAt: isoFromEpoch(r.updated_at),
  }
}

export async function upsertXdnmbIndexCursorD1(
  db: D1Database,
  input: { kind: string; targetId: string; page: number; round?: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO xdnmb_index_cursors (kind, target_id, page, round, updated_at)
       VALUES (?1, ?2, ?3, ?4, unixepoch())
       ON CONFLICT(kind, target_id) DO UPDATE SET
         page = excluded.page,
         round = excluded.round,
         updated_at = unixepoch()`,
    )
    // 注意：X岛 timeline/forum 的 id 是 JSON number（类型声明骗人），D1 会把
    // number 绑成 REAL，经 TEXT affinity 转成 '1.0'，导致 cursor 匹配分裂 — 统一 String 化
    .bind(String(input.kind), String(input.targetId), Number(input.page), Number(input.round ?? 0))
    .run()
}

export async function listXdnmbIndexCursorsD1(db: D1Database): Promise<XdnmbIndexCursorInfo[]> {
  const res = await db
    .prepare('SELECT kind, target_id, page, round, updated_at FROM xdnmb_index_cursors')
    .all<{ kind: string; target_id: string; page: number; round: number; updated_at: number }>()
  return (res.results ?? []).map((r) => ({
    kind: r.kind,
    targetId: r.target_id,
    page: Number(r.page ?? 1),
    round: Number(r.round ?? 0),
    updatedAt: isoFromEpoch(r.updated_at),
  }))
}

// ──────────────── catalog 全量扫描游标（6h cron） ────────────────
// 复用 cursors 表：kind='catalog', target_id='all'
// page = forum 在列表中的索引，round = 该 forum 内的页码

export async function getCatalogCursorD1(
  db: D1Database,
): Promise<{ forumIdx: number; page: number; updatedAt: string }> {
  const r = await db
    .prepare("SELECT page, round, updated_at FROM xdnmb_index_cursors WHERE kind='catalog' AND target_id='all' LIMIT 1")
    .first<{ page: number; round: number; updated_at: number }>()
  if (!r) return { forumIdx: 0, page: 1, updatedAt: new Date(0).toISOString() }
  return { forumIdx: Number(r.page ?? 0), page: Number(r.round ?? 1), updatedAt: isoFromEpoch(r.updated_at) }
}

export async function saveCatalogCursorD1(
  db: D1Database,
  forumIdx: number,
  page: number,
): Promise<void> {
  await upsertXdnmbIndexCursorD1(db, { kind: 'catalog', targetId: 'all', page: forumIdx, round: page })
}

// ──────────────── 回扫队列（删帖 diff） ────────────────

/** 入队回扫（串已爬成功后 dueAt = now + 7d；catalog 发现新串 dueAt = 0 立即） */
export async function upsertRecrawlD1(db: D1Database, threadId: number, dueAt: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO xdnmb_index_recrawl_queue (thread_id, due_at, status, attempts, updated_at)
       VALUES (?1, ?2, 'pending', 0, unixepoch())
       ON CONFLICT(thread_id) DO UPDATE SET
         due_at = excluded.due_at,
         status = 'pending',
         updated_at = unixepoch()`,
    )
    .bind(Number(threadId), Number(dueAt))
    .run()
}

/** 批量无条件入队回扫（timeline 爬完后用；串已成功索引，必须安排 7 天后 diff） */
export async function upsertRecrawlBatchD1(
  db: D1Database,
  items: Array<{ tid: number; dueAt: number }>,
): Promise<void> {
  const valid = items.filter((it) => Number.isFinite(it.tid) && it.tid > 0)
  if (!valid.length) return
  const binds: number[] = []
  for (const it of valid) binds.push(Math.trunc(it.tid), Math.trunc(it.dueAt))
  const rows = valid.map(() => '(?, ?)').join(',')
  await db
    .prepare(
      `WITH v(tid, due) AS (VALUES ${rows})
       INSERT INTO xdnmb_index_recrawl_queue (thread_id, due_at, status, attempts, updated_at)
       SELECT v.tid, v.due, 'pending', 0, unixepoch() FROM v
       ON CONFLICT(thread_id) DO UPDATE SET
         due_at = excluded.due_at,
         status = 'pending',
         updated_at = unixepoch()`,
    )
    .bind(...binds)
    .run()
}

/**
 * 批量条件入队回扫（D1 免费计划每 invocation 限 50 次查询，逐条必爆）。
 * 只对「索引中不存在 / deleted / reply_count 落后」的串入队；已入队取更早 due_at。
 * 返回实际入队行数。
 */
export async function enqueueRecrawlIfStaleD1(
  db: D1Database,
  items: Array<{ tid: number; replyCount: number; dueAt: number }>,
): Promise<number> {
  const valid = items.filter((it) => Number.isFinite(it.tid) && it.tid > 0)
  if (!valid.length) return 0
  const binds: number[] = []
  for (const it of valid) binds.push(Math.trunc(it.tid), Math.max(0, Math.trunc(it.replyCount) || 0), Math.trunc(it.dueAt))
  const rows = valid.map(() => '(?, ?, ?)').join(',')
  const res = await db
    .prepare(
      `WITH v(tid, rc, due) AS (VALUES ${rows})
       INSERT INTO xdnmb_index_recrawl_queue (thread_id, due_at, status, attempts, updated_at)
       SELECT v.tid, v.due, 'pending', 0, unixepoch() FROM v
       WHERE NOT EXISTS (
         SELECT 1 FROM xdnmb_index_threads t
         WHERE t.id = v.tid AND t.deleted_at IS NULL AND t.reply_count >= v.rc
       )
       ON CONFLICT(thread_id) DO UPDATE SET
         due_at = MIN(excluded.due_at, due_at),
         status = 'pending',
         updated_at = unixepoch()`,
    )
    .bind(...binds)
    .run()
  return Number(res.meta?.changes ?? 0)
}

/** 批量取串元信息（增量跳过判断用；1 次查询替代逐串查询） */
export async function getThreadsMetaByIdsD1(
  db: D1Database,
  ids: number[],
): Promise<Map<number, { replyCount: number; lastReplyId: number }>> {
  const out = new Map<number, { replyCount: number; lastReplyId: number }>()
  const valid = ids.filter((id) => Number.isFinite(id) && id > 0)
  if (!valid.length) return out
  const res = await db
    .prepare(
      `SELECT id, reply_count, last_reply_id FROM xdnmb_index_threads
       WHERE deleted_at IS NULL AND id IN (${valid.map(() => '?').join(',')})`,
    )
    .bind(...valid.map((id) => Math.trunc(id)))
    .all<{ id: number; reply_count: number; last_reply_id: number }>()
  for (const r of res.results ?? []) {
    out.set(Number(r.id), { replyCount: Number(r.reply_count ?? 0), lastReplyId: Number(r.last_reply_id ?? 0) })
  }
  return out
}

/** 认领到期的回扫任务（SELECT ... WHERE due_at <= now AND status='pending' LIMIT ?） */
export async function claimRecrawlD1(
  db: D1Database,
  now: number,
  limit: number,
): Promise<Array<{ threadId: number; attempts: number }>> {
  const res = await db
    .prepare(
      `SELECT thread_id, attempts FROM xdnmb_index_recrawl_queue
       WHERE due_at <= ?1 AND status = 'pending'
       ORDER BY due_at ASC
       LIMIT ?2`,
    )
    .bind(now, Math.max(1, Math.min(50, limit | 0)))
    .all<{ thread_id: number; attempts: number }>()
  return (res.results ?? []).map((r) => ({ threadId: Number(r.thread_id), attempts: Number(r.attempts ?? 0) }))
}

/** 回扫完成：标记 done + 安排下次回扫（默认 7 天后） */
export async function markRecrawlDoneD1(db: D1Database, threadId: number, nextDueAt: number): Promise<void> {
  await db
    .prepare(
      `UPDATE xdnmb_index_recrawl_queue
       SET status = 'done', due_at = ?1, attempts = 0, updated_at = unixepoch()
       WHERE thread_id = ?2`,
    )
    .bind(Number(nextDueAt), Number(threadId))
    .run()
}

/** 回扫失败：1 小时后重试，attempts + 1（超过 5 次放弃，标 failed） */
export async function markRecrawlRetryD1(db: D1Database, threadId: number, retryDueAt: number): Promise<void> {
  await db
    .prepare(
      `UPDATE xdnmb_index_recrawl_queue
       SET due_at = ?1, attempts = attempts + 1,
           status = CASE WHEN attempts + 1 >= 5 THEN 'failed' ELSE 'pending' END,
           updated_at = unixepoch()
       WHERE thread_id = ?2`,
    )
    .bind(Number(retryDueAt), Number(threadId))
    .run()
}

// ──────────────── 设置（crawler userhash） ────────────────

export async function settingsGetUserhashD1(db: D1Database): Promise<string> {
  const r = await db
    .prepare('SELECT xdnmb_userhash FROM settings WHERE id = 1 LIMIT 1')
    .first<{ xdnmb_userhash: string }>()
  return r?.xdnmb_userhash ?? ''
}

export async function settingsSetUserhashD1(db: D1Database, userhash: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (id, xdnmb_userhash, updated_at)
       VALUES (1, ?1, unixepoch())
       ON CONFLICT(id) DO UPDATE SET xdnmb_userhash = excluded.xdnmb_userhash, updated_at = unixepoch()`,
    )
    .bind(userhash)
    .run()
}
