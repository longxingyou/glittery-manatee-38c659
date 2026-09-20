import { createFileRoute, Link } from '@tanstack/react-router'
import { CalendarDays } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { publicServerFns } from '@/components/public-fns'
import { foldPostsForLang, type PostData } from '@/lib/utils'
import { useT, useLang } from '@/lib/i18n'

export const Route = createFileRoute('/archive')({
  component: RouteComponent,
  loader: async () => {
    const all = await publicServerFns.publishedPostsFn()
    return { posts: [...all].sort((a, b) => b.date.localeCompare(a.date)) }
  },
  head: () => ({ meta: [{ title: '归档 · 笔记' }] }),
})

/** 用 Intl 取本地化月份名（如 一月 / January / Январь） */
function monthLabels(locale: string): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { month: 'long' })
  return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2000, i, 1)))
}

function groupByYearMonth(posts: PostData[]) {
  const map = new Map<string, Map<string, PostData[]>>()
  for (const p of posts) {
    const [y, m] = p.date.split('-')
    if (!map.has(y)) map.set(y, new Map())
    const yearMap = map.get(y)!
    if (!yearMap.has(m)) yearMap.set(m, [])
    yearMap.get(m)!.push(p)
  }
  // 年份倒序、月份倒序
  return [...map.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([year, months]) => ({
      year,
      months: [...months.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([month, list]) => ({ month, posts: list })),
    }))
}

function RouteComponent() {
  const t = useT()
  const lang = useLang()
  const dateLocale = lang === 'zh' ? 'zh-CN' : lang === 'ru' ? 'ru-RU' : 'en-US'
  const { posts } = Route.useLoaderData()
  // 同一篇文章的多语言版本在归档中只保留当前语言版本
  const visiblePosts = useMemo(() => foldPostsForLang(posts, lang), [posts, lang])
  const groups = useMemo(() => groupByYearMonth(visiblePosts), [visiblePosts])
  const total = visiblePosts.length
  const monthNames = monthLabels(dateLocale)

  useEffect(() => {
    document.title = `${t('archive.title')} · 笔记`
  }, [t])

  return (
    <div className="page-view">
      <div className="tabs-row">
        <div className="editor-tab active"><span className="md-icon">M↓</span>archive.md<span className="tab-dot" /></div>
      </div>
      <div className="article-scroll">
        <article className="article-page">
          <header className="article-header">
            <h1>{t('archive.title')}</h1>
            <p className="article-meta">
              <CalendarDays size={14} /> {t('archive.count', { n: total })}
            </p>
          </header>

          <div className="archive-list">
            {groups.map(({ year, months }) => (
              <section key={year} className="archive-year">
                <h2 className="archive-year-title">{year}</h2>
                {months.map(({ month, posts: list }) => (
                  <div key={month} className="archive-month">
                    <h3 className="archive-month-title">{monthNames[parseInt(month, 10) - 1] || month}</h3>
                    <ul className="archive-posts">
                      {list.map((p) => (
                        <li key={p.slug} className="archive-post-item">
                          <Link to="/posts/$slug" params={{ slug: p.slug }} className="archive-post-link">
                            <span className="archive-post-date">{p.date.slice(5)}</span>
                            <span className="archive-post-title">{p.title}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            ))}
            {total === 0 && <p className="archive-empty">{t('archive.empty')}</p>}
          </div>
        </article>
      </div>
    </div>
  )
}

export default RouteComponent
