// 数据库盘点：表/行数/时间范围/主键与关键列
// 用法：node db-inventory.mjs old|new
//   old 读环境变量 OLD_DB_URL；new 读 .dev.vars 的 DATABASE_URL
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const root = 'c:/Projects/my-website/glittery-manatee-38c659'
const req = createRequire(root + '/package.json')
const which = process.argv[2] || 'new'
let url
if (which === 'old') {
  url = process.env.OLD_DB_URL
  if (!url) { console.error('missing OLD_DB_URL'); process.exit(1) }
} else {
  const txt = readFileSync(root + '/.dev.vars', 'utf8')
  url = /^DATABASE_URL=(.*)$/m.exec(txt)[1].trim()
}

const { neon } = req('@neondatabase/serverless')
const sql = neon(url)
console.log(`[${which}] host=${new URL(url.replace('postgresql://', 'http://')).host}`)

const tables = await sql`select table_name from information_schema.tables
  where table_schema='public' and table_type='BASE TABLE' order by table_name`
console.log('tables:', tables.length)

const timeCol = {
  users: 'created_at', comments: 'created_at', posts: 'created_at', attachments: 'created_at',
  categories: 'created_at', feedback: 'created_at', profiles: 'updated_at', warnings: 'created_at',
  post_eggs: 'updated_at', settings: 'updated_at', feedback_attachments: 'created_at',
  net_share_links: 'created_at', net_share_bindings: 'created_at',
  ru_share_links: 'created_at', ru_share_bindings: 'created_at',
  site_content: 'updated_at', user_tags: 'created_at',
}
for (const t of tables) {
  const name = t.table_name
  try {
    const cnt = await sql.query(`select count(*)::int c from "${name}"`)
    let extra = ''
    const col = timeCol[name]
    if (col && cnt[0].c > 0) {
      try {
        const r = await sql.query(`select min("${col}")::text mn, max("${col}")::text mx from "${name}"`)
        extra = `  ${(r[0].mn || '').slice(0, 10)} → ${(r[0].mx || '').slice(0, 10)}`
      } catch { extra = '' }
    }
    console.log(`${name.padEnd(22)} rows=${String(cnt[0].c).padStart(6)}${extra}`)
  } catch (e) {
    console.log(`${name.padEnd(22)} SKIP (${e.message.slice(0, 60)})`)
  }
}

console.log('\n=== id 列与序列 ===')
const cols = await sql`select table_name, column_name, data_type from information_schema.columns
  where table_schema='public' and column_name='id' order by table_name`
for (const c of cols) console.log(`${c.table_name.padEnd(22)} id ${c.data_type}`)

console.log('\n=== users ===')
const users = await sql`select id, email, display_name, created_at::date d from users order by created_at`
for (const u of users) console.log(`  ${u.id} ${u.email} ${u.display_name} ${u.d}`)

console.log('\n=== posts ===')
const posts = await sql`select id, slug, status, language, created_at::date d from posts order by id`
for (const p of posts) console.log(`  #${p.id} ${p.slug} ${p.status} ${p.language} ${p.d}`)
