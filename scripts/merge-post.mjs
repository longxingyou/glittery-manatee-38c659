/**
 * 合并 Phase C（post）：migrate 完成后执行。
 *   1. 回写新库密码哈希到归位后的 users 行（migrate 的 PREFER_OLD 会用旧哈希整行覆盖）
 *   2. settings 字段级合并：拿回旧库的站点标题/描述/X岛 userhash/cookie_name，
 *      保留新库的 token_secret（换它会让所有登录会话失效）与 feed_uuid（订阅连续性）
 *   3. 全表对账：旧库行数 vs 新库行数
 *
 *   $env:OLD_DB_URL='...旧库...'; node scripts/merge-post.mjs
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'

const require = createRequire('c:/Projects/my-website/glittery-manatee-38c659/package.json')
const { neon } = require('@neondatabase/serverless')

const OLD_URL = process.env.OLD_DB_URL
const NEW_URL = readFileSync('.dev.vars', 'utf8').split(/\r?\n/)
  .map((l) => l.match(/^\s*DATABASE_URL\s*=\s*(.*)$/))
  .find(Boolean)?.[1]?.trim().replace(/^["']|["']$/g, '')
const oldSql = neon(OLD_URL)
const newSql = neon(NEW_URL)

const OLD_UID = '9eb73ea7a6c58ac3023498d79cd87e70'

// ── 1. 密码回写 ──
const pwFile = `${process.env.TEMP}\\merge-new-password.json`
if (existsSync(pwFile)) {
  const saved = JSON.parse(readFileSync(pwFile, 'utf8'))
  await newSql.query('UPDATE users SET password_hash = $1, password_salt = $2 WHERE id = $3',
    [saved.password_hash, saved.password_salt, OLD_UID])
  console.log(`users: 已回写当前密码哈希到 ${OLD_UID.slice(0, 8)}…（登录密码不变）`)
} else {
  console.log('users: 无密码存档，跳过回写（用户需用旧库密码或走找回流程）')
}

// ── 2. settings 字段级合并 ──
const [o] = await oldSql.query('SELECT * FROM settings WHERE id = 1')
if (o) {
  await newSql.query(
    `UPDATE settings SET site_title = $1, site_description = $2,
       xdnmb_userhash = COALESCE($3, xdnmb_userhash),
       xdnmb_cookie_name = COALESCE($4, xdnmb_cookie_name)
     WHERE id = 1`,
    [o.site_title, o.site_description, o.xdnmb_userhash, o.xdnmb_cookie_name],
  )
  const [after] = await newSql.query('SELECT site_title, site_description, xdnmb_cookie_name, left(token_secret, 8) AS ts, xdnmb_feed_uuid FROM settings WHERE id = 1')
  console.log('settings 合并后:', JSON.stringify(after))
}

// ── 3. 对账 ──
const TABLES = [
  'users', 'settings', 'posts', 'comments', 'categories', 'attachments',
  'post_eggs', 'profiles', 'warnings', 'net_share_links', 'net_share_bindings',
  'ru_share_links', 'ru_share_bindings', 'xdnmb_cookies', 'xdnmb_favs',
  'xdnmb_my_posts', 'xdnmb_subs',
]
console.log('\n=== 对账（旧 / 新 / 期望=旧+新库原有）===')
const newBefore = {
  users: 1, settings: 0, posts: 2, comments: 0, categories: 0, attachments: 5,
  post_eggs: 1, profiles: 0, warnings: 0, net_share_links: 1, net_share_bindings: 3,
  ru_share_links: 1, ru_share_bindings: 15, xdnmb_cookies: 0, xdnmb_favs: 0,
  xdnmb_my_posts: 0, xdnmb_subs: 0,
}
let okAll = true
for (const t of TABLES) {
  const oRows = await oldSql.query(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [t])
  if (!oRows[0].n) { console.log(`· ${t}: 旧库无此表，跳过`); continue }
  const [o2] = await oldSql.query(`SELECT count(*)::int AS n FROM "${t}"`)
  const [n2] = await newSql.query(`SELECT count(*)::int AS n FROM "${t}"`)
  const expect2 = o2.n + (newBefore[t] ?? 0)
  const ok = n2.n === expect2
  if (!ok) okAll = false
  console.log(`${ok ? '✓' : '✗'} ${t}: 旧=${o2.n} 新=${n2.n} 期望=${expect2}`)
}
console.log(okAll ? '\n对账通过' : '\n对账有出入，请检查上方 ✗ 项')
