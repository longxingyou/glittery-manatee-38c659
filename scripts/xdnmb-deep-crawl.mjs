/**
 * X岛长串深度爬取（GitHub Actions weekly 运行）。
 *
 * 爬虫 Worker 的 5min timeline cron 只取首页+末页（快速模式），
 * 回复数 > 200 的长串中段楼层不会被索引。此脚本在 GitHub Actions 中运行
 * （无 subrequest 限制），逐页爬取长串所有楼层，通过 D1 REST API 写入。
 *
 * 算法：
 * 1. 查 D1 中 reply_count > 200 且已索引楼层数 < reply_count 的串
 * 2. 对每个串逐页爬取（thread?id=X&page=N），upsert 所有楼层到 D1
 * 3. 每批最多 50 个串，每串最多 100 页，控制在 20 分钟内
 *
 * 环境变量（GitHub Secrets）：
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

async function upsertPostD1(id, threadId, content, userHash, now, sage, admin) {
  await d1Query(
    `INSERT INTO xdnmb_index_posts (id, thread_id, content, user_hash, now, sage, admin, indexed_at, deleted_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, unixepoch(), NULL)
     ON CONFLICT(id) DO UPDATE SET
       thread_id = excluded.thread_id, content = excluded.content,
       user_hash = excluded.user_hash, now = excluded.now,
       sage = excluded.sage, admin = excluded.admin,
       indexed_at = unixepoch(), deleted_at = NULL`,
    [Number(id), Number(threadId), (content || '').slice(0, 4000),
     (userHash || '').slice(0, 24), (now || '').slice(0, 40),
     Number(sage ?? 0), Number(admin ?? 0)],
  )
}

// ── 主流程 ──

async function main() {
  console.log('[deep-crawl] 开始长串深度爬取')
  const uh = XDNMB_USERHASH

  // 1. 查 D1 中需要深度爬取的串
  // reply_count > 200 且已索引楼层数 < reply_count
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
    const replyCount = Number(t.reply_count)
    const lastPageNum = Math.max(1, Math.ceil(replyCount / PAGE_SIZE))
    console.log(`[deep-crawl] 串 ${tid} (${t.title?.slice(0, 30) || ''}) reply_count=${replyCount} ${lastPageNum} 页`)

    const seenIds = new Set()
    let lastReplyId = tid
    let threadMainPost = null
    let pagesCrawled = 0

    for (let pg = 1; pg <= Math.min(lastPageNum, MAX_PAGES_PER_THREAD); pg++) {
      try {
        const page = await xFetch(`thread?id=${encodeURIComponent(tid)}&page=${pg}`, uh)
        if (pg === 1) {
          threadMainPost = page
        }
        // 收集楼层
        const allOnPage = [page, ...(page.Replies || [])]
        for (const r of allOnPage) {
          const rid = Number(r.id)
          if (!Number.isFinite(rid) || rid <= 0 || seenIds.has(rid)) continue
          seenIds.add(rid)
          if (r.user_hash === 'Tips') continue
          if (rid > lastReplyId) lastReplyId = rid
          await upsertPostD1(rid, tid, toPlain(r.content), String(r.user_hash || ''), String(r.now || ''), r.sage, r.admin)
          totalPosts++
        }
        pagesCrawled++
      } catch (e) {
        totalErrors++
        console.error(`[deep-crawl] 串 ${tid} page ${pg} 错误: ${e.message}`)
      }
    }

    // 更新串主楼（title/content/replyCount/lastReplyId）
    if (threadMainPost) {
      await upsertThreadD1(
        tid,
        threadMainPost.fid ?? null,
        threadTitleFrom(threadMainPost),
        toPlain(threadMainPost.content),
        replyCount,
        lastReplyId,
        threadMainPost.sage,
        threadMainPost.admin,
      )
    }

    // 安排 7 天后回扫
    const nowSec = Math.floor(Date.now() / 1000)
    await d1Query(
      `INSERT INTO xdnmb_index_recrawl_queue (thread_id, due_at, status, attempts, updated_at)
       VALUES (?1, ?2, 'pending', 0, unixepoch())
       ON CONFLICT(thread_id) DO UPDATE SET due_at = excluded.due_at, status = 'pending', updated_at = unixepoch()`,
      [tid, nowSec + 7 * 24 * 3600],
    )

    console.log(`[deep-crawl] 串 ${tid} 完成：${pagesCrawled} 页，${seenIds.size} 楼层`)
  }

  console.log(`[deep-crawl] 完成：${threads.length} 串，${totalPosts} 楼层，${totalErrors} 错误`)
}

main().catch((e) => {
  console.error('[deep-crawl] 致命错误:', e)
  process.exit(1)
})
