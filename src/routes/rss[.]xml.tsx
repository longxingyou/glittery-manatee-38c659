import { createFileRoute } from '@tanstack/react-router'

import { useT } from '@/lib/i18n'
import { handleRss } from './api.comments'

// /rss.xml：文件路由用 [.] 表示 URL 中的字面量句点。
// 必须用文件路由而非 router.tsx 中的编程式 createRoute：
// 只有文件路由的 server.handlers 会被 Start 编译器在客户端构建中剥离，
// 编程式路由里静态引用 handleRss 会把 db → @tanstack/react-start/server
// 整条 SSR 链拖进客户端 bundle，导致 node:stream 在浏览器环境构建失败。
export const Route = createFileRoute('/rss.xml')({
  server: {
    handlers: {
      GET: ({ request }) => handleRss(request),
    },
  },
  component: RssInfoPage,
})

// 浏览器直接访问 /rss.xml 时返回可读说明页（服务端 GET 仍直接输出 XML）
function RssInfoPage() {
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
      <h1 style={{ marginBottom: 10 }}>{t('shell.rss')}</h1>
      <p>{t('rss.info.desc')}</p>
      <p>
        <a href="/rss.xml" style={{ color: 'var(--accent, #087f6d)' }}>
          /rss.xml
        </a>
      </p>
    </div>
  )
}
