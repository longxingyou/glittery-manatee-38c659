import { createFileRoute } from '@tanstack/react-router'

import { useT } from '@/lib/i18n'
import { handleSitemap } from './api.comments'

// /sitemap.xml：文件路由用 [.] 表示 URL 中的字面量句点（同 rss.xml）。
// 必须用文件路由：只有文件路由的 server.handlers 会在客户端构建中剥离，
// 避免把 db/SSR 链拖进客户端 bundle。
export const Route = createFileRoute('/sitemap.xml')({
  server: {
    handlers: {
      GET: ({ request }) => handleSitemap(request),
    },
  },
  component: SitemapInfoPage,
})

// 浏览器直接访问 /sitemap.xml 时返回可读说明页（服务端 GET 仍直接输出 XML）
function SitemapInfoPage() {
  const t = useT()
  return (
    <div
      style={{
        padding: '80px 40px',
        maxWidth: 720,
        margin: '0 auto',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        color: 'var(--text, #111)',
      }}
    >
      <h1 style={{ marginBottom: 10 }}>{t('shell.sitemap')}</h1>
      <p>{t('sitemap.info.desc')}</p>
      <p>
        <a href="/sitemap.xml" style={{ color: 'var(--accent, #087f6d)' }}>
          /sitemap.xml
        </a>
      </p>
    </div>
  )
}
