/**
 * 旧 Neon 项目 → 新 Neon 项目：站点数据全量搬回（幂等，可重复执行）。
 *
 * 背景：旧项目的 compute 额度被 cron 保活烧穿后被 Neon 冻结（查询返回 402），
 * 数据并未删除；新项目 webnew 是空库。等旧项目额度重置恢复可读后，用本脚本
 * 把站点数据（users / 评论 / 反馈 / X岛个人数据 / settings…）搬到新库。
 *
 * 不搬的表：xdnmb_index_threads / xdnmb_index_posts / xdnmb_index_cursors
 *   —— X岛搜索索引已迁到 Cloudflare D1（以 D1 为准），旧 Neon 里那几张表已弃用。
 *
 * 用法（PowerShell）：
 *   $env:OLD_DATABASE_URL='<旧项目连接串>'   # Neon 控制台 → 旧项目 → Connection string
 *   $env:DATABASE_URL='<新项目连接串>'       # 不给则自动读 .dev.vars / .env
 *   node scripts/migrate-neon-merge.mjs
 *
 * 合并策略：新库已有的行不覆盖（ON CONFLICT DO NOTHING）；users 以旧库为准
 *   （同 id 覆盖，email 撞车时逐行跳过并告警），settings 保留新库的 token_secret。
 * 结束后自动推进序列并逐表对账（旧库行数 vs 新库行数）。
 */
import { neon } from '@neondatabase/serverless'
import { existsSync, readFileSync } from 'node:fs'

const SKIP_TABLES = new Set(['xdnmb_index_threads', 'xdnmb_index_posts', 'xdnmb_index_cursors'])
const PREFER_OLD_TABLES = new Set(['users'])
/** 先搬的表：被别的表外键引用的排前面 */
const FIRST_TABLES = ['users', 'settings']
const BATCH = 100

function readEnvFileKey(file, key) {
  if (!existsSync(file)) return ''
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/)
    if (m && m[1] === key) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  return ''
}
function firstNonEmpty(...vals) {
  for (const v of vals) if (v && String(v).trim()) return String(v).trim()
  return ''
}
const NEW_URL = firstNonEmpty(
  process.env.NEW_DATABASE_URL,
  process.env.DATABASE_URL,
  readEnvFileKey('.dev.vars', 'DATABASE_URL'),
  readEnvFileKey('.env', 'DATABASE_URL'),
  readEnvFileKey('.env', 'NETLIFY_DB_URL'),
)
const OLD_URL = firstNonEmpty(process.env.OLD_DATABASE_URL)

if (!OLD_URL) {
  console.error('缺少 OLD_DATABASE_URL（旧项目连接串）。示例：')
  console.error("  $env:OLD_DATABASE_URL='postgresql://...@ep-xxx-pooler...neon.tech/neondb?sslmode=require'")
  process.exit(1)
}
if (!NEW_URL) {
  console.error('缺少新库连接串（DATABASE_URL / NEW_DATABASE_URL，或 .dev.vars 里的 DATABASE_URL）。')
  process.exit(1)
}
const mask = (u) => u.replace(/:\/\/[^@]*@/, '://***@')

const oldSql = neon(OLD_URL)
const newSql = neon(NEW_URL)

