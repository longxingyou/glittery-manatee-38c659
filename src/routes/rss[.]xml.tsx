import { createFileRoute } from '@tanstack/react-router'

import { useLang, useT } from '@/lib/i18n'
import type { PostLanguage } from '@/lib/utils'
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

const FEED_LANGS: PostLanguage[] = ['zh', 'en', 'ru']

// 浏览器直接访问 /rss.xml 时返回可读说明页（阅读器/抓取器直接得到 XML）
function RssInfoPage() {
  const t = useT()
  const lang = useLang()
  return (
    <div
      style={{
        padding: '80px 40px',
        maxWidth: 720,
        margin: '0 auto',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        color: 'var(--text, #111)',
        lineHeight: 1.7,
      }}
    >
      <h1 style={{ marginBottom: 10 }}>{t('shell.rss')}</h1>
      <p>{t('rss.info.desc')}</p>
      <p style={{ color: 'var(--text-dim, #666)', fontSize: 14 }}>{t('rss.info.langs')}</p>
      <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 10 }}>
        {FEED_LANGS.map((feedLang) => {
          const cleanHref = feedLang === 'zh' ? '/rss.xml' : `/rss.xml?lang=${feedLang}`
          return (
            <li key={feedLang}>
              <a
                href={`${cleanHref}${feedLang === 'zh' ? '?' : '&'}raw=1`}
                style={{ color: 'var(--accent, #087f6d)', fontSize: 16 }}
              >
                {t(`lang.${feedLang}`)}
                {feedLang === 'zh' ? t('rss.info.default') : ''}
              </a>
              {feedLang === lang ? (
                <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-dim, #888)' }}>●</span>
              ) : null}
              <div style={{ fontSize: 13, color: 'var(--text-dim, #888)' }}>{cleanHref}</div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
