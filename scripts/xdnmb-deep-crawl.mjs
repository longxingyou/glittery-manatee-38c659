/**
 * X岛批量爬取（GitHub Actions 运行）。两种模式（MODE 环境变量）：
 *
 *   MODE=parse（默认）：长串深度爬取（weekly cron）
 *     Worker 的 5min timeline cron 只取首页+末页（快速模式），回复数 > 200 的
 *     长串中段楼层不会被索引。此模式逐页爬取长串所有楼层，通过 D1 REST API 写入。
 *     算法：查 reply_count > 200 且已索引楼层数 < reply_count 的串 → 逐页爬取 →
 *     每批最多 50 个串，每串最多 100 页。
 *
 *   MODE=queue：回扫队列消化器（每 2h cron）
 *     认领 xdnmb_index_recrawl_queue 中 status='pending' 且已到期的串（due_at 升序），
 *     完整爬取后标 done（下次 due = now + 7d）；失败退避 6h，attempts ≥ 5 标 failed。
 *     catalog 扫到但尚未收录的积压串即由此消化，直接扩大搜索覆盖。
 *
 * 环境变量：
 *   MODE                     运行模式：parse（默认）| queue
 *   QUEUE_LIMIT              queue 模式每轮认领上限（默认 200）
 *   QUEUE_CONCURRENCY        queue 模式并发串数（默认 4）
 *   CLOUDFLARE_API_TOKEN    有 D1 写权限的 API token
 *   CLOUDFLARE_ACCOUNT_ID   Cloudflare 账号 ID
 *   D1_DATABASE_ID          xdnmb-index 的 database_id
 *   XDNMB_USERHASH          X岛饼干
 *   TG_GATEWAY_URL          可选，Azure 网关地址
 *   TG_GATEWAY_SECRET       可选，网关 HMAC 密钥
 *
 * 用法（本地测试）：
 *   $env:CLOUDFLARE_API_TOKEN='...'; $env:CLOUDFLARE_ACCOUNT_ID='...'; $env:D1_DATABASE_ID='...'; $env:XDNMB_USERHASH='...'; node scripts/xdnmb-deep-crawl.mjs
 */
import crypto from 'node:crypto'

const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID
const D1_DATABASE_ID = process.env.D1_DATABASE_ID
const XDNMB_USERHASH = process.env.XDNMB_USERHASH || ''
const GW_URL = (process.env.TG_GATEWAY_URL || '').trim().replace(/\/+$/, '')
const GW_SECRET = process.env.TG_GATEWAY_SECRET || ''

if (!CF_API_TOKEN || !CF_ACCOUNT_ID || !D1_DATABASE_ID) {
  console.error('缺少环境变量：CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID')
  process.exit(1)
}

