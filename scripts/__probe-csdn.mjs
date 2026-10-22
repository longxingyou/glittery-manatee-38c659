import { readFileSync } from 'node:fs'
import { neon } from '@neondatabase/serverless'

for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim())
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const sql = neon(process.env.NETLIFY_DB_URL || process.env.DATABASE_URL)

async function main() {
  const row = await sql`SELECT token_secret FROM settings WHERE id = 1`
  const secret = row[0]?.token_secret
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
  const users = await sql`SELECT id, email FROM users WHERE confirmed_at IS NOT NULL`
  const admin = users.find((u) => adminEmails.includes(u.email.toLowerCase()))

  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ sub: admin.id, email: admin.email, exp: Date.now() + 3600 * 1000 }))
  const key = await crypto.subtle.importKey('raw', fromHex(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`)))
  const token = `${header}.${payload}.${b64url(sig)}`

  // 测试 CSDN 各种 URL 格式
  const tests = [
    'https://blog.csdn.net/',
    'https://www.csdn.net/',
    // 真实 CSDN 文章（从搜索引擎随便找的几个）
    'https://blog.csdn.net/qq_36120342/article/details/108505128',
    'https://blog.csdn.net/weixin_44617651/article/details/130198354',
    // 用户名子域格式
    'https://qq_36120342.blog.csdn.net/article/details/108505128',
    // 下载/资源站
    'https://download.csdn.net/',
    // 学习站
    'https://edu.csdn.net/',
  ]
  for (const u of tests) {
    console.log(`\n=== ${u} ===`)
    const res = await fetch('https://wow.xn--fpr224a.mom/api/net?action=fetch&u=' + encodeURIComponent(u), {
      headers: { cookie: `sg_auth=${token}` },
    }).catch((e) => ({ ok: false, status: 0, json: async () => ({ ok: false, error: String(e) }) }))
    const data = await res.json()
    console.log('  ok:', data.ok, 'upstream:', data.status, 'err:', data.error || '')
    if (data.ok) {
      console.log('  ct:', data.contentType, 'bodyLen:', data.body?.length)
      const m = /<title>([^<]+)<\/title>/i.exec(data.body || '')
      if (m) console.log('  title:', m[1].slice(0, 80))
    }
  }
  process.exit(0)
}

function b64url(buf) {
  const bytes = typeof buf === 'string' ? new TextEncoder().encode(buf) : new Uint8Array(buf)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
main().catch((e) => { console.error(e); process.exit(1) })
