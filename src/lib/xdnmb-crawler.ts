/**
 * @deprecated 爬虫已搬到独立 Worker（crawler/src/timeline.ts），使用 D1 而非 Neon。
 * 主站 cron 不再调用 crawlXdnmbIndex。此文件保留作为历史参考。
 *
 * X 岛本地搜索索引爬虫（worker.ts scheduled 每 5 分钟调用一次）。
 *
 * 设计目标：
 * - 解决 >>No.xxx 直跳：本地索引 posts.thread_id 反查父串
 * - 全论坛搜索：覆盖时间线/版面所有公开串（比 nmb-search 覆盖面更广）
 *
 * 爬取策略（每次 cron 一小步，分摊到多个周期）：
 * 1. 从 7 条时间线里挑"最久未爬"的那条
 * 2. 按该时间线的 cursor.page 取下一页（≈ 20 个串）
 * 3. 对每个串：
 *    a. 检查索引中是否已有且 last_reply_id 未变（增量跳过）
 *    b. 若需更新：取首页（主楼+前 19 条）+ 末页（最新回复）
 *    c. upsert thread 主楼行 + 所有 posts 楼层行
 * 4. 推进 cursor.page（空页则回 1、轮次 +1）
 *
 * 预算：1 + 20×2 = 41 次 X岛 API 调用/cron，5 分钟预算充裕。
 * 全量爬一轮 ≈ 7 timelines × ~10 pages = 70 cron = ~6 小时。
 * 历史串爬完后，新串会随时间线持续推进自动进入索引。
 */
import * as db from '../../db/index.js'
import { getThread, getTimelineList, showTimeline } from './xdnmb-server.js'
import type { XPost, XTimeline } from './xdnmb-types.js'

const PAGE_TOO_LARGE = 999 // 超界页 X 岛按惯例返回最后一页
const PAGE_SIZE = 19 // X 岛每页 19 条回复
const THREADS_PER_CRON = 20 // 单次 cron 最多处理的串数（防超时）
const REPLY_PREVIEW_CAP = 4000 // 单楼纯文本最大保存长度（与 db schema 一致）

/** 把 X 岛 HTML 片段转纯文本（搜索索引用，不需要保留任何标签） */
function toPlain(html: string): string {
  if (!html) return ''
  // 先把 <br> 转 \n，<p>/<div> 块级标签也补 \n，再统一剥标签
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&bull;/g, '•')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, REPLY_PREVIEW_CAP)
}

/** 取主楼标题（无标题则用首行 60 字） */
function threadTitleFrom(p: XPost): string {
  const t = (p.title || '').trim()
  if (t) return t.slice(0, 200)
  return toPlain(p.content).split('\n')[0].slice(0, 60) || ''
}

interface CrawlResult {
  timeline: { id: string; name: string; page: number; threads: number; posts: number }
  errors: number
}

interface CrawlThreadResult {
  tid: number
  title: string
  posts: number
  replyCount: number
  lastReplyId: number
  /** 深度索引模式下：下一批应开始的页码（null=已全部爬完） */
  nextPage?: number | null
  error?: string
}

/**
 * 爬取单个串并写入索引。
 *
 * 默认模式（quick）：首页主楼 + 前 19 条回复 + 末页最新回复（适合 cron 增量跟进）。
 * 深度模式（options.deep）：从 startPage 起逐页爬取，每批最多 maxPages 页，
 *   适合管理员手动全量索引长串（回复数多的串中间楼层也能被搜索到）。
 *   返回 nextPage：若非 null，调用方应再调一次以继续爬剩余页。
 *
 * 失败时不抛错，返回 error 字段，由调用方决定如何处理。
 */
