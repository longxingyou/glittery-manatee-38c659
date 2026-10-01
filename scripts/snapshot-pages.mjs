/**
 * 构建后页面快照：把关键列表页 SSR 成静态 HTML 写入 dist/client，
 * 部署后由 Cloudflare Assets 边缘直接服务（首次访问零 SSR / 零 DB / 零 KV 额度）。
 *
 * 背景：HTML 三级缓存（内存 → edge → KV）只能加速回访；首次访问（冷 colo +
 * 冷 isolate）缓存全 miss，必须回源 SSR，root loader 与页面 loader 都要打
 * Neon（1~7s，弱网下更长）。快照把这些页面变成"静态资产"，CF 全球边缘秒出。
 *
 * 快照页面：
 *   /            → dist/client/index.html
 *   /archive     → dist/client/archive.html
 *   /category/*  → dist/client/category/<name>.html（从首页/归档页链接中发现）
 *
 * 新鲜度：部署时点的列表 + 客户端 usePublishedPosts SWR 补拉（新增/删除均修正）。
 * 文章页内容会经后台编辑，不做快照，保持 SSR + 三级缓存链路。
 *
 * 降级保护：响应带 X-DB-Degraded: 1（Neon 冷启动超时只拿到静态文章）时
 * 不写快照，运行时继续走原 SSR 链路，避免把降级页固化到边缘。
 *
 * 用法：vite build 之后、wrangler deploy 之前运行（deploy 脚本已串联）。
 * 任何失败仅告警并以 0 退出——部署流程不应被快照阻断，代价只是退回原行为。
 */
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distClient = path.join(root, 'dist', 'client')
const PORT = Number(process.env.SNAPSHOT_PORT || 4599)
const BASE = `http://127.0.0.1:${PORT}`
const PAGE_TIMEOUT_MS = 60_000

const log = (...a) => console.log('[snapshot]', ...a)
const warn = (...a) => console.warn('[snapshot] ⚠️', ...a)

/** 清掉上次构建的快照，避免本次快照命中旧资产（X-Cache: HIT-ASSET）自我复制 */
async function cleanPreviousSnapshots() {
  await rm(path.join(distClient, 'index.html'), { force: true })
  await rm(path.join(distClient, 'archive.html'), { force: true })
  await rm(path.join(distClient, 'category'), { recursive: true, force: true })
}

async function startPreview() {
  const { preview } = await import('vite')
  const server = await preview({
    root,
    logLevel: 'error',
    preview: { host: '127.0.0.1', port: PORT, strictPort: true },
  })
  return server
}

/** 轮询就绪：用静态资产路径探测（不触发 SSR），最多等 60s（miniflare 冷启动） */
async function waitUntilReady() {
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      const res = await fetch(`${BASE}/favicon.ico`, { signal: AbortSignal.timeout(5_000) })
      if (res.status < 600) return // 服务已应答（404 也算就绪）
    } catch { /* 未就绪，继续等 */ }
    if (Date.now() > deadline) throw new Error('preview server 未在 60s 内就绪')
    await new Promise((r) => setTimeout(r, 500))
  }
}

/**
 * 抓取并校验一个页面：200 且非 DB 降级才算有效快照。
 * 首次降级时等待 5s 重试一次（Neon 可能正在唤醒）。
 */
async function snapshotPage(pathname, outFile) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${BASE}${pathname}`, {
        headers: { accept: '*/*' }, // 跳过 worker 的 HTML 缓存读写，拿纯 SSR 结果
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      })
      const degraded = res.headers.get('X-DB-Degraded') === '1'
      if (res.status === 200 && !degraded) {
        const html = await res.text()
        await mkdir(path.dirname(outFile), { recursive: true })
        await writeFile(outFile, html)
        log(`✓ ${pathname} → ${path.relative(root, outFile)}（${(html.length / 1024).toFixed(1)}KB）`)
        return html
      }
      if (attempt === 1) {
        warn(`${pathname} ${degraded ? 'DB 降级' : `状态 ${res.status}`}，5s 后重试一次…`)
        await new Promise((r) => setTimeout(r, 5_000))
        continue
      }
      warn(`${pathname} 快照跳过（${degraded ? 'DB 降级' : `状态 ${res.status}`}），该路径运行时仍走 SSR`)
    } catch (err) {
      warn(`${pathname} 抓取失败：${err?.message ?? err}，该路径运行时仍走 SSR`)
    }
    return null
  }
}

/** 从 HTML 中发现 /category/ 链接（去重 + 解码，上限 30 个） */
function discoverCategoryLinks(html) {
  const found = new Set()
  for (const m of html.matchAll(/href="\/category\/([^"]+)"/g)) {
    try { found.add(decodeURIComponent(m[1])) } catch { /* 跳过畸形编码 */ }
    if (found.size >= 30) break
  }
  return [...found]
}

async function main() {
  if (!existsSync(distClient)) {
    warn('dist/client 不存在，请先运行 vite build')
    return
  }
  await cleanPreviousSnapshots()

  const server = await startPreview()
  try {
    await waitUntilReady()

    const homeHtml = await snapshotPage('/', path.join(distClient, 'index.html'))
    const archiveHtml = await snapshotPage('/archive', path.join(distClient, 'archive.html'))

    const catNames = new Set([
      ...(homeHtml ? discoverCategoryLinks(homeHtml) : []),
      ...(archiveHtml ? discoverCategoryLinks(archiveHtml) : []),
    ])
    for (const name of catNames) {
      await snapshotPage(`/category/${encodeURIComponent(name)}`, path.join(distClient, 'category', `${name}.html`))
    }
    log(`完成：1 首页 + 1 归档 + ${catNames.size} 分类页`)
  } finally {
    try { server.httpServer.close() } catch { /* ignore */ }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    warn(`快照流程失败（部署继续，运行时退回 SSR 链路）：${err?.message ?? err}`)
    process.exit(0)
  })
