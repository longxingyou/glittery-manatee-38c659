/**
 * 版面 catalog 全枚举：每 6h cron 遍历版面翻页，发现新串或
 * reply_count 落后的按 tid 稳定摊平入队 recrawl。
 *
 * cursor 续传：每轮只跑 CATALOG_BUDGET 个版面页（subrequest），
 * 下次 6h cron 从上次位置继续。D1 调用不计 subrequest 上限。
 *
 * 预算：每轮最多 45 subrequest（留 5 余量），约 5 版面 × 10 页。
 */
import {
  getForums,
  showForum,
  type XdGateway,
  type XForumGroup,
} from '../../src/lib/xdnmb-api.js'
import {
  getCatalogCursorD1,
  saveCatalogCursorD1,
  enqueueRecrawlIfStaleD1,
  settingsGetUserhashD1,
  type D1Database,
} from '../../db/d1.js'

const CATALOG_BUDGET = 40 // X岛 subrequest + D1 查询双预算（留 10 余量）
/**
 * 未收录串的排期窗口：4 天。按 tid 稳定取模摊平，避免整批 due=0 挤爆回扫预算。
 * 窗口 ≈ 积压量 / 日消化能力（Worker 约 2300 + GitHub 队列消化器约 3000）。
 */
const RECRAWL_SPREAD_SEC = 4 * 24 * 3600

export interface CatalogResult {
  forumsScanned: number
  threadsQueued: number
  errors: number
}

/** 展平版面分组 → 版面 ID 列表 */
function flattenForumIds(groups: XForumGroup[]): string[] {
  const ids: string[] = []
  for (const g of groups) {
    for (const f of g.forums || []) {
      if (f.id) ids.push(f.id)
    }
  }
  return ids
}

export async function runCatalogCycle(
  db: D1Database,
  gw: XdGateway | null,
): Promise<CatalogResult> {
  const userhash = await settingsGetUserhashD1(db)

  let forums: XForumGroup[]
  try {
    forums = await getForums(userhash, gw)
  } catch {
    return { forumsScanned: 0, threadsQueued: 0, errors: 1 }
  }

  const fids = flattenForumIds(forums)
  if (!fids.length) return { forumsScanned: 0, threadsQueued: 0, errors: 0 }

  const cursor = await getCatalogCursorD1(db)
  let budget = CATALOG_BUDGET
  let forumsScanned = 0
  let threadsQueued = 0
  let errors = 0

  while (budget > 0 && cursor.forumIdx < fids.length) {
    const fid = fids[cursor.forumIdx]
    let posts
    try {
      posts = await showForum(fid, cursor.page, userhash, gw)
    } catch {
      errors++
      cursor.forumIdx++
      cursor.page = 1
      continue
    }
    budget--

    if (!posts.length) {
      // 空页 = 该版面已扫完，移到下一版面
      cursor.forumIdx++
      cursor.page = 1
      continue
    }

    // 批量条件入队（1 次查询/页）：新串 / deleted / reply_count 落后 → 立即待爬
    // 按 tid 稳定摊到未来 4 天（≈4700/天）而非 due=0：整批"立即到期"会挤爆
    // 回扫预算，导致 7 天的删帖 diff 永远排不上队。
    const nowSec = Math.floor(Date.now() / 1000)
    const items = posts
      .map((p) => {
        const tid = Number(p.id)
        return { tid, replyCount: Number(p.ReplyCount ?? 0), dueAt: nowSec + (tid % RECRAWL_SPREAD_SEC) }
      })
      .filter((it) => Number.isFinite(it.tid) && it.tid > 0)
    if (items.length) {
      try {
        threadsQueued += await enqueueRecrawlIfStaleD1(db, items)
      } catch {
        errors++
      }
    }

    cursor.page++
    forumsScanned++
  }

  await saveCatalogCursorD1(db, cursor.forumIdx, cursor.page)

  return { forumsScanned, threadsQueued, errors }
}
