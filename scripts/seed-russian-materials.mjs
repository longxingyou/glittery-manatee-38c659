/**
 * Seed Russian learning materials as DB attachments.
 *
 * Usage:
 *   node scripts/seed-russian-materials.mjs
 *
 * Reads DATABASE_URL from .dev.vars, then inserts every file in
 * content/russian-materials/ as a base64 attachment against the
 * post slug "russian-learning-materials".
 *
 * After seeding, each file is previewable at:
 *   /preview/<id>
 *
 * Re-runnable: if the same filename already exists for the post slug,
 * the old row is deleted first (idempotent replace).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// ── Read DATABASE_URL from .dev.vars ──
function readDevVars() {
  try {
    const text = readFileSync(join(ROOT, '.dev.vars'), 'utf-8')
    const match = text.match(/^DATABASE_URL\s*=\s*(.+)$/m)
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : ''
  } catch {
    return ''
  }
}

const DATABASE_URL = process.env.DATABASE_URL || readDevVars()
if (!DATABASE_URL) {
  console.error('DATABASE_URL not found. Set it in .dev.vars or as env var.')
  process.exit(1)
}

// ── MIME types ──
const MIME = {
  '.opml': 'text/x-opml',
  '.mm': 'application/x-freemind',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.html': 'text/html',
}

// ── Dynamic import of neon ──
const { neon } = await import('@neondatabase/serverless')
const sql = neon(DATABASE_URL)

const MATERIALS_DIR = join(ROOT, 'content', 'russian-materials')
const POST_SLUG = 'russian-learning-materials'

const files = readdirSync(MATERIALS_DIR).filter((f) => {
  const ext = extname(f).toLowerCase()
  return ext in MIME
})

if (files.length === 0) {
  console.error('No material files found in', MATERIALS_DIR)
  process.exit(1)
}

console.log(`Found ${files.length} files to seed:\n`)

let seeded = 0
let skipped = 0

for (const filename of files) {
  const filepath = join(MATERIALS_DIR, filename)
  const ext = extname(filename).toLowerCase()
  const mime = MIME[ext] || 'application/octet-stream'
  const buf = readFileSync(filepath)
  const sizeBytes = buf.byteLength
  const base64Content = buf.toString('base64')

  // Idempotent UPSERT: if attachment exists (same filename + postSlug), UPDATE content;
  // otherwise INSERT. This keeps preview IDs stable across re-runs.
  const existing = await sql`
    SELECT id FROM attachments
    WHERE post_slug = ${POST_SLUG} AND filename = ${filename}
    LIMIT 1
  `

  let id
  if (existing.length > 0) {
    id = existing[0].id
    await sql`
      UPDATE attachments
      SET content = ${base64Content},
          mime_type = ${mime},
          size_bytes = ${sizeBytes},
          storage_key = NULL,
          preview_state = 'unsupported'
      WHERE id = ${id}
    `
    console.log(`  ↻ ${filename} (${(sizeBytes / 1024).toFixed(1)} KB) updated → /preview/${id}`)
    seeded++
  } else {
    const [row] = await sql`
      INSERT INTO attachments (post_slug, filename, content, storage_key, mime_type, size_bytes, downloads, preview_state, preview_attempts)
      VALUES (${POST_SLUG}, ${filename}, ${base64Content}, NULL, ${mime}, ${sizeBytes}, 0, 'unsupported', 0)
      RETURNING id
    `
    id = row?.id ?? '?'
    console.log(`  ✓ ${filename} (${(sizeBytes / 1024).toFixed(1)} KB) inserted → /preview/${id}`)
    seeded++
  }
}

console.log(`\nDone: ${seeded} seeded, ${skipped} skipped.`)
console.log(`\nPreview URLs (prepend your site origin):`)
console.log(`  e.g. https://wow.xn--fpr224a.mom/preview/<id>`)
