/** 合并前细节查证：撞键行内容 + id 范围 + 新库用户行 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire('c:/Projects/my-website/glittery-manatee-38c659/package.json')
const { neon } = require('@neondatabase/serverless')

const OLD_URL = process.env.OLD_DB_URL
const NEW_URL = readFileSync('.dev.vars', 'utf8').split(/\r?\n/)
  .map((l) => l.match(/^\s*DATABASE_URL\s*=\s*(.*)$/))
  .find(Boolean)?.[1]?.trim().replace(/^["']|["']$/g, '')

const oldSql = neon(OLD_URL)
const newSql = neon(NEW_URL)

console.log('=== attachments 撞键 id=4 ===')
console.log('旧库 id=4:', JSON.stringify(await oldSql.query(
  `SELECT id, post_slug, filename, size_bytes, storage_key, created_at FROM attachments WHERE id = 4`)))
console.log('新库全部:', JSON.stringify(await newSql.query(
  `SELECT id, post_slug, filename, size_bytes, storage_key, created_at FROM attachments ORDER BY id`)))
console.log('旧库 id 范围:', JSON.stringify(await oldSql.query(
  `SELECT min(id) AS lo, max(id) AS hi, count(*)::int AS n FROM attachments`)))

console.log('\n=== ru_share_bindings id 范围 ===')
console.log('旧库:', JSON.stringify(await oldSql.query(
  `SELECT min(id) AS lo, max(id) AS hi, count(*)::int AS n FROM ru_share_bindings`)))
console.log('新库:', JSON.stringify(await newSql.query(
  `SELECT min(id) AS lo, max(id) AS hi, count(*)::int AS n FROM ru_share_bindings`)))
console.log('新库全部 id:', JSON.stringify((await newSql.query(
  `SELECT id FROM ru_share_bindings ORDER BY id`)).map((r) => r.id)))

console.log('\n=== 新库 users 行（待删，密码哈希待转移）===')
console.log(JSON.stringify(await newSql.query(
  `SELECT id, email, display_name, confirmed_at, created_at,
          left(password_hash, 12) AS ph_prefix, left(password_salt, 12) AS ps_prefix
     FROM users`)))

console.log('\n=== 新库中引用该 user id 的行数（应为 0 才可安全删除）===')
for (const [t, col] of [['comments', 'user_id'], ['profiles', 'user_id']]) {
  const r = await newSql.query(
    `SELECT count(*)::int AS n FROM "${t}" WHERE "${col}" = '31c1281aab58733735c4220151ad4ea5'`)
  console.log(`  ${t}.${col}: ${r[0].n}`)
}

console.log('\n=== 旧库 attachments id=4 的 post_slug 在两库 posts 中是否存在 ===')
const att = await oldSql.query(`SELECT post_slug FROM attachments WHERE id = 4`)
if (att.length) {
  const slug = att[0].post_slug
  const [op, np] = await Promise.all([
    oldSql.query(`SELECT id, slug, status FROM posts WHERE slug = $1`, [slug]),
    newSql.query(`SELECT id, slug, status FROM posts WHERE slug = $1`, [slug]),
  ])
  console.log(`  slug=${slug}  旧库 posts: ${op.length} 行  新库 posts: ${np.length} 行`)
}
