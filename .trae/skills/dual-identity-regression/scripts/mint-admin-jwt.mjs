// 为本地 E2E 自签管理员 sg_auth JWT。
// 用法：在项目根目录执行  node .trae/skills/dual-identity-regression/scripts/mint-admin-jwt.mjs [输出目录]
// 输出：<输出目录>/auth.json  { email, token }，默认输出目录 %TEMP%\sg-e2e
// 原理：sg_auth 是 HS256 JWT（sub/email/exp），签名密钥在 Neon settings 表 id=1 的 token_secret；
//       用 .dev.vars 的 DATABASE_URL 直查库自签，与 /api/auth 登录产物等价，无需走 UI。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { neon } from '@neondatabase/serverless'

const outDir = process.argv[2] || join(process.env.TEMP || '.', 'sg-e2e')

const vars = {}
for (const line of readFileSync('.dev.vars', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
  if (m) vars[m[1]] = m[2]
}
if (!vars.DATABASE_URL) throw new Error('.dev.vars 缺少 DATABASE_URL')
const adminEmail = (vars.ADMIN_EMAILS || '').split(/[,\s]+/)[0]
if (!adminEmail) throw new Error('.dev.vars 缺少 ADMIN_EMAILS')

const sql = neon(vars.DATABASE_URL)
const [u] = await sql`SELECT id, email FROM users WHERE email = ${adminEmail} AND confirmed_at IS NOT NULL LIMIT 1`
if (!u) throw new Error('未找到已确认的管理员用户：' + adminEmail)
const [s] = await sql`SELECT token_secret AS secret FROM settings WHERE id = 1`
if (!s?.secret) throw new Error('settings.token_secret 缺失')

const toB64Url = (buf) => Buffer.from(buf).toString('base64url')
const enc = new TextEncoder()
const keyBytes = Uint8Array.from(Buffer.from(s.secret, 'hex'))
const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
const header = toB64Url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
const body = toB64Url(enc.encode(JSON.stringify({ sub: u.id, email: u.email, exp: Date.now() + 86400_000 })))
const sig = toB64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${header}.${body}`))))
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, 'auth.json')
writeFileSync(outFile, JSON.stringify({ email: u.email, token: `${header}.${body}.${sig}` }))
console.log('minted for', u.email, '->', outFile)
