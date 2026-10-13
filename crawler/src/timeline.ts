/**
 * X岛时间线增量爬虫（从主站 xdnmb-crawler.ts 迁移，db 调用改 D1）。
 *
 * 策略：每次 5min cron 爬一条时间线的一页（≈10 个串），全量爬一轮
 * ≈ 7 timelines × ~10 pages = 70 cron = ~6 小时。历史串爬完后，
 * 新串随时间线持续推进自动进入索引。
 *
 * 预算（X岛 subrequest）：1 timeline list + 1 timeline page + 10 threads × 2 fetch = 22，
 * 留余量给 recrawl（5 × 2 = 10），总 32 < 50。
 * D1 查询（免费计划每 invocation 限 50）：settings 1 + cursors 1 + 批量预检 1
 * + 每串 2（主楼 + 楼层）×10 + 回扫入队 1 + 推进 1 ≈ 25。
 */
import {
  getTimelineList,
  showTimeline,
  getThread,
  toPlain,
  type XdGateway,
  type XPost,
  type XTimeline,
} from '../../src/lib/xdnmb-api.js'
import {
  upsertXdnmbIndexThreadD1,
  upsertXdnmbIndexPostsD1,
  getThreadsMetaByIdsD1,
  upsertXdnmbIndexCursorD1,
  listXdnmbIndexCursorsD1,
  settingsGetUserhashD1,
  upsertRecrawlBatchD1,
  type D1Database,
  type XdnmbIndexCursorInfo,
} from '../../db/d1.js'

const PAGE_TOO_LARGE = 999 // 超界页 X 岛按惯例返回最后一页
const PAGE_SIZE = 19 // X 岛每页 19 条回复
const THREADS_PER_CRON = 10 // 减半以腾出 subrequest 预算给 recrawl

export interface CrawlResult {
  timeline: { id: string; name: string; page: number; threads: number; posts: number }
  errors: number
}

/** 取主楼标题（无标题则用首行 60 字） */
function threadTitleFrom(p: XPost): string {
  const t = (p.title || '').trim()
  if (t) return t.slice(0, 200)
  return toPlain(p.content).split('\n')[0].slice(0, 60) || ''
}

/**
 * 爬取单个串并完整写入索引（主楼 + 首页/末页楼层）。
 * 供 timeline 增量与 recrawl 新串索引用。失败抛错由调用方处理。
 * 返回索引的楼层数。
 */
export async function indexThread(
  db: D1Database,
  gw: XdGateway | null,
  userhash: string,
  tid: number,
): Promise<number> {
  const firstPage = await getThread(String(tid), 1, userhash, gw)
  const threadTitle = threadTitleFrom(firstPage)
  const mainPost: XPost = { ...firstPage }
  const allPosts: XPost[] = [mainPost, ...(firstPage.Replies || [])]
  let lastReplyId = tid
  for (const r of allPosts) {
    if (r.id > lastReplyId) lastReplyId = r.id
  }
  const replyCount = Number(firstPage.ReplyCount ?? 0)

  // 快速模式：末页（最新回复），仅当回复数 > 一页才取
  if (replyCount > PAGE_SIZE) {
    try {
      const lastPage = await getThread(String(tid), PAGE_TOO_LARGE, userhash, gw)
      for (const r of lastPage.Replies || []) {
        allPosts.push(r)
        if (r.id > lastReplyId) lastReplyId = r.id
      }
      if (lastPage.fid != null) mainPost.fid = lastPage.fid
    } catch { /* 末页取不到不影响主索引，下轮再试 */ }
  }

  // upsert 串主楼
  await upsertXdnmbIndexThreadD1(db, {
    id: tid,
    fid: mainPost.fid ?? null,
    title: threadTitle,
    content: toPlain(mainPost.content),
    replyCount,
    lastReplyId,
    sage: Number(mainPost.sage ?? 0),
    admin: Number(mainPost.admin ?? 0),
  })

  // upsert 楼层（主楼 + 所有回复；去重）
  const seen = new Set<number>()
  const batch: Array<{
    id: number
    threadId: number
    content: string
    userHash: string
    now: string
    sage: number
    admin: number
  }> = []
  for (const r of allPosts) {
    const rid = Number(r.id)
    if (!Number.isFinite(rid) || rid <= 0 || seen.has(rid)) continue
    seen.add(rid)
    // Tips 系统提示不算搜索内容
    if (r.user_hash === 'Tips') continue
    batch.push({
      id: rid,
      threadId: tid,
      content: toPlain(r.content),
      userHash: String(r.user_hash || '').slice(0, 24),
      now: String(r.now || '').slice(0, 40),
      sage: Number(r.sage ?? 0),
      admin: Number(r.admin ?? 0),
    })
  }
  if (batch.length) {
    await upsertXdnmbIndexPostsD1(db, batch)
  }
  return batch.length
}

