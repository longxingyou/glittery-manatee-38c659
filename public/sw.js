/**
 * Syntax Garden Service Worker — 离线阅读已访问文章
 *
 * 策略（保证在线用户始终拿到新鲜内容，离线用户能回看已访问页）：
 *   · 导航/HTML 请求：network-first。在线时取最新并回填缓存（绝不向在线
 *     用户返回旧 HTML）；离线时回退到最近一次访问的缓存副本。
 *   · 静态资源（/assets/* 哈希产物、字体、图片等）：cache-first。这些是
 *     immutable 哈希文件，永久缓存安全，省去重复下载。
 *   · /api/*、/admin/*、/preview/* 一律不拦截：动态数据与门禁页必须实时回源。
 *
 * 版本号变更（CACHE 常量）会触发 activate 清理旧缓存。无 Service-Worker-Allowed
 * 限制，scope 默认为站点根。
 */
const CACHE = 'sg-cache-v1'
const ASSETS_RE = /^\/(assets|stickers)\//
const STATIC_EXT_RE = /\.(?:woff2?|ttf|css|js|png|jpe?g|gif|webp|svg|ico|webmanifest|txt|map)$/
const SKIP_RE = /^\/(api|admin|preview\/)/

self.addEventListener('install', (event) => {
  // 跳过等待，让新版 SW 立即接管，避免用户停留在旧 SW
  void self.skipWaiting()
  event.waitUntil(Promise.resolve())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 清理一切非当前版本的缓存，释放配额
    const keys = await caches.keys()
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  // 仅处理同源 GET；跨域资源（如 http.cat）交给浏览器默认行为
  if (url.origin !== self.location.origin) return
  // 动态接口与门禁页不缓存，必须实时回源
  if (SKIP_RE.test(url.pathname)) return

  const isStaticAsset = ASSETS_RE.test(url.pathname) || STATIC_EXT_RE.test(url.pathname)
  const isNavigation =
    req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')

  // 静态资源：cache-first（immutable 哈希产物可永久复用）
  if (isStaticAsset && !isNavigation) {
    event.respondWith((async () => {
      const cached = await caches.match(req)
      if (cached) return cached
      try {
        const res = await fetch(req)
        if (res.ok && res.type !== 'opaque') {
          const cache = await caches.open(CACHE)
          cache.put(req, res.clone())
        }
        return res
      } catch {
        return new Response('', { status: 504, statusText: 'Offline' })
      }
    })())
    return
  }

  // 导航/HTML：network-first，在线取最新并回填，离线回退缓存
  if (isNavigation) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req)
        // 仅缓存成功（2xx）的 HTML，避免把错误页缓存住
        if (res.ok && res.type !== 'opaque') {
          const cache = await caches.open(CACHE)
          cache.put(req, res.clone())
        }
        return res
      } catch {
        const cached = await caches.match(req)
        if (cached) return cached
        return new Response(
          '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>离线</title></head><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#333"><h1>当前处于离线状态</h1><p>该页面尚未缓存，请联网后重试。已访问过的文章在离线时仍可阅读。</p><p><a href="/">返回首页</a></p></body></html>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        )
      }
    })())
    return
  }
  // 其余同源 GET（如动态 RSS）不拦截，交给浏览器
})