const D1_API = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`
const X_API = 'https://api.nmb.best/api'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const PAGE_SIZE = 19
const MAX_THREADS = 50
const MAX_PAGES_PER_THREAD = 100

/** parse（默认，长串深爬）| queue（消化 recrawl_queue 积压） */
const MODE = (process.env.MODE || 'parse').toLowerCase()
const QUEUE_LIMIT = Math.max(1, Number(process.env.QUEUE_LIMIT || 200))
const QUEUE_CONCURRENCY = Math.max(1, Number(process.env.QUEUE_CONCURRENCY || 4))
const QUEUE_RETRY_SEC = 6 * 3600 // 失败退避 6h；attempts ≥ 5 → failed
const QUEUE_DONE_SEC = 7 * 24 * 3600 // 成功 → done，下次回扫 7 天后（与 Worker 一致）
/** D1 单查询最多 100 个绑定参数；每条楼层 7 列 → 每语句最多 14 行，取 10 留余量 */
const POSTS_PER_STMT = 10

// ── D1 REST API ──

async function d1Query(sql, params = []) {
  const res = await fetch(D1_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  })
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`D1 API ${res.status}: ${txt.slice(0, 300)}`)
  }
  const json = await res.json()
  if (!json.success) throw new Error(`D1 错误: ${JSON.stringify(json.errors ?? json).slice(0, 300)}`)
  return json.result?.[0]?.results ?? []
}

// ── 网关签名 ──

function signGwToken(payload, ttlMs) {
  const exp = Date.now() + ttlMs
  const data = `bili.${exp}.${payload}`
  const sig = crypto.createHmac('sha256', GW_SECRET).update(data).digest('base64url')
  return `${exp}.${Buffer.from(payload).toString('base64url')}.${sig}`
}

// ── X岛 API fetcher ──

async function xFetch(path, userhash) {
  if (GW_URL && GW_SECRET) {
    try {
      const token = signGwToken(`xdnmb.api.${path}.${userhash}`, 5 * 60 * 1000)
      const gwUrl = `${GW_URL}/xdnmb?k=api&p=${encodeURIComponent(path)}` +
        (userhash ? `&uh=${encodeURIComponent(userhash)}` : '')
      const r = await fetch(gwUrl, { headers: { 'x-sg-bili': token } })
      if (r.ok) return await parseXResponse(r, path)
      if (r.status >= 400 && r.status < 500) return await parseXResponse(r, path)
    } catch { /* 网关不可达：走直连 */ }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const r = await fetch(`${X_API}/${path}`, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...(userhash ? { Cookie: `userhash=${userhash}` } : {}),
      },
    })
    return await parseXResponse(r, path)
  } finally {
    clearTimeout(timer)
  }
}

async function parseXResponse(r, path) {
  const text = await r.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    if (!r.ok) throw new Error(`X岛 ${path} HTTP ${r.status}`)
    throw new Error(text.slice(0, 120) || 'X岛返回了无法解析的响应')
  }
  if (!r.ok) {
    const msg = data?.error || (typeof data === 'string' ? data : `HTTP ${r.status}`)
    throw new Error(msg)
  }
  if (data?.success === false) throw new Error(data?.error || 'X岛返回错误')
  if (typeof data === 'string') throw new Error(data)
  return data
}

// ── toPlain ──

function toPlain(html) {
  if (!html) return ''
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
    .slice(0, 4000)
}

function threadTitleFrom(p) {
  const t = (p.title || '').trim()
  if (t) return t.slice(0, 200)
  return toPlain(p.content).split('\n')[0].slice(0, 60) || ''
}

// ── D1 upsert（REST API） ──

async function upsertThreadD1(tid, fid, title, content, replyCount, lastReplyId, sage, admin) {
  await d1Query(
    `INSERT INTO xdnmb_index_threads (id, fid, title, content, reply_count, last_reply_id, sage, admin, indexed_at, crawled_at, deleted_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, unixepoch(), unixepoch(), NULL)
     ON CONFLICT(id) DO UPDATE SET
       fid = COALESCE(excluded.fid, xdnmb_index_threads.fid),
       title = excluded.title, content = excluded.content,
       reply_count = excluded.reply_count, last_reply_id = excluded.last_reply_id,
       sage = excluded.sage, admin = excluded.admin,
       indexed_at = unixepoch(), crawled_at = unixepoch(), deleted_at = NULL`,
    [tid, fid ?? null, (title || '').slice(0, 200), (content || '').slice(0, 8000),
     Number(replyCount), Number(lastReplyId), Number(sage ?? 0), Number(admin ?? 0)],
  )
}

/** 批量 upsert 楼层：一条多行 VALUES 语句 = 1 次 D1 REST 调用，替代逐帖 1 次 */
async function upsertPostsBatchD1(rows) {
  for (let i = 0; i < rows.length; i += POSTS_PER_STMT) {
    const chunk = rows.slice(i, i + POSTS_PER_STMT)
    const params = []
    for (const r of chunk) {
      params.push(
        Number(r.id), Number(r.threadId), (r.content || '').slice(0, 4000),
        (r.userHash || '').slice(0, 24), (r.now || '').slice(0, 40),
        Number(r.sage ?? 0), Number(r.admin ?? 0),
      )
    }
    const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, unixepoch(), NULL)').join(',')
    await d1Query(
      `INSERT INTO xdnmb_index_posts (id, thread_id, content, user_hash, now, sage, admin, indexed_at, deleted_at)
       VALUES ${values}
       ON CONFLICT(id) DO UPDATE SET
         thread_id = excluded.thread_id, content = excluded.content,
         user_hash = excluded.user_hash, now = excluded.now,
         sage = excluded.sage, admin = excluded.admin,
         indexed_at = unixepoch(), deleted_at = NULL`,
      params,
    )
  }
}

// ── 主流程 ──

/**
 * 完整爬取一个串：首页探测总页数 → 逐页内联楼层 → 批量写 D1。
 * 单页失败不中断其余页；返回 { ok, mainPost, replyCount, lastReplyId, pages, posts, errors }。
 */
async function crawlThreadFull(tid, uh) {
  let mainPost
  try {
    mainPost = await xFetch(`thread?id=${encodeURIComponent(tid)}&page=1`, uh)
  } catch (e) {
    return { ok: false, error: e.message, pages: 0, posts: 0, errors: 1 }
  }
  const replyCount = Number(mainPost.ReplyCount ?? 0)
  const lastPageNum = Math.min(Math.max(1, Math.ceil(replyCount / PAGE_SIZE)), MAX_PAGES_PER_THREAD)

  const seen = new Set()
  const rows = []
  let lastReplyId = tid
  let pages = 1
  let errors = 0

  const collect = (r) => {
    const rid = Number(r.id)
    if (!Number.isFinite(rid) || rid <= 0 || seen.has(rid)) return
    seen.add(rid)
    if (rid > lastReplyId) lastReplyId = rid
    if (r.user_hash === 'Tips') return
    rows.push({
      id: rid, threadId: tid, content: toPlain(r.content),
      userHash: String(r.user_hash || ''), now: String(r.now || ''),
      sage: r.sage, admin: r.admin,
    })
  }

  for (const r of [mainPost, ...(mainPost.Replies || [])]) collect(r)
  for (let pg = 2; pg <= lastPageNum; pg++) {
    try {
      const page = await xFetch(`thread?id=${encodeURIComponent(tid)}&page=${pg}`, uh)
      for (const r of page.Replies || []) collect(r)
      pages++
    } catch (e) {
      errors++
      console.error(`[crawl] 串 ${tid} page ${pg} 错误: ${e.message}`)
    }
  }

  try {
    await upsertPostsBatchD1(rows)
  } catch (e) {
    return { ok: false, error: e.message, pages, posts: 0, errors: errors + 1 }
  }
  return { ok: true, mainPost, replyCount, lastReplyId, pages, posts: rows.length, errors }
}

/** MODE=parse：长串深爬（reply_count > 200 但楼层不全的串） */
async function deepCrawl() {
  console.log('[deep-crawl] 开始长串深度爬取')
  const uh = XDNMB_USERHASH

  const threads = await d1Query(
    `SELECT t.id, t.reply_count, t.title,
            (SELECT COUNT(*) FROM xdnmb_index_posts p WHERE p.thread_id = t.id AND p.deleted_at IS NULL) AS post_count
     FROM xdnmb_index_threads t
     WHERE t.reply_count > 200 AND t.deleted_at IS NULL
     HAVING post_count < t.reply_count
     ORDER BY (t.reply_count - post_count) DESC
     LIMIT ?1`,
    [MAX_THREADS],
  )
  console.log(`[deep-crawl] 找到 ${threads.length} 个待深度爬取的串`)

  let totalPosts = 0
  let totalErrors = 0

  for (const t of threads) {
    const tid = Number(t.id)
    console.log(`[deep-crawl] 串 ${tid} (${t.title?.slice(0, 30) || ''}) reply_count=${Number(t.reply_count)}`)
    const r = await crawlThreadFull(tid, uh)
    totalPosts += r.posts
    totalErrors += r.errors

    // 更新串主楼（title/content/replyCount/lastReplyId）
    if (r.ok && r.mainPost) {
      await upsertThreadD1(
        tid,
        r.mainPost.fid ?? null,
        threadTitleFrom(r.mainPost),
        toPlain(r.mainPost.content),
        Number(t.reply_count),
        r.lastReplyId,
        r.mainPost.sage,
        r.mainPost.admin,
      )
    }

    // 安排 7 天后回扫
    await d1Query(
      `INSERT INTO xdnmb_index_recrawl_queue (thread_id, due_at, status, attempts, updated_at)
       VALUES (?1, ?2, 'pending', 0, unixepoch())
       ON CONFLICT(thread_id) DO UPDATE SET due_at = excluded.due_at, status = 'pending', updated_at = unixepoch()`,
      [tid, Math.floor(Date.now() / 1000) + 7 * 24 * 3600],
    )

    console.log(`[deep-crawl] 串 ${tid} 完成：${r.pages} 页，${r.posts} 楼层`)
  }

  console.log(`[deep-crawl] 完成：${threads.length} 串，${totalPosts} 楼层，${totalErrors} 错误`)
}

/** MODE=queue：认领到期的积压串，完整爬取后标 done（消化 1.8 万条未收录积压） */
async function drainQueue() {
  const uh = XDNMB_USERHASH
  const rows = await d1Query(
    `SELECT thread_id FROM xdnmb_index_recrawl_queue
     WHERE status = 'pending' AND due_at <= unixepoch()
     ORDER BY due_at ASC LIMIT ?1`,
    [QUEUE_LIMIT],
  )
  console.log(`[queue-drain] 认领到期 ${rows.length} 条（上限 ${QUEUE_LIMIT}，并发 ${QUEUE_CONCURRENCY}）`)
  if (!rows.length) return

  let ok = 0
  let failed = 0
  let posts = 0
  let cursor = 0

  const runOne = async (tid) => {
    try {
      const r = await crawlThreadFull(tid, uh)
      if (!r.ok || !r.mainPost) throw new Error(r.error || '爬取失败')
      await upsertThreadD1(
        tid,
        r.mainPost.fid ?? null,
        threadTitleFrom(r.mainPost),
        toPlain(r.mainPost.content),
        r.replyCount,
        r.lastReplyId,
        r.mainPost.sage,
        r.mainPost.admin,
      )
      await d1Query(
        `UPDATE xdnmb_index_recrawl_queue
         SET status = 'done', attempts = 0, due_at = unixepoch() + ?1, updated_at = unixepoch()
         WHERE thread_id = ?2`,
        [QUEUE_DONE_SEC, tid],
      )
      ok++
      posts += r.posts
    } catch (e) {
      failed++
      try {
        await d1Query(
          `UPDATE xdnmb_index_recrawl_queue
           SET due_at = unixepoch() + ?1, attempts = attempts + 1,
               status = CASE WHEN attempts + 1 >= 5 THEN 'failed' ELSE 'pending' END,
               updated_at = unixepoch()
           WHERE thread_id = ?2`,
          [QUEUE_RETRY_SEC, tid],
        )
      } catch { /* 标记失败也不阻塞后续 */ }
      console.error(`[queue-drain] 串 ${tid} 失败: ${e.message}`)
    }
  }

  const worker = async () => {
    while (cursor < rows.length) await runOne(Number(rows[cursor++].thread_id))
  }
  await Promise.all(Array.from({ length: QUEUE_CONCURRENCY }, worker))

  console.log(`[queue-drain] 完成：成功 ${ok} 串 / 失败 ${failed} 串 / 写入 ${posts} 楼层`)
}

async function main() {
  if (MODE === 'queue') return drainQueue()
  return deepCrawl()
}

main().catch((e) => {
  console.error('[crawl] 致命错误:', e)
  process.exit(1)
})