export async function crawlThread(
  tid: number,
  userhash: string,
  options?: { deep?: boolean; startPage?: number; maxPages?: number },
): Promise<CrawlThreadResult> {
  const result: CrawlThreadResult = { tid, title: '', posts: 0, replyCount: 0, lastReplyId: tid }
  try {
    // 取首页（主楼 + 前 19 条回复；深度模式从 startPage 起跳过首页以节省配额，
    // 但首页仍需取一次以拿到主楼 fid/title/sage/admin + ReplyCount 总数）
    const firstPage = await getThread(String(tid), 1, userhash)
    const threadTitle = threadTitleFrom(firstPage)
    const mainPost: XPost = { ...firstPage }
    const allPosts: XPost[] = [mainPost, ...(firstPage.Replies || [])]
    let lastReplyId = tid // 主楼 ID 作为下界
    for (const r of allPosts) {
      if (r.id > lastReplyId) lastReplyId = r.id
    }
    const fullCount = Number(firstPage.ReplyCount ?? 0)
    const lastPageNum = Math.max(1, Math.ceil(fullCount / PAGE_SIZE))

    if (options?.deep) {
      // 深度模式：逐页爬取中段楼层（首页与末页已在 allPosts 中，跳过重复）
      const maxPages = Math.min(50, Math.max(1, options.maxPages ?? 20))
      const startPage = Math.max(2, options.startPage ?? 2)
      const endPage = Math.min(lastPageNum, startPage + maxPages - 1)
      for (let pg = startPage; pg <= endPage; pg++) {
        try {
          const page = await getThread(String(tid), pg, userhash)
          for (const r of page.Replies || []) {
            allPosts.push(r)
            if (r.id > lastReplyId) lastReplyId = r.id
          }
        } catch { /* 单页失败不影响其他页 */ }
      }
      // 若还有更多页未爬，返回下一批起点
      if (endPage < lastPageNum) {
        result.nextPage = endPage + 1
      } else {
        result.nextPage = null
      }
    } else {
      // 快速模式：末页（最新回复），仅当回复数 > 一页才取
      if (fullCount > PAGE_SIZE) {
        try {
          const lastPage = await getThread(String(tid), PAGE_TOO_LARGE, userhash)
          const lastReplies = lastPage.Replies || []
          for (const r of lastReplies) {
            allPosts.push(r)
            if (r.id > lastReplyId) lastReplyId = r.id
          }
          if (lastPage.fid != null) mainPost.fid = lastPage.fid
        } catch { /* 末页取不到不影响主索引，下轮再试 */ }
      }
    }

    // ── upsert 串主楼 ──
    await db.upsertXdnmbIndexThread({
      id: tid,
      fid: mainPost.fid ?? null,
      title: threadTitle,
      content: toPlain(mainPost.content),
      replyCount: fullCount,
      lastReplyId,
      sage: Number(mainPost.sage ?? 0),
      admin: Number(mainPost.admin ?? 0),
    })

    // ── upsert 楼层（主楼 + 所有回复；主楼 id == thread_id） ──
    // 去重：同一楼可能在首页与末页/中段页都出现
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
      // Tips 系统提示不算搜索内容（"该串不存在"等）
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
      await db.upsertXdnmbIndexPosts(batch)
      result.posts = batch.length
    }
    result.title = threadTitle
    result.replyCount = fullCount
    result.lastReplyId = lastReplyId
    return result
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e)
    return result
  }
}

/**
 * 主入口：每 5 分钟由 worker.ts cron 调用一次。
 * 内部自吞错误，单次失败不影响其他订阅/cron 路径。
 */
export async function crawlXdnmbIndex(): Promise<CrawlResult | null> {
  if (!db.isDbConfigured()) return null
  const { userhash } = await db.getXdnmbSettings()

  const timelines = await getTimelineList()
  if (!timelines.length) return null

  // ── 选目标时间线：最久未爬优先（无 cursor 的最先爬，做初始种子） ──
  const cursors = await db.listXdnmbIndexCursors()
  const tlCursorMap = new Map(
    cursors.filter((c) => c.kind === 'timeline').map((c) => [c.targetId, c]),
  )
  let target: XTimeline | null = null
  let targetCursor = null as db.XdnmbIndexCursorInfo | null
  let oldest = Number.POSITIVE_INFINITY
  for (const tl of timelines) {
    const cur = tlCursorMap.get(tl.id) || null
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
    postsList = await showTimeline(target.id, page, userhash)
  } catch {
    // 时间线取不到：可能是 page 超界，回退第 1 页 + 新一轮
    await db.upsertXdnmbIndexCursor({ kind: 'timeline', targetId: target.id, page: 1, round: round + 1 })
    return { timeline: { id: target.id, name: target.name, page, threads: 0, posts: 0 }, errors: 1 }
  }
  if (!postsList.length) {
    // 空页 = 该时间线已爬到末尾，回 1 + 轮次 +1
    await db.upsertXdnmbIndexCursor({ kind: 'timeline', targetId: target.id, page: 1, round: round + 1 })
    return { timeline: { id: target.id, name: target.name, page, threads: 0, posts: 0 }, errors: 0 }
  }

  // ── 逐串索引（最多 THREADS_PER_CRON 个，防超时） ──
  for (const p of postsList.slice(0, THREADS_PER_CRON)) {
    const tid = Number(p.id)
    if (!Number.isFinite(tid) || tid <= 0) continue
    const fullCount = Number(p.ReplyCount ?? 0)
    const existing = await db.getXdnmbIndexThread(tid)
    // 增量跳过：已索引且 reply_count 与时间线快照一致 → 该串自上次爬取后无新回复
    // （注意：时间线返回的 ReplyCount 是订阅时的快照，可能与最新值有偏差，
    //  但作为增量判断够用——若偏差，下一轮会重新爬一次）
    if (existing && existing.replyCount === fullCount && existing.lastReplyId > 0) {
      continue
    }
    const r = await crawlThread(tid, userhash)
    if (r.error) errors++
    else {
      threads++
      posts += r.posts
    }
  }

  // ── 推进游标：page+1（下一轮 cron 爬下一条时间线的下一页） ──
  await db.upsertXdnmbIndexCursor({
    kind: 'timeline',
    targetId: target.id,
    page: page + 1,
    round,
  })

  return {
    timeline: { id: target.id, name: target.name, page, threads, posts },
    errors,
  }
}
