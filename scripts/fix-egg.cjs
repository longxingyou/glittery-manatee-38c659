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

  // 1. 给 post_eggs 加 render_md 列
  console.log('=== 给 post_eggs 加 render_md 列 ===')
  await sql`ALTER TABLE post_eggs ADD COLUMN IF NOT EXISTS render_md BOOLEAN NOT NULL DEFAULT FALSE`
  console.log('render_md 列添加完成')

  // 2. 验证
  const cols = await sql`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = 'post_eggs'
    ORDER BY ordinal_position
  `
  console.log('\n=== post_eggs 最新结构 ===')
  for (const row of cols) {
    console.log(`${row.column_name} | ${row.data_type} | nullable=${row.is_nullable} | default=${row.column_default}`)
  }

  // 3. 检查 posts 表是否还有其他缺失列
  const postCols = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'posts'
  `
  const colNames = postCols.map(r => r.column_name)
  const expected = ['id', 'slug', 'title', 'summary', 'content', 'categories', 'status', 'date', 'language', 'translation_key', 'downloadable', 'created_at', 'updated_at']
  const missing = expected.filter(c => !colNames.includes(c))
  console.log('\n=== posts 表缺失列 ===', missing.length ? missing : '无')

  if (missing.length > 0) {
    for (const col of missing) {
      if (col === 'downloadable') {
        await sql`ALTER TABLE posts ADD COLUMN IF NOT EXISTS downloadable BOOLEAN NOT NULL DEFAULT FALSE`
        console.log(`已添加 posts.${col}`)
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
