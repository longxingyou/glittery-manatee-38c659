/**
 * 双库合并预检：枚举所有会被 ON CONFLICT DO NOTHING 静默丢弃的行。
 *
 * 用法：
 *   $env:OLD_DB_URL='postgresql://...旧库...'
 *   node scripts/merge-precheck.mjs
 *
 * 输出：
 *   1. 每张表两边 PK 的交集（撞键清单）
 *   2. users 按 email 的交叉比对（同 email 不同 id 的撞车）
 *   3. settings 行内容对比
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire('c:/Projects/my-website/glittery-manatee-38c659/package.json')
const { neon } = require('@neondatabase/serverless')

const OLD_URL = process.env.OLD_DB_URL
if (!OLD_URL) { console.error('缺少 OLD_DB_URL'); process.exit(1) }
const NEW_URL = readFileSync('.dev.vars', 'utf8').split(/\r?\n/)
  .map((l) => l.match(/^\s*DATABASE_URL\s*=\s*(.*)$/))
  .find(Boolean)?.[1]?.trim().replace(/^["']|["']$/g, '')
if (!NEW_URL) { console.error('缺少 .dev.vars DATABASE_URL'); process.exit(1) }

const oldSql = neon(OLD_URL)
const newSql = neon(NEW_URL)

/** 要检查的表（xdnmb_index_* 已弃用不合并；主键自动探测） */
const TABLES = [
  'users', 'settings', 'posts', 'comments', 'categories', 'attachments',
  'post_eggs', 'profiles', 'feedback', 'feedback_attachments', 'warnings',
  'user_tags', 'site_content', 'net_share_links', 'net_share_bindings',
  'ru_share_links', 'ru_share_bindings', 'xdnmb_cookies', 'xdnmb_favs',
  'xdnmb_my_posts', 'xdnmb_subs',
]

async function tablesOf(sql) {
  const rows = await sql.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`,
  )
  return new Set(rows.map((r) => r.table_name))
}

async function pkOf(sql, table) {
  const rows = await sql.query(
    `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema='public' AND tc.table_name=$1 AND tc.constraint_type='PRIMARY KEY'
      ORDER BY kcu.ordinal_position`,
    [table],
  )
  return rows.map((r) => r.column_name)
}

async function keysOf(sql, table, pkCols) {
  const rows = await sql.query(
    `SELECT ${pkCols.map((c) => `"${c}"::text AS "${c}"`).join(', ')} FROM "${table}"`,
  )
  return rows.map((r) => pkCols.map((c) => r[c]).join(''))
}

const [oldTables, newTables] = await Promise.all([tablesOf(oldSql), tablesOf(newSql)])

console.log('=== 撞键预检（交集 = 旧库该行会被静默丢弃）===\n')
let anyCollision = false
for (const table of TABLES) {
  if (!oldTables.has(table)) { console.log(`${table}: 旧库无此表，跳过`); continue }
  if (!newTables.has(table)) { console.log(`${table}: 新库无此表（将由脚本补建），无撞键`); continue }
  const pk = await pkOf(oldSql, table)
  if (!pk.length) { console.log(`${table}: 旧库无主键，跳过（需人工核对）`); continue }
  const [ok, nk] = await Promise.all([keysOf(oldSql, table, pk), keysOf(newSql, table, pk)])
  const nSet = new Set(nk)
  const hits = ok.filter((k) => nSet.has(k))
  if (!ok.length && !nk.length) { console.log(`${table}: 两边皆空`); continue }
  if (!hits.length) {
    console.log(`${table}: 旧 ${ok.length} 行 / 新 ${nk.length} 行，无撞键 ✓`)
  } else {
    anyCollision = true
    console.log(`${table}: 旧 ${ok.length} 行 / 新 ${nk.length} 行，撞键 ${hits.length} 个 ✗`)
    console.log(`  撞键: ${hits.slice(0, 20).join(', ')}${hits.length > 20 ? ' …' : ''}`)
  }
}

console.log('\n=== users email 交叉比对 ===')
const [ou, nu] = await Promise.all([
  oldSql.query('SELECT id, email FROM users ORDER BY email'),
  newSql.query('SELECT id, email FROM users ORDER BY email'),
])
const oldByEmail = new Map(ou.map((u) => [u.email, u.id]))
for (const u of nu) {
  const oid = oldByEmail.get(u.email)
  if (oid && oid !== u.id) {
    console.log(`✗ 同 email 不同 id: ${u.email}  旧=${oid} 新=${u.id}（旧库 comments/profiles 等外键指向旧 id，需以旧 id 为准改新库）`)
  } else if (oid) {
    console.log(`· ${u.email}: 两边 id 相同（${oid}），旧库数据将覆盖新库 ✓`)
  } else {
    console.log(`+ ${u.email}: 仅新库存在，保留`)
  }
}

console.log('\n=== settings 对比 ===')
const [os_, ns_] = await Promise.all([
  oldSql.query('SELECT * FROM settings'),
  newSql.query('SELECT * FROM settings'),
])
console.log('旧库 settings:', JSON.stringify(os_, null, 2))
console.log('新库 settings:', JSON.stringify(ns_, null, 2))

console.log(anyCollision ? '\n结论：存在撞键，合并前需先重排新库冲突行。' : '\n结论：无撞键，可直接合并。')
