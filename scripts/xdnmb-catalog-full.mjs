/**
 * X岛 catalog 全版面补充扫描（GitHub Actions nightly 运行）。
 *
 * 爬虫 Worker 的 6h catalog cron 有 45 subrequest 预算限制，每轮只能扫
 * ~5 个版面 × 10 页。此脚本在 GitHub Actions 中运行（无 subrequest 限制），
 * 一次性扫完所有版面所有页，发现的未索引串入队 D1 recrawl_queue（dueAt=0），
 * 由爬虫 Worker 5min cron 拉取并完整爬取。
 *
 * 环境变量（GitHub Secrets）：
 *   CLOUDFLARE_API_TOKEN    有 D1 写权限的 API token
 *   CLOUDFLARE_ACCOUNT_ID   Cloudflare 账号 ID
 *   D1_DATABASE_ID          xdnmb-index 的 database_id
 *   XDNMB_USERHASH          X岛饼干（可选，读取受限版面需登录态）
 *   TG_GATEWAY_URL          可选，Azure 网关地址（GitHub Actions IP 可能被 403）
 *   TG_GATEWAY_SECRET       可选，网关 HMAC 密钥
 *
 * 用法（本地测试）：
 *   $env:CLOUDFLARE_API_TOKEN='...'; $env:CLOUDFLARE_ACCOUNT_ID='...'; $env:D1_DATABASE_ID='...'; $env:XDNMB_USERHASH='...'; node scripts/xdnmb-catalog-full.mjs
 */
import crypto from 'node:crypto'

const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID
const D1_DATABASE_ID = process.env.D1_DATABASE_ID
const XDNMB_USERHASH = process.env.XDNMB_USERHASH || ''
const GW_URL = (process.env.TG_GATEWAY_URL || '').trim().replace(/\/+$/, '')
const GW_SECRET = process.env.TG_GATEWAY_SECRET || ''

if (!CF_API_TOKEN || !CF_ACCOUNT_ID || !D1_DATABASE_ID) {
  console.error('缺少环境变量：CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID')
  process.exit(1)
}

const D1_API = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`
const X_API = 'https://api.nmb.best/api'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

// ── D1 REST API ──

async function d1Query(sql, params = []) {
  const res = await fetch(D1_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  })
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`D1 API ${res.status}: ${txt.slice(0, 300)}`)
  }
  const json = await res.json()
  if (!json.success) throw new Error(`D1 错误: ${JSON.stringify(json.errors ?? json).slice(0, 300)}`)
  return json.result?.[0]?.results ?? []
}

// ── 网关签名 ──

function signGwToken(payload, ttlMs) {
  const exp = Date.now() + ttlMs
  const data = `bili.${exp}.${payload}`
  const sig = crypto.createHmac('sha256', GW_SECRET).update(data).digest('base64url')
  return `${exp}.${Buffer.from(payload).toString('base64url')}.${sig}`
}

// ── X岛 API fetcher ──

async function xFetch(path, userhash) {
  // 网关优先（GitHub Actions IP 可能被 api.nmb.best 403）
  if (GW_URL && GW_SECRET) {
    try {
      const token = signGwToken(`xdnmb.api.${path}.${userhash}`, 5 * 60 * 1000)
      const gwUrl = `${GW_URL}/xdnmb?k=api&p=${encodeURIComponent(path)}` +
        (userhash ? `&uh=${encodeURIComponent(userhash)}` : '')
      const r = await fetch(gwUrl, { headers: { 'x-sg-bili': token } })
      if (r.ok) return await parseXResponse(r, path)
      if (r.status >= 400 && r.status < 500) return await parseXResponse(r, path)
    } catch { /* 网关不可达：走直连 */ }
  }
  // 直连
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const r = await fetch(`${X_API}/${path}`, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...(userhash ? { Cookie: `userhash=${userhash}` } : {}),
      },
    })
    return await parseXResponse(r, path)
  } finally {
    clearTimeout(timer)
  }
}

async function parseXResponse(r, path) {
  const text = await r.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    if (!r.ok) throw new Error(`X岛 ${path} HTTP ${r.status}`)
    throw new Error(text.slice(0, 120) || 'X岛返回了无法解析的响应')
  }
  if (!r.ok) {
    const msg = data?.error || (typeof data === 'string' ? data : `HTTP ${r.status}`)
    throw new Error(msg)
  }
  if (data?.success === false) throw new Error(data?.error || 'X岛返回错误')
  if (typeof data === 'string') throw new Error(data)
  return data
}

// ── toPlain（与 xdnmb-api.ts 一致） ──

function toPlain(html) {
  if (!html) return ''
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&bull;/g, '•')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000)
}

// ── 主流程 ──

function flattenForumIds(groups) {
  const ids = []
  for (const g of groups) {
    for (const f of g.forums || []) {
      if (f.id) ids.push({ id: f.id, name: f.name || f.showName || f.id })
    }
  }
  return ids
}

async function main() {
  console.log('[catalog-full] 开始全版面扫描')
  const uh = XDNMB_USERHASH

  // 1. 获取版面列表
  const forums = await xFetch('getForumList', uh)
  const fids = flattenForumIds(forums)
  console.log(`[catalog-full] ${fids.length} 个版面`)

  let scanned = 0
  let queued = 0
  let errors = 0

  // 2. 逐版面翻页扫描
  for (const f of fids) {
    let page = 1
    let emptyPages = 0
    while (emptyPages < 3) { // 连续 3 个空页 = 版面扫完
      let posts
      try {
        posts = await xFetch(`showf?id=${encodeURIComponent(f.id)}&page=${page}`, uh)
      } catch (e) {
        errors++
        console.error(`[catalog-full] ${f.name} page ${page} 错误: ${e.message}`)
        break
      }
      if (!posts || !posts.length) {
        emptyPages++
        page++
        continue
      }
      emptyPages = 0

      for (const p of posts) {
        const tid = Number(p.id)
        if (!Number.isFinite(tid) || tid <= 0) continue
        const replyCount = Number(p.ReplyCount ?? 0)
        // 检查 D1 是否已有此串
        const rows = await d1Query(
          'SELECT reply_count FROM xdnmb_index_threads WHERE id = ?1 AND deleted_at IS NULL LIMIT 1',
          [tid],
        )
        const existing = rows[0]
        if (!existing || Number(existing.reply_count) < replyCount) {
          // 入队 recrawl（dueAt=0 立即待爬）
          await d1Query(
            `INSERT INTO xdnmb_index_recrawl_queue (thread_id, due_at, status, attempts, updated_at)
             VALUES (?1, 0, 'pending', 0, unixepoch())
             ON CONFLICT(thread_id) DO UPDATE SET due_at = 0, status = 'pending', updated_at = unixepoch()`,
            [tid],
          )
          queued++
        }
      }
      scanned++
      page++
      // 每 50 页打印一次进度
      if (page % 50 === 0) console.log(`[catalog-full] ${f.name} page ${page}...`)
    }
    console.log(`[catalog-full] ${f.name} 扫完 (${page} 页)`)
  }

  console.log(`[catalog-full] 完成：扫描 ${scanned} 页，入队 ${queued} 串，错误 ${errors}`)
}

main().catch((e) => {
  console.error('[catalog-full] 致命错误:', e)
  process.exit(1)
})
