// 检查线上 Neon posts 表是否有 downloadable 列（用项目已有的 @neondatabase/serverless）
const { neon } = require('@neondatabase/serverless')
const fs = require('fs')
const path = require('path')

function loadDatabaseUrl() {
  const envPath = path.join(__dirname, '..', '.dev.vars')
  const content = fs.readFileSync(envPath, 'utf8')
  const match = content.match(/^DATABASE_URL=(.+)$/m)
  if (!match) throw new Error('DATABASE_URL not found in .dev.vars')
  return match[1].trim()
}

async function main() {
  const url = loadDatabaseUrl()
  const sql = neon(url)

  // 1. 检查列是否存在
  const colRes = await sql`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = 'posts'
    ORDER BY ordinal_position
  `
  console.log('=== posts 表所有列 ===')
  for (const row of colRes) {
    console.log(`${row.column_name} | ${row.data_type} | nullable=${row.is_nullable} | default=${row.column_default}`)
  }

  const hasDownloadable = colRes.some(r => r.column_name === 'downloadable')
  console.log('\n=== downloadable 列存在? ===', hasDownloadable)

  // 2. 尝试带 downloadable 查询，看是否报错
  console.log('\n=== 模拟线上查询（含 downloadable） ===')
  try {
    const q = await sql`
      SELECT id, slug, title, status, downloadable FROM posts LIMIT 3
    `
    console.log('查询成功，行数:', q.length)
    for (const row of q) {
      console.log(row)
    }
  } catch (e) {
    console.error('查询报错:', e.code, e.message)
  }

  // 3. 如果不存在，执行迁移
  if (!hasDownloadable) {
    console.log('\n=== 执行迁移：添加 downloadable 列 ===')
    await sql`ALTER TABLE posts ADD COLUMN IF NOT EXISTS downloadable BOOLEAN NOT NULL DEFAULT FALSE`
    console.log('迁移完成')
    // 再次验证
    const verify = await sql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'posts' AND column_name = 'downloadable'
    `
    console.log('验证:', verify.length > 0 ? '列已存在' : '列仍不存在')
  }
}

main().catch(e => { console.error(e); process.exit(1) })
