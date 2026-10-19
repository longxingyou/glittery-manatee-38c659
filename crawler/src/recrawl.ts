/**
 * 删帖 diff 回扫：定期重新拉串首页+末页，diff 楼层 ID 集合，
 * 缺失的标记 deleted_at。每 5min cron 内剩余预算做 8 个串。
 *
 * 预算：8 threads × 2 fetch = 16 subrequest，加 timeline 22 = 38 < 50。
 */
import { getThread, type XdGateway } from '../../src/lib/xdnmb-api.js'
import {
  claimRecrawlD1,
  markRecrawlDoneD1,
  markRecrawlRetryD1,
  getStoredPostIdsD1,
  markPostsDeletedD1,
  settingsGetUserhashD1,
  getThreadsMetaByIdsD1,
  type D1Database,
} from '../../db/d1.js'
import { indexThread } from './timeline.js'

const PAGE_TOO_LARGE = 999
const RECRAWL_INTERVAL_SEC = 7 * 24 * 3600 // 7 天后再次回扫

export interface RecrawlResult {
  scanned: number
  indexed: number
  deletedPosts: number
  errors: number
}

export async function runRecrawlCycle(
  db: D1Database,
  gw: XdGateway | null,
  limit = 5,
): Promise<RecrawlResult> {
  const userhash = await settingsGetUserhashD1(db)
  const nowSec = Math.floor(Date.now() / 1000)

  const tasks = await claimRecrawlD1(db, nowSec, limit)
  let scanned = 0
  let indexed = 0
  let deletedPosts = 0
  let errors = 0

  // 批量区分：catalog 发现的未索引新串（需完整索引）vs 已索引串（做删帖 diff）
  const metas = await getThreadsMetaByIdsD1(
    db,
    tasks.map((t) => t.threadId),
  )

  for (const task of tasks) {
    const tid = task.threadId
    try {
      if (!metas.has(tid)) {
        // catalog 发现的新串：完整索引（刚爬的内容必然是活的，无需 diff）
        await indexThread(db, gw, userhash, tid)
        indexed++
        await markRecrawlDoneD1(db, tid, nowSec + RECRAWL_INTERVAL_SEC)
        scanned++
        continue
      }

      // 已索引串：取首页（主楼 + 前 19 条回复）
      const firstPage = await getThread(String(tid), 1, userhash, gw)
      const liveIds = new Set<number>([tid]) // 主楼 ID
      for (const r of firstPage.Replies || []) {
        liveIds.add(Number(r.id))
      }

      // 取末页（最新回复）
      const replyCount = Number(firstPage.ReplyCount ?? 0)
      if (replyCount > 19) {
        try {
          const lastPage = await getThread(String(tid), PAGE_TOO_LARGE, userhash, gw)
          for (const r of lastPage.Replies || []) {
            liveIds.add(Number(r.id))
          }
        } catch { /* 末页取不到：用首页数据做 diff */ }
      }

      // diff：已索引但不在 live set 中的 → 已删帖
      const storedIds = await getStoredPostIdsD1(db, tid)
      const deletedIds = storedIds.filter((id) => !liveIds.has(id))
      if (deletedIds.length > 0) {
        await markPostsDeletedD1(db, deletedIds)
        deletedPosts += deletedIds.length
      }

      // 标记完成 + 安排下次回扫
      await markRecrawlDoneD1(db, tid, nowSec + RECRAWL_INTERVAL_SEC)
      scanned++
    } catch {
      // 1 小时后重试（超过 5 次放弃，标 failed）
      await markRecrawlRetryD1(db, tid, nowSec + 3600)
      errors++
    }
  }

  return { scanned, indexed, deletedPosts, errors }
}
