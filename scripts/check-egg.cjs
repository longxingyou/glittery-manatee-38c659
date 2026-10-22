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

  // 查 post_eggs 表结构
  const cols = await sql`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = 'post_eggs'
    ORDER BY ordinal_position
  `
  console.log('=== post_eggs 表结构 ===')
  for (const row of cols) {
    console.log(row)
  }

  // 查 post_eggs 数据
  const eggs = await sql`SELECT post_slug, enabled, LEFT(html, 200) as html_preview FROM post_eggs`
  console.log('\n=== post_eggs 数据 ===')
  for (const row of eggs) {
    console.log({ slug: row.post_slug, enabled: row.enabled, htmlPreview: row.html_preview })
  }

  // 查 posts 表中是否有 six-games
  const posts = await sql`SELECT slug, status FROM posts WHERE slug = 'six-games'`
  console.log('\n=== posts 表 six-games ===')
  console.log(posts)
}

main().catch(e => { console.error(e); process.exit(1) })
