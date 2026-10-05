/**
 * Cloudflare Worker 自定义入口。
 * - 所有请求（SSR / Server Functions / /api/* 文件路由 / 静态资源）先经过 TanStack Start 默认入口；
 * - 在响应上统一附加安全头（替代原 netlify.toml + inject-security-headers.mjs）；
 * - env（vars/secrets）在此注入到 src/lib/server-env，供服务端代码读取。
 */
import startHandler from '@tanstack/react-start/server-entry'

import { setWorkerCtx, setWorkerEnv, setWorkerRequest, getEnv, type ServerEnv } from './src/lib/server-env'
import { TtlCache, safeKvGet, safeKvPut, edgeCacheGet, edgeCacheSet } from './src/lib/cache'

// Assets 绑定（Cloudflare Workers 静态资源服务接口）
interface AssetsEnv extends ServerEnv {
  ASSETS?: { fetch: (request: Request) => Promise<Response> }
}

// 结构类型，避免依赖 @cloudflare/workers-types 全局声明
interface ExecutionCtx {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException(): void
}

// 与 src/components/games-menu.tsx 的 GAME_FRAME_HOSTS 保持一致：
// 彩蛋小游戏中心允许 iframe 嵌入的第三方游戏站点。
const GAME_FRAME_ORIGINS = [
  'https://bil812.github.io',
  'https://chvin.github.io',
  'https://www.2048.org',
  'https://sudoku.com',
  // 月品木子（二字口令网盘/图床）：取件卡片预览 iframe
  'https://xn--cnqs3e5vdw9icjz2q1eaa.xyz',
]

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // Cloudflare 自动注入 Web Analytics / RUM beacon（static.cloudflareinsights.com）
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:",
  // Vite 会把小于 4KB 的字体子集内联为 data: URL，需放行
  "font-src 'self' data:",
  // beacon 上报到 cloudflareinsights.com；
  // *.hf.space 是自建附件网关的 HF Space 部署。网关若托管在其他主机
  // （VPS/Koyeb/Cloudflare Tunnel 域名），其 origin 由 TG_GATEWAY_URL
  // 动态追加，见 buildSecurityHeaders()。
  "connect-src 'self' https://cloudflareinsights.com https://static.cloudflareinsights.com https://*.hf.space",
  `frame-src 'self' ${GAME_FRAME_ORIGINS.join(' ')}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
]

/** 从 TG_GATEWAY_URL 提取可安全加入 CSP 的 origin（非法值返回空串） */
function gatewayOrigin(): string {
  const raw = (getEnv().TG_GATEWAY_URL || '').trim()
  if (!raw) return ''
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return ''
    const o = u.origin
    return o && o !== 'null' ? o : ''
  } catch {
    return ''
  }
}

/** 组装安全头；connect-src 按运行时网关地址放行（Hugging Face / VPS / 隧道通用） */
function buildSecurityHeaders(isEgg = false): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': isEgg ? 'SAMEORIGIN' : 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // HSTS：强制浏览器后续一律走 HTTPS（1 年，含子域）
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  }
  if (isEgg) {
    headers['Content-Security-Policy'] = EGG_CONTENT_SECURITY_POLICY
    return headers
  }
  const gw = gatewayOrigin()
  const csp = gw
    ? CONTENT_SECURITY_POLICY.map((d) =>
        d.startsWith('connect-src ') && !d.includes(gw) ? `${d} ${gw}` : d,
      )
    : CONTENT_SECURITY_POLICY
  headers['Content-Security-Policy'] = csp.join('; ')
  return headers
}

// 文章彩蛋（/egg/:slug）专用 CSP：
// - sandbox 指令使文档即使被直接打开（顶层导航）也运行在不透明源中：
//   内联脚本可执行，但拿不到站点 cookie/localStorage，同源 fetch 不带凭据；
// - allow-popups(-to-escape-sandbox) 保证彩蛋里的外链可正常新窗口打开；
// - connect-src 'none' 阻断脚本向外发请求；图片/字体允许 https:/data:（攻略类内容常用）；
// - frame-ancestors 'self' 允许被本站文章页 iframe 嵌入（替代默认的 'none'）。
const EGG_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  // 'self'：允许 <link> 加载 /assets/ 下的字体 CSS（与主站同一套字体）
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:",
  "font-src 'self' https: data:",
  "connect-src 'none'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  'sandbox allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads',
].join('; ')

function withSecurityHeaders(response: Response, request: Request): Response {
  const headers = new Headers(response.headers)
  const url = new URL(request.url)
  const isEgg = url.pathname.startsWith('/egg/')
  for (const [name, value] of Object.entries(buildSecurityHeaders(isEgg))) {
    headers.set(name, value)
  }
  // 后台（含访客门禁卡）不允许搜索引擎收录
  if (url.pathname.startsWith('/admin')) {
    headers.set('X-Robots-Tag', 'noindex, nofollow')
  }
  // 带内容哈希的静态资源（/assets/xxx-[hash].css|js）可长期缓存
  if (url.pathname.startsWith('/assets/')) {
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  }

  // ── 公开页面 SSR HTML 缓存（核心网络优化）──
  // 所有非 /admin 的页面 SSR 输出均不含个性化内容：登录态完全由客户端
  // onAuthChange 管理，用户面板是客户端弹窗，故 HTML 对所有访客一致。
  //   max-age=120                  浏览器 2 分钟内直接用本地缓存
  //   s-maxage=600                 Cloudflare 边缘共享缓存 10 分钟（跨访客）
  //   stale-while-revalidate=3600  过期后立即返回旧页并后台刷新，弱网/代理下零等待
  //   stale-if-error=86400         源站/DB 故障时仍提供 24h 内旧页，避免白屏
  // 这样在 Watt Toolkit 等代理或跨境网络中，回访几乎全部命中边缘缓存，无需回源。
  //
  // 但 DB 降级（仅静态文章）的响应绝不能 s-maxage：否则所有访客 10 分钟内都看不到
  // DB 文章。降级响应只给浏览器短缓存 + stale-while-revalidate，客户端补拉会修正。
  const isHtml = (response.headers.get('content-type') || '').includes('text/html')
  const isAdmin = url.pathname.startsWith('/admin')
  const isOk = response.status >= 200 && response.status < 300
  const dbDegraded = response.headers.get('X-DB-Degraded') === '1'
  if (isHtml && !isAdmin && isOk && !headers.has('Cache-Control')) {
    if (dbDegraded) {
      headers.set('Cache-Control', 'public, max-age=20, stale-while-revalidate=120, stale-if-error=600')
    } else {
      headers.set('Cache-Control', 'public, max-age=120, s-maxage=600, stale-while-revalidate=3600, stale-if-error=86400')
    }
    headers.set('Vary', 'Accept-Encoding')
  }

  // 关键：流式 SSR 响应的 body 是 ReadableStream，若保留原始 Content-Length，
  // 实际流出字节数可能与声明不符，Cloudflare 会判定响应损坏并返回 520。
  // 当 body 为流时必须删除 Content-Length（由传输层自动用 chunked 编码）。
  if (response.body !== null) {
    headers.delete('Content-Length')
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

// ────────────────────────────────────────────────────────────
// HTML 三级缓存（免费额度友好）
//   L1 进程内存 30s（同 isolate，零成本）
//   L2 caches.default 1h（Cloudflare 边缘缓存，免费且无使用次数限制，同 colo）
//   L3 KV 1h（跨 colo，免费版 1000 写/10 万读每天；带熔断器 + 写入节流）
// 即使 KV 日限额完全用尽，L1/L2 仍提供毫秒级命中；两者都 miss 时走 SSR，
// 数据层还有内存缓存与 Neon（cron 保活），任何时候都不向用户返回 429。
// ────────────────────────────────────────────────────────────
const HTML_MEM_TTL_MS = 30_000
const HTML_DEGRADED_MEM_TTL_MS = 3_000 // DB 降级页仅极短缓存，挡住同 isolate 并发雪崩
const HTML_EDGE_TTL_S = 3600
const HTML_KV_TTL_S = 3600
// KV 写入节流：同一 isolate 内同一路径 10 分钟最多写一次，
// 防止冷 colo 首访风暴把 1000 次/天的写额度快速消耗掉
const HTML_KV_WRITE_THROTTLE_MS = 600_000
const htmlMemCache = new TtlCache<string>(30)
const htmlKvWriteMark = new TtlCache<1>(200)

/** 用缓存的 HTML body 构造响应（必须重新附加安全头，缓存体里只有 SSR 内容）。 */
function cachedHtmlResponse(body: string, cacheStatus: string): Response {
  const headers = new Headers(buildSecurityHeaders())
  headers.set('Content-Type', 'text/html; charset=utf-8')
  headers.set('Cache-Control', 'public, max-age=120, s-maxage=600, stale-while-revalidate=3600, stale-if-error=86400')
  headers.set('Vary', 'Accept-Encoding')
  headers.set('X-Cache', cacheStatus)
  return new Response(body, { status: 200, headers })
}

export default {
  async fetch(request: Request, env: AssetsEnv, ctx: ExecutionCtx): Promise<Response> {
    setWorkerEnv(env)
    setWorkerCtx(ctx)
    setWorkerRequest(request)
    const url = new URL(request.url)

    // HTTP → HTTPS 自动重定向（本地 dev / wrangler 走 http 代理，豁免 localhost）
    if (url.protocol === 'http:' && !url.hostname.endsWith('localhost') && url.hostname !== '127.0.0.1') {
      url.protocol = 'https:'
      return Response.redirect(url.toString(), 301)
    }

    // 静态资源：通过 Assets 绑定服务并添加长期缓存头
    // /assets/* 文件名含内容哈希，可永久缓存
    // /stickers/* 和根目录静态文件（favicon/og 图等）变更频率极低；
    // 未命中 ASSETS 的路径（如 /rss.xml、/sitemap.xml 动态路由）会继续走 SSR
    const isStaticAsset =
      url.pathname.startsWith('/assets/') ||
      url.pathname.startsWith('/stickers/') ||
      /^\/[^/]+\.(?:png|jpe?g|gif|webp|svg|ico|webmanifest|txt)$/i.test(url.pathname)

    try {
      if (isStaticAsset && env.ASSETS) {
        const assetResponse = await env.ASSETS.fetch(request)
        if (assetResponse.status === 200) {
          const headers = new Headers(assetResponse.headers)
          if (url.pathname.startsWith('/assets/')) {
            headers.set('Cache-Control', 'public, max-age=31536000, immutable')
          } else {
            headers.set('Cache-Control', 'public, max-age=86400')
          }
          // 静态资源也删除 Content-Length，避免 body 流长度不一致
          headers.delete('Content-Length')
          return new Response(assetResponse.body, {
            status: assetResponse.status,
            statusText: assetResponse.statusText,
            headers,
          })
        }
        // 静态资源未命中 → 继续走 SSR（可能是动态路由）
      }

      // ── 预渲染页面直出（构建时快照的静态 HTML）──
      // 首次访问（冷 colo/冷 isolate）时三级缓存全 miss，必须回源 SSR 打 Neon
      // （1~7s），这是首页/归档/分类页首访慢的根因。scripts/snapshot-pages.mjs
      // 在构建后把这些页面快照成静态 HTML 资产（dist/client/index.html 等），
      // 这里优先直出：零 SSR、零 DB、零 KV 额度，由 CF 边缘资产存储服务。
      // 数据新鲜度由客户端 usePublishedPosts SWR 补拉兜底（新增/删除都修正）。
      // 未快照的路径（文章页等）ASSETS 返回 404 → 落回下面的 SSR + 三级缓存链路。
      // ?preview=1 是管理员实时预览，绝不能被部署时点快照顶替。
      // /egg/ 是彩蛋原始 HTML 出口（handler 自带缓存策略），不走资产直出。
      if (env.ASSETS && request.method === 'GET' && !url.pathname.startsWith('/admin') && !url.pathname.startsWith('/egg/') && url.searchParams.get('preview') !== '1') {
        try {
          const prerendered = await env.ASSETS.fetch(request)
          const isHtmlAsset =
            prerendered.status === 200 &&
            (prerendered.headers.get('content-type') || '').includes('text/html')
          if (isHtmlAsset) {
            const headers = new Headers(buildSecurityHeaders())
            headers.set('Content-Type', 'text/html; charset=utf-8')
            headers.set('Cache-Control', 'public, max-age=120, s-maxage=600, stale-while-revalidate=3600, stale-if-error=86400')
            headers.set('Vary', 'Accept-Encoding')
            headers.set('X-Cache', 'HIT-ASSET')
            // 资产 body 是流，必须删除 Content-Length（chunked 编码），防 520
            headers.delete('Content-Length')
            return new Response(prerendered.body, { status: 200, headers })
          }
        } catch { /* ASSETS 异常 → 继续走 SSR 链路 */ }
      }

      // ── HTML 三级缓存读取（仅公开页面，管理员页不缓存）──
      // 公开 HTML 对所有访客一致（登录态完全由客户端管理，无 set-cookie/个性化内容）。
      // /egg/ 彩蛋页由路由 handler 自带缓存头，不进入本缓存（管理员改彩蛋需即时生效）。
      const acceptsHtml = request.headers.get('accept')?.includes('text/html')
      const cacheableHtml =
        acceptsHtml && !url.pathname.startsWith('/admin') && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/egg/')
      const kv = env.SG_CACHE
      const htmlCacheKey = `html:${url.pathname}`
      // 边缘缓存键归一化为 origin+pathname：UTM 等 query 参数不影响 HTML 内容，
      // 避免 ?utm_source=xxx 之类链接把缓存打散成大量碎片
      const edgeCacheUrl = `${url.origin}${url.pathname}`
      // 管理员实时预览（?preview=1 且带登录 cookie）：绕过内存/edge/KV 全部读缓存，
      // 强制 SSR 拿 DB 最新内容（改稿即时可见）；是否真正为管理员由 loader 内
      // requireAdmin 把关，非管理员只是多走一次 SSR，无信息泄漏。
      const isPreviewRequest =
        url.searchParams.get('preview') === '1' &&
        (request.headers.get('cookie') || '').includes('sg_auth')
      if (cacheableHtml && !isPreviewRequest) {
        // L1：进程内存（~0ms，零额度）
        const memHit = htmlMemCache.get(htmlCacheKey)
        if (memHit) return cachedHtmlResponse(memHit, 'HIT-MEM')

        // L2：Cloudflare Cache API（~5ms，免费、无使用次数限制，同 colo 共享）
        const edgeHit = await edgeCacheGet(edgeCacheUrl)
        if (edgeHit) {
          htmlMemCache.set(htmlCacheKey, edgeHit, HTML_MEM_TTL_MS)
          return cachedHtmlResponse(edgeHit, 'HIT-EDGE')
        }

        // L3：KV（跨 colo；日限额熔断时 safeKvGet 直接返回 null，无缝降级 SSR）
        const kvHit = await safeKvGet(kv, htmlCacheKey)
        if (kvHit) {
          htmlMemCache.set(htmlCacheKey, kvHit, HTML_MEM_TTL_MS)
          // 回填 L2（免费），后续同 colo 请求不再消耗 KV 读额度
          try { ctx.waitUntil(edgeCacheSet(edgeCacheUrl, kvHit, HTML_EDGE_TTL_S)) } catch { /* ignore */ }
          return cachedHtmlResponse(kvHit, 'HIT-KV')
        }
      }

      const ssrStartedAt = Date.now()
      const response = await startHandler.fetch(request)
      const transformed = withSecurityHeaders(response, request)
      const ssrMs = Date.now() - ssrStartedAt

      // ── HTML 缓存写入 ──
      const isHtml = (transformed.headers.get('content-type') || '').includes('text/html')
      const isAdmin = url.pathname.startsWith('/admin')
      const isOk = transformed.status >= 200 && transformed.status < 300
      const dbDegraded = transformed.headers.get('X-DB-Degraded') === '1'
      const isPreviewHtml = isPreviewRequest && isHtml && isOk && transformed.headers.get('X-Preview') === '1'
      if (isPreviewHtml) {
        // 管理员实时预览版本：不写任何缓存（每次刷新都是 DB 最新稿），
        // 对浏览器/CDN 一律 no-store，并禁止搜索引擎收录预览 URL。
        const body = await transformed.text()
        const ret = new Response(body, {
          status: transformed.status,
          statusText: transformed.statusText,
          headers: transformed.headers,
        })
        ret.headers.set('Cache-Control', 'private, no-store, must-revalidate')
        ret.headers.set('X-Robots-Tag', 'noindex, nofollow')
        ret.headers.set('X-Cache', 'MISS-PREVIEW')
        return ret
      }
      if (isHtml && !isAdmin && isOk && cacheableHtml) {
        const body = await transformed.text()
        if (dbDegraded) {
          // DB 降级页（仅静态文章）：只做 3s 内存微缓存挡同 isolate 并发，
          // 绝不写 edge/KV——否则所有访客在缓存周期内都看不到 DB 文章
          htmlMemCache.set(htmlCacheKey, body, HTML_DEGRADED_MEM_TTL_MS)
          const degradedRet = new Response(body, {
            status: transformed.status,
            statusText: transformed.statusText,
            headers: transformed.headers,
          })
          degradedRet.headers.set('X-Cache', 'MISS-DEGRADED')
          return degradedRet
        }

        // 正常页：回填三级缓存
        htmlMemCache.set(htmlCacheKey, body, HTML_MEM_TTL_MS)
        try { ctx.waitUntil(edgeCacheSet(edgeCacheUrl, body, HTML_EDGE_TTL_S)) } catch { /* ignore */ }
        // KV 写入走熔断器 + 10 分钟/key/isolate 节流（写额度 1000 次/天，最稀缺）
        if (!htmlKvWriteMark.get(htmlCacheKey)) {
          htmlKvWriteMark.set(htmlCacheKey, 1, HTML_KV_WRITE_THROTTLE_MS)
          try { ctx.waitUntil(safeKvPut(kv, htmlCacheKey, body, HTML_KV_TTL_S).then(() => undefined)) } catch { /* ignore */ }
        }
        const ret = new Response(body, {
          status: transformed.status,
          statusText: transformed.statusText,
          headers: transformed.headers,
        })
        ret.headers.set('X-Cache', `MISS; ssr=${ssrMs}ms`)
        return ret
      }

      return transformed
    } catch (err) {
      // 未捕获异常（Neon 冷启动超时、DB 连接失败等）返回明确的 500 而非让 Cloudflare 报 520。
      // 520 是 Cloudflare 收到损坏/空响应时的错误，对用户不友好且无法被前端重试逻辑处理。
      console.error('[worker] fetch error:', err)
      const isHtml = request.headers.get('accept')?.includes('text/html')
      if (isHtml) {
        return new Response(
          '<!doctype html><html><head><meta charset="utf-8"><title>500 · 服务器开小差了</title>' +
          '<meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<style>body{font-family:system-ui,sans-serif;display:flex;flex-direction:column;' +
          'align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0d1117;color:#c9d1d9}' +
          'h1{font-size:48px;margin:0}p{color:#8b949e;margin:8px 0 24px}' +
          'a{color:#58a6ff;text-decoration:none;padding:8px 20px;border:1px solid #30363d;border-radius:6px}' +
          'a:hover{background:#161b22}</style></head>' +
          '<body><h1>500</h1><p>服务器暂时不可用，请稍后重试。</p>' +
          '<a href="/">返回首页</a></body></html>',
          {
            status: 500,
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
          },
        )
      }
      return new Response('Internal Server Error', {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    }
  },

  // Cron 触发器（每 5 分钟）：预热 Neon compute 避免休眠冷启动。
  // KV 额度优化：每次 cron 都跑 SELECT 1（0 KV 操作）；
  // 文章列表 KV 仅在计划分钟为 :00/:20/:40 时刷新（3 次/小时 = 72 次写/天，
  // 远低于免费版 1000 次写/天上限）。
  async scheduled(event: unknown, env: AssetsEnv, ctx: ExecutionCtx): Promise<void> {
    setWorkerEnv(env)
    const scheduledTime = (event as { scheduledTime?: number } | null)?.scheduledTime
    const minute = scheduledTime ? new Date(scheduledTime).getMinutes() : new Date().getMinutes()
    const refreshCache = minute % 20 === 0
    ctx.waitUntil(import('./db/index.js').then((m) => m.warmupDb(refreshCache)))
  },
}