export async function runTimelineCycle(
  db: D1Database,
  gw: XdGateway | null,
): Promise<CrawlResult | null> {
  const userhash = await settingsGetUserhashD1(db)

  const timelines = await getTimelineList(gw)
  if (!timelines.length) return null

  // ── 选目标时间线：最久未爬优先（无 cursor 的最先爬，做初始种子） ──
  // X岛 timeline id 是 JSON number，必须 String 化后才能与 cursor.targetId 匹配
  const cursors = await listXdnmbIndexCursorsD1(db)
  const tlCursorMap = new Map(
    cursors.filter((c) => c.kind === 'timeline').map((c) => [String(c.targetId).replace(/\.0$/, ''), c]),
  )
  let target: XTimeline | null = null
  let targetCursor: XdnmbIndexCursorInfo | null = null
  let oldest = Number.POSITIVE_INFINITY
  for (const tl of timelines) {
    const cur = tlCursorMap.get(String(tl.id).replace(/\.0$/, '')) || null
    const ts = cur ? new Date(cur.updatedAt).getTime() : 0
    if (ts < oldest) {
      oldest = ts
      target = tl
      targetCursor = cur
    }
  }
  if (!target) return null

  const page = targetCursor?.page ?? 1
  const round = targetCursor?.round ?? 0
  let posts = 0
  let threads = 0
  let errors = 0

  let postsList: XPost[]
  try {
    postsList = await showTimeline(target.id, page, userhash, gw)
  } catch {
    // 时间线取不到：可能是 page 超界，回退第 1 页 + 新一轮
    await upsertXdnmbIndexCursorD1(db, { kind: 'timeline', targetId: String(target.id), page: 1, round: round + 1 })
    return { timeline: { id: String(target.id), name: target.name, page, threads: 0, posts: 0 }, errors: 1 }
  }
  if (!postsList.length) {
    // 空页 = 该时间线已爬到末尾，回 1 + 轮次 +1
    await upsertXdnmbIndexCursorD1(db, { kind: 'timeline', targetId: String(target.id), page: 1, round: round + 1 })
    return { timeline: { id: String(target.id), name: target.name, page, threads: 0, posts: 0 }, errors: 0 }
  }

  // ── 逐串索引（最多 THREADS_PER_CRON 个，防超时） ──
  // 批量预检（1 次查询替代逐串查询；D1 免费计划每 invocation 限 50 次查询）
  const candidates = postsList
    .slice(0, THREADS_PER_CRON)
    .map((p) => Number(p.id))
    .filter((tid) => Number.isFinite(tid) && tid > 0)
  const metas = await getThreadsMetaByIdsD1(db, candidates)
  const recrawled: Array<{ tid: number; dueAt: number }> = []
  const nowSec = Math.floor(Date.now() / 1000)

  for (const p of postsList.slice(0, THREADS_PER_CRON)) {
    const tid = Number(p.id)
    if (!Number.isFinite(tid) || tid <= 0) continue
    const fullCount = Number(p.ReplyCount ?? 0)
    const existing = metas.get(tid)
    // 增量跳过：已索引且 reply_count 与时间线快照一致 → 该串自上次爬取后无新回复
    if (existing && existing.replyCount === fullCount && existing.lastReplyId > 0) {
      continue
    }

    try {
      posts += await indexThread(db, gw, userhash, tid)
      // 记入批量回扫队列（7 天后删帖 diff），统一在循环末尾一次写入
      recrawled.push({ tid, dueAt: nowSec + 7 * 24 * 3600 })
      threads++
    } catch {
      errors++
    }
  }

  // 批量入队回扫（1 次查询；串已成功索引，无条件安排 7 天后 diff）
  if (recrawled.length) {
    try {
      await upsertRecrawlBatchD1(db, recrawled)
    } catch { /* 入队失败不影响索引数据 */ }
  }

  // 推进游标
  await upsertXdnmbIndexCursorD1(db, {
    kind: 'timeline',
    targetId: String(target.id),
    page: page + 1,
    round,
  })

  return {
    timeline: { id: String(target.id), name: target.name, page, threads, posts },
    errors,
  }
}