async function listTables(sql) {
  const rows = await sql.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  )
  return rows.map((r) => r.table_name)
}
async function listColumns(sql, t) {
  return sql.query(
    `SELECT column_name, data_type, udt_name, is_nullable, column_default,
            character_maximum_length, numeric_precision, numeric_scale
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [t],
  )
}
async function primaryKey(sql, t) {
  const rows = await sql.query(
    `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = 'public' AND tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position`,
    [t],
  )
  return rows.map((r) => r.column_name)
}
/** 表上是否存在唯一索引（无主键但有唯一索引时，ON CONFLICT DO NOTHING 才有意义） */
async function hasUniqueIndex(sql, t) {
  const rows = await sql.query(
    `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 AND indexdef LIKE 'CREATE UNIQUE INDEX%' LIMIT 1`,
    [t],
  )
  return rows.length > 0
}
async function rowCount(sql, t) {
  const r = await sql.query(`SELECT COUNT(*)::int AS c FROM "${t}"`)
  return r[0].c
}

/** information_schema 的列类型 → 建表用的 SQL 类型（用于新库缺表时补建） */
function ddlType(c) {
  if (c.column_default && String(c.column_default).startsWith('nextval(')) {
    if (c.udt_name === 'int2') return 'smallserial'
    if (c.udt_name === 'int8') return 'bigserial'
    return 'serial'
  }
  const u = c.udt_name
  if (u.startsWith('_')) return ddlType({ ...c, udt_name: u.slice(1), column_default: null }) + '[]'
  switch (u) {
    case 'int2': return 'smallint'
    case 'int4': return 'integer'
    case 'int8': return 'bigint'
    case 'float4': return 'real'
    case 'float8': return 'double precision'
    case 'bool': return 'boolean'
    case 'numeric': return `numeric(${c.numeric_precision ?? 38},${c.numeric_scale ?? 10})`
    case 'varchar': return `varchar(${c.character_maximum_length ?? 255})`
    case 'bpchar': return `char(${c.character_maximum_length ?? 1})`
    case 'timestamp': return 'timestamp'
    case 'timestamptz': return 'timestamptz'
    case 'date': return 'date'
    case 'json': return 'json'
    case 'jsonb': return 'jsonb'
    case 'uuid': return 'uuid'
    case 'bytea': return 'bytea'
    default: return 'text'
  }
}
function buildCreate(t, cols, pk) {
  const defs = cols.map((c) => {
    const type = ddlType(c)
    const isSerial = type.endsWith('serial')
    const def = !isSerial && c.column_default ? ` DEFAULT ${c.column_default}` : ''
    return `  "${c.column_name}" ${type}${c.is_nullable === 'NO' ? ' NOT NULL' : ''}${def}`
  })
  if (pk.length) defs.push(`  PRIMARY KEY (${pk.map((c) => `"${c}"`).join(', ')})`)
  return `CREATE TABLE IF NOT EXISTS "${t}" (\n${defs.join(',\n')}\n)`
}

/** 参数携带显式类型转换，避免驱动把时间/数值当文本传导致类型推断失败 */
function castFor(c) {
  const u = c.udt_name
  if (u.startsWith('_')) return 'text[]'
  switch (u) {
    case 'int2': case 'int4': case 'int8': case 'numeric':
    case 'float4': case 'float8': case 'bool': case 'timestamptz':
    case 'timestamp': case 'date': case 'json': case 'jsonb':
    case 'uuid': case 'bytea':
      return u
    default: return 'text'
  }
}
function normalizeValue(c, v) {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString().replace('T', ' ').replace('Z', '+00')
  const u = c.udt_name
  if (u === 'json' || u === 'jsonb') return typeof v === 'string' ? v : JSON.stringify(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (u.startsWith('_') && Array.isArray(v)) {
    return `{${v.map((x) => `"${String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`
  }
  return v
}

async function insertRows(table, cols, colMeta, pk, rows) {
  if (!rows.length) return { inserted: rows.length, skipped: 0, errors: [] }
  const valuesSql = rows
    .map((_, i) => `(${cols.map((c, j) => `$${i * cols.length + j + 1}::${castFor(colMeta.get(c))}`).join(', ')})`)
    .join(', ')
  const setClause = cols.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ')
  const conflict = PREFER_OLD_TABLES.has(table) && pk.length
    ? `ON CONFLICT (${pk.map((c) => `"${c}"`).join(', ')}) DO UPDATE SET ${setClause}`
    : 'ON CONFLICT DO NOTHING'
  const params = rows.flatMap((row) => cols.map((c) => normalizeValue(colMeta.get(c), row[c])))
  await newSql.query(
    `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES ${valuesSql} ${conflict}`,
    params,
  )
  return { inserted: rows.length, skipped: 0, errors: [] }
}

async function copyTable(table) {
  const [oldCols, newCols] = await Promise.all([listColumns(oldSql, table), listColumns(newSql, table)])
  if (!oldCols.length) return { table, note: '旧库无此表，跳过' }

  const pk = await primaryKey(oldSql, table)
  if (!pk.length && !(await hasUniqueIndex(oldSql, table))) {
    return { table, note: '无主键/唯一索引，跳过（重复执行会插入重复行，需先手动加唯一约束）' }
  }
  if (!newCols.length) {
    await newSql.query(buildCreate(table, oldCols, pk))
    console.log(`  · 新库缺表，已按旧库结构补建：${table}`)
  }
  const targetCols = (newCols.length ? newCols : oldCols).map((c) => c.column_name)
  const oldColSet = new Set(oldCols.map((c) => c.column_name))
  const cols = targetCols.filter((c) => oldColSet.has(c))
  const dropped = oldCols.filter((c) => !targetCols.includes(c.column_name)).map((c) => c.column_name)
  if (dropped.length) console.log(`  · ${table}: 旧库有而新库没有的列未搬（${dropped.join(', ')}）`)

  const meta = new Map((newCols.length ? newCols : oldCols).map((c) => [c.column_name, c]))
  const total = await rowCount(oldSql, table)
  let done = 0
  const errors = []
  for (let offset = 0; offset < total; offset += BATCH) {
    const rows = await oldSql.query(
      `SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${table}" ORDER BY ctid LIMIT ${BATCH} OFFSET ${offset}`,
    )
    if (!rows.length) break
    try {
      await insertRows(table, cols, meta, pk, rows)
    } catch (err) {
      // 整批失败（如唯一约束/外键）时逐行重试，只记录真正失败的行
      for (const row of rows) {
        try {
          await insertRows(table, cols, meta, pk, [row])
        } catch (e2) {
          errors.push(`${table} 行 ${pk.length ? pk.map((k) => row[k]).join('/') : JSON.stringify(row).slice(0, 80)}: ${e2.message}`)
        }
      }
    }
    done += rows.length
  }
  const after = await rowCount(newSql, table)
  return { table, old: total, new: after, copied: done, errors }
}

async function advanceSequences(table) {
  const cols = await listColumns(newSql, table)
  for (const c of cols) {
    if (!c.column_default || !String(c.column_default).startsWith('nextval(')) continue
    try {
      await newSql.query(
        `SELECT setval(pg_get_serial_sequence('"${table}"', '${c.column_name}'),
                       GREATEST((SELECT COALESCE(MAX("${c.column_name}"), 0) FROM "${table}"), 1))`,
      )
    } catch (e) {
      console.log(`  · 序列推进失败 ${table}.${c.column_name}: ${e.message}`)
    }
  }
}

/** users 表预检：两边都有账号时先亮明，避免"新注册的临时账号"与旧账号撞车 */
async function reportUsers(oldTables, newTables) {
  if (!oldTables.includes('users') || !newTables.includes('users')) return
  const [o, n] = await Promise.all([
    oldSql.query('SELECT id, email, confirmed_at FROM "users" ORDER BY id'),
    newSql.query('SELECT id, email, confirmed_at FROM "users" ORDER BY id'),
  ])
  const fmt = (rows) => (rows.length ? rows.map((r) => `#${r.id} ${r.email}${r.confirmed_at ? '' : '(未验证)'}`).join(' | ') : '（空）')
  console.log('users 预检：')
  console.log(`  旧库 ${o.length} 个：${fmt(o)}`)
  console.log(`  新库 ${n.length} 个：${fmt(n)}`)
  if (o.length && n.length) {
    const emails = new Set(o.map((r) => r.email))
    if (n.some((r) => emails.has(r.email))) {
      console.log('  ⚠️ 两边存在同邮箱账号：本脚本按 id 覆盖（以旧库为准），')
      console.log('     若 id 不同会因 email 唯一约束跳过该行 —— 需要人工决定保留哪个账号。')
    }
  }
  console.log('')
}

async function main() {
  console.log(`旧库：${mask(OLD_URL)}`)
  console.log(`新库：${mask(NEW_URL)}\n`)

  const [oldTables, newTables] = await Promise.all([listTables(oldSql), listTables(newSql)])
  await reportUsers(oldTables, newTables)
  let list = oldTables.filter((t) => !SKIP_TABLES.has(t))
  list = [...FIRST_TABLES.filter((t) => list.includes(t)), ...list.filter((t) => !FIRST_TABLES.includes(t))]
  const onlyNew = newTables.filter((t) => !oldTables.includes(t))
  if (onlyNew.length) console.log(`新库有而旧库没有的表（不处理）：${onlyNew.join(', ')}\n`)

  const results = []
  for (const table of list) {
    try {
      const r = await copyTable(table)
      if (r.note) console.log(`  · ${table}：${r.note}`)
      else {
        results.push(r)
        const flag = r.old === r.new || r.new >= r.old ? '✅' : '⚠️'
        console.log(`  ${flag} ${table}: 旧库 ${r.old} 行 → 新库 ${r.new} 行`)
        for (const e of r.errors) console.log(`      ✗ ${e}`)
      }
      await advanceSequences(table)
    } catch (err) {
      console.log(`  ✗ ${table} 迁移失败：${err.message}`)
    }
  }

  const bad = results.filter((r) => r.old !== r.new || r.errors.length)
  console.log(bad.length ? `\n⚠️ 有 ${bad.length} 张表行数未对齐或有失败行，见上；脚本可重复执行补齐。` : '\n✅ 全部表行数对齐。')
}

main().catch((e) => {
  console.error('\n迁移失败：', e.message)
  process.exit(1)
})
