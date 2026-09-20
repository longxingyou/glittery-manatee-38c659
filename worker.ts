/**
 * Cloudflare Worker 自定义入口。
 * - 所有请求（SSR / Server Functions / /api/* 文件路由 / 静态资源）先经过 TanStack Start 默认入口；
 * - 在响应上统一附加安全头（替代原 netlify.toml + inject-security-headers.mjs）；
 * - env（vars/secrets）在此注入到 src/lib/server-env，供服务端代码读取。
 */
import startHandler from '@tanstack/react-start/server-entry'

import { setWorkerEnv, type ServerEnv } from './src/lib/server-env'

// Assets 绑定（Cloudflare Workers 静态资源服务接口）
interface AssetsEnv extends ServerEnv {
  ASSETS?: { fetch: (request: Request) => Promise<Response> }
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
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:",
  // Vite 会把小于 4KB 的字体子集内联为 data: URL，需放行
  "font-src 'self' data:",
  "connect-src 'self'",
  `frame-src 'self' ${GAME_FRAME_ORIGINS.join(' ')}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ')

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  // HSTS：强制浏览器后续一律走 HTTPS（1 年，含子域）
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
}

function withSecurityHeaders(response: Response, request: Request): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value)
  }
  // 带内容哈希的静态资源（/assets/xxx-[hash].css|js）可长期缓存
  const url = new URL(request.url)
  if (url.pathname.startsWith('/assets/')) {
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  }
  // body 是流式 SSR 输出时也只能原样透传，避免缓冲整页
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export default {
  async fetch(request: Request, env: AssetsEnv): Promise<Response> {
    setWorkerEnv(env)
    const url = new URL(request.url)

    // HTTP → HTTPS 自动重定向（本地 dev / wrangler 走 http 代理，豁免 localhost）
    if (url.protocol === 'http:' && !url.hostname.endsWith('localhost') && url.hostname !== '127.0.0.1') {
      url.protocol = 'https:'
      return Response.redirect(url.toString(), 301)
    }

    // 静态资源：通过 Assets 绑定服务并添加长期缓存头
    // /assets/* 文件名含内容哈希，可永久缓存
    // /stickers/* 和 /favicon.ico 变更频率极低
    const isStaticAsset =
      url.pathname.startsWith('/assets/') ||
      url.pathname.startsWith('/stickers/') ||
      url.pathname === '/favicon.ico'
    if (isStaticAsset && env.ASSETS) {
      const assetResponse = await env.ASSETS.fetch(request)
      if (assetResponse.status === 200) {
        const headers = new Headers(assetResponse.headers)
        if (url.pathname.startsWith('/assets/')) {
          headers.set('Cache-Control', 'public, max-age=31536000, immutable')
        } else {
          headers.set('Cache-Control', 'public, max-age=86400')
        }
        return new Response(assetResponse.body, {
          status: assetResponse.status,
          statusText: assetResponse.statusText,
          headers,
        })
      }
      // 静态资源未命中 → 继续走 SSR（可能是动态路由）
    }

    const response = await startHandler.fetch(request)
    return withSecurityHeaders(response, request)
  },
}
