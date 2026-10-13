/**
 * 一次性数据迁移：Neon Postgres xdnmb_index_* 表 → Cloudflare D1。
 *
 * 流程：用 @neondatabase/serverless 直连 Neon 流式分批读取，
 * 调 Cloudflare D1 REST API 批量 INSERT，结尾 COUNT(*) 对账。
 *
 * 环境变量（从 .dev.vars 或 shell 读取）：
 *   DATABASE_URL            Neon Postgres 连接串（直连，非 pooled）
 *   CLOUDFLARE_API_TOKEN    有 D1 写权限的 API token
 *   CLOUDFLARE_ACCOUNT_ID   Cloudflare 账号 ID
 *   D1_DATABASE_ID          xdnmb-index 的 database_id（见 wrangler.jsonc）
 *
 * 用法：
 *   $env:DATABASE_URL='<从 .dev.vars 复制>'
 *   $env:CLOUDFLARE_API_TOKEN='...'
 *   $env:CLOUDFLARE_ACCOUNT_ID='...'
 *   $env:D1_DATABASE_ID='c6253cf1-b0c7-4f0a-89e4-fc3a79ac2c91'
 *   pnpm run migrate-xdnmb-to-d1
 */
import { neon } from '@neondatabase/serverless'

const DATABASE_URL = process.env.DATABASE_URL
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID
const D1_DATABASE_ID = process.env.D1_DATABASE_ID

if (!DATABASE_URL || !CF_API_TOKEN || !CF_ACCOUNT_ID || !D1_DATABASE_ID) {
  console.error('缺少环境变量。需要：DATABASE_URL, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID')
  process.exit(1)
}

const D1_API = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`
const BATCH = 500

/** 执行 D1 SQL（单语句，支持 ? 绑定） */
async function d1Exec(sql, params = []) {
  const res = await fetch(D1_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  })
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`D1 API ${res.status}: ${txt.slice(0, 300)}`)
  }
  const json = await res.json()
  if (!json.success) {
    throw new Error(`D1 错误: ${JSON.stringify(json.errors ?? json).slice(0, 300)}`)
  }
  return json.result?.[0] ?? json.result
}

/** 批量插入：生成 VALUES (...),(...),... 占位符 */
async function batchInsert(table, columns, rows) {
  if (rows.length === 0) return 0
  const placeholders = rows.map((_, i) => `(${columns.map((_, c) => `?${i * columns.length + c + 1}`).join(',')})`).join(',')
  const values = rows.flat()
  const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders}
    ON CONFLICT(id) DO UPDATE SET ${columns.filter((c) => c !== 'id').map((c) => `${c}=excluded.${c}`).join(',')}`
  await d1Exec(sql, values)
  return rows.length
}

async function migrate() {
  const sql = neon(DATABASE_URL)
  console.log('━━━ 1/4 先在 D1 建表（幂等）━━━')
  // schema 文件已由 wrangler d1 execute --file 应用；此处只确保表存在
  console.log('（假设 schema 已通过 wrangler d1 execute --file=db/d1-schema.sql 应用）')

  // ── threads ──
  console.log('━━━ 2/4 迁移 xdnmb_index_threads ━━━')
  const threadCols = ['id', 'fid', 'title', 'content', 'reply_count', 'last_reply_id', 'sage', 'admin']
  let threadTotal = 0
  let offset = 0
  while (true) {
    const rows = await sql`SELECT id, fid, title, content, reply_count, last_reply_id, sage, admin FROM xdnmb_index_threads ORDER BY id LIMIT ${BATCH} OFFSET ${offset}`
    if (rows.length === 0) break
    const mapped = rows.map((r) => [
      Number(r.id), r.fid == null ? null : Number(r.fid),
      r.title ?? '', r.content ?? '',
      Number(r.reply_count ?? 0), Number(r.last_reply_id ?? 0),
      Number(r.sage ?? 0), Number(r.admin ?? 0),
    ])
    const n = await batchInsert('xdnmb_index_threads', threadCols, mapped)
    threadTotal += n
    offset += rows.length
    if (rows.length < BATCH) break
    process.stdout.write(`  threads: ${threadTotal}...\r`)
  }
  console.log(`  threads 迁移完成: ${threadTotal} 行`)

  // ── posts ──
  console.log('━━━ 3/4 迁移 xdnmb_index_posts ━━━')
  const postCols = ['id', 'thread_id', 'content', 'user_hash', 'now', 'sage', 'admin']
  let postTotal = 0
  offset = 0
  while (true) {
    const rows = await sql`SELECT id, thread_id, content, user_hash, now, sage, admin FROM xdnmb_index_posts ORDER BY id LIMIT ${BATCH} OFFSET ${offset}`
    if (rows.length === 0) break
    const mapped = rows.map((r) => [
      Number(r.id), Number(r.thread_id),
      r.content ?? '', r.user_hash ?? '', r.now ?? '',
      Number(r.sage ?? 0), Number(r.admin ?? 0),
    ])
    const n = await batchInsert('xdnmb_index_posts', postCols, mapped)
    postTotal += n
    offset += rows.length
    if (rows.length < BATCH) break
    process.stdout.write(`  posts: ${postTotal}...\r`)
  }
  console.log(`  posts 迁移完成: ${postTotal} 行`)

  // ── cursors ──
  console.log('━━━ 4/4 迁移 xdnmb_index_cursors ━━━')
  const cursorCols = ['kind', 'target_id', 'page', 'round']
  const cursorRows = await sql`SELECT kind, target_id, page, round FROM xdnmb_index_cursors`
  let cursorTotal = 0
  for (let i = 0; i < cursorRows.length; i += BATCH) {
    const slice = cursorRows.slice(i, i + BATCH)
    const mapped = slice.map((r) => [r.kind, r.target_id, Number(r.page ?? 1), Number(r.round ?? 0)])
    const n = await batchInsert('xdnmb_index_cursors', cursorCols, mapped)
    cursorTotal += n
  }
  console.log(`  cursors 迁移完成: ${cursorTotal} 行`)

  // ── 对账 ──
  console.log('━━━ 对账 ━━━')
  const neonCounts = await sql`SELECT
    (SELECT COUNT(*) FROM xdnmb_index_threads) AS threads,
    (SELECT COUNT(*) FROM xdnmb_index_posts) AS posts,
    (SELECT COUNT(*) FROM xdnmb_index_cursors) AS cursors`
  const d1Threads = await d1Exec('SELECT COUNT(*) AS c FROM xdnmb_index_threads')
  const d1Posts = await d1Exec('SELECT COUNT(*) AS c FROM xdnmb_index_posts')
  const d1Cursors = await d1Exec('SELECT COUNT(*) AS c FROM xdnmb_index_cursors')

  console.log(`Neon:  threads=${neonCounts[0].threads}  posts=${neonCounts[0].posts}  cursors=${neonCounts[0].cursors}`)
  console.log(`D1:    threads=${d1Threads.results?.[0]?.c ?? '?'}  posts=${d1Posts.results?.[0]?.c ?? '?'}  cursors=${d1Cursors.results?.[0]?.c ?? '?'}`)

  const ok = Number(neonCounts[0].threads) === Number(d1Threads.results?.[0]?.c)
    && Number(neonCounts[0].posts) === Number(d1Posts.results?.[0]?.c)
    && Number(neonCounts[0].cursors) === Number(d1Cursors.results?.[0]?.c)
  console.log(ok ? '\n✅ 迁移完成，三者计数一致。' : '\n⚠️ 计数不一致，请检查。')
}

migrate().catch((e) => {
  console.error('迁移失败:', e)
  process.exit(1)
})
