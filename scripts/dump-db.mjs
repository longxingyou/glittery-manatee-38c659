// 通用 Neon/Postgres 逻辑备份：所有 public 表 → gzip JSON
// 用法：node dump-db.mjs <DATABASE_URL> <输出路径> [标签]
import { createRequire } from 'node:module'
import { createGzip } from 'node:zlib'
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { dirname } from 'node:path'

const root = 'c:/Projects/my-website/glittery-manatee-38c659'
const req = createRequire(root + '/package.json')
const [urlArg, outPath, label = 'db'] = process.argv.slice(2)
if (!urlArg || !outPath) { console.error('usage: node dump-db.mjs <url|current> <out> [label]'); process.exit(1) }
// 传 current 时自动读 .dev.vars 的 DATABASE_URL，避免在命令行暴露连接串
let url = urlArg
if (urlArg === 'current') {
  const txt = readFileSync(root + '/.dev.vars', 'utf8')
  for (const line of txt.split('\n')) {
    const m = /^DATABASE_URL=(.*)$/.exec(line.trim())
    if (m) { url = m[1]; break }
  }
}

const { neon } = req('@neondatabase/serverless')
const sql = neon(url)
const host = new URL(url.replace('postgresql://', 'http://')).host
console.log(`[dump] host=${host} label=${label}`)

const tables = await sql`select table_name from information_schema.tables
  where table_schema='public' and table_type='BASE TABLE' order by table_name`

const meta = { label, host, dumpedAt: new Date().toISOString(), tables: {}, rows: {} }
for (const t of tables) {
  const name = t.table_name
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const rows = await sql.query(`select * from "${name}"`)
      meta.rows[name] = rows
      meta.tables[name] = rows.length
      console.log(`  ${name}: ${rows.length}`)
      break
    } catch (e) {
      if (attempt === 3) throw e
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

mkdirSync(dirname(outPath), { recursive: true })
await pipeline(Readable.from([JSON.stringify(meta)]), createGzip({ level: 9 }), createWriteStream(outPath))
console.log(`[dump] wrote ${outPath}`)
