/**
 * 合并 Phase A（prep）：新库撞键重排 + 重复账号 id 归位。
 * 在 migrate-neon-merge.mjs 之前执行。幂等：重复执行会检测已完成状态并跳过。
 *
 *   $env:OLD_DB_URL='...旧库...'; node scripts/merge-prep.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'

const require = createRequire('c:/Projects/my-website/glittery-manatee-38c659/package.json')
const { neon } = require('@neondatabase/serverless')

const OLD_URL = process.env.OLD_DB_URL
const NEW_URL = readFileSync('.dev.vars', 'utf8').split(/\r?\n/)
  .map((l) => l.match(/^\s*DATABASE_URL\s*=\s*(.*)$/))
  .find(Boolean)?.[1]?.trim().replace(/^["']|["']$/g, '')
const oldSql = neon(OLD_URL)
const newSql = neon(NEW_URL)

const OLD_UID = '9eb73ea7a6c58ac3023498d79cd87e70' // 旧库 Loong
const NEW_UID = '31c1281aab58733735c4220151ad4ea5' // 新库重复注册的 Loong

// ── 1. attachments：新库 id=4（孤儿 SDS.pdf）让位给旧库 id=4（1.2GB 初学记 PDF）──
const oldAttMax = (await oldSql.query('SELECT COALESCE(MAX(id),0)::int AS m FROM attachments'))[0].m
const clash = await newSql.query('SELECT id, filename FROM attachments WHERE id = ANY($1::int[])',
  [(await oldSql.query('SELECT id FROM attachments')).map((r) => r.id)])
for (const row of clash) {
  const target = await newSql.query(
    'SELECT COALESCE(MAX(id),0)::int AS m FROM attachments')
  const newId = Math.max(target[0].m, oldAttMax) + 1
  await newSql.query('UPDATE attachments SET id = $1 WHERE id = $2', [newId, row.id])
  console.log(`attachments: id ${row.id} (${row.filename}) → ${newId}`)
}
if (!clash.length) console.log('attachments: 无撞键，跳过')

// ── 2. ru_share_bindings：新库撞键行整体上移（弃用表，纯归档保留）──
const oldRuMax = Number((await oldSql.query('SELECT COALESCE(MAX(id),0) AS m FROM ru_share_bindings'))[0].m)
const ruClash = await newSql.query(
  'SELECT id FROM ru_share_bindings WHERE id = ANY($1::bigint[]) ORDER BY id',
  [(await oldSql.query('SELECT id FROM ru_share_bindings')).map((r) => r.id)])
if (ruClash.length) {
  const newMax = Number((await newSql.query('SELECT COALESCE(MAX(id),0) AS m FROM ru_share_bindings'))[0].m)
  const offset = Math.max(oldRuMax, newMax) + 1 // 3→54, 16→67 式偏移（保持相对顺序）
  // 逐行 UPDATE 避免新值互撞（升序处理，目标值都大于现有 max）
  for (const row of ruClash) {
    const nid = Number(row.id)
    await newSql.query('UPDATE ru_share_bindings SET id = $1 WHERE id = $2', [offset + nid, nid])
  }
  console.log(`ru_share_bindings: ${ruClash.length} 行（id ${ruClash[0].id}–${ruClash[ruClash.length - 1].id}）→ +${offset} 偏移`)
} else {
  console.log('ru_share_bindings: 无撞键，跳过')
}

// ── 3. users：新库重复账号 id 改回旧 id（无引用，已验证），密码哈希存档待回写 ──
const nu = await newSql.query('SELECT id, password_hash, password_salt FROM users WHERE id = $1', [NEW_UID])
const already = await newSql.query('SELECT id FROM users WHERE id = $1', [OLD_UID])
if (nu.length && !already.length) {
  writeFileSync(`${process.env.TEMP}\\merge-new-password.json`, JSON.stringify(nu[0]))
  await newSql.query('UPDATE users SET id = $1 WHERE id = $2', [OLD_UID, NEW_UID])
  console.log(`users: ${NEW_UID.slice(0, 8)}… → ${OLD_UID.slice(0, 8)}…（新密码哈希已存 %TEMP%\\merge-new-password.json）`)
} else if (already.length) {
  console.log('users: 旧 id 已存在，跳过（幂等）')
} else {
  console.log('users: 新库无重复账号行，跳过')
}
console.log('\nprep 完成，可以跑 migrate-neon-merge.mjs')
