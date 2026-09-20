import { Link } from '@tanstack/react-router'
import { ArrowUpRight, CalendarDays, Clock3, Hash, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { foldPostsForLang, type PostData } from '@/lib/utils'
import { useLang, useT, useCatName } from '@/lib/i18n'

export default function BlogPosts({ title, posts }: { title: string; posts: PostData[] }) {
  const t = useT()
  const lang = useLang()
  const catName = useCatName()
  const [visibleCount, setVisibleCount] = useState(6)
  const sentinel = useRef<HTMLDivElement>(null)
  // 同一篇文章的多语言版本只显示当前语言版本（缺失时回退）
  const visiblePosts = useMemo(() => foldPostsForLang(posts, lang), [posts, lang])
  const categories = useMemo(() => Array.from(new Set(visiblePosts.flatMap((post) => post.categories))), [visiblePosts])

  useEffect(() => {
    setVisibleCount(6)
  }, [visiblePosts])

  useEffect(() => {
    const node = sentinel.current
    if (!node) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setVisibleCount((count) => Math.min(count + 4, visiblePosts.length))
    }, { rootMargin: '300px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [visiblePosts.length])

  return (
    <div className="page-view">
      <div className="tabs-row"><div className="editor-tab active"><span className="md-icon">M↓</span>{title === t('shell.allposts') ? 'README.md' : `${title}.md`}<span className="tab-dot" /></div></div>
      <div className="editor-scroll">
        <section className="hero-section">
          <div className="line-numbers" aria-hidden="true"><span>01</span><span>02</span><span>03</span><span>04</span><span>05</span><span>06</span></div>
          <div className="hero-copy">
            <div className="eyebrow"><Sparkles size={14} /> DIGITAL FIELD NOTES · VOL. 08</div>
            <h1><span>{t('feed.hero.a')}</span><strong>{t('feed.hero.b')}</strong></h1>
            <p>{t('feed.hero.desc')}</p>
            <div className="hero-code"><span className="code-key">const</span> curiosity = <span className="code-string">"always_on"</span><span>;</span><span className="cursor" /></div>
          </div>
          <div className="hero-orbit" aria-hidden="true"><div className="orbit-ring"><span>∑</span></div><code>ideas.map(<b>build</b>)</code></div>
        </section>

        <section className="feed-header">
          <div><span className="comment-token">//</span><h2>{title}</h2><span className="count-badge">{visiblePosts.length}</span></div>
          <p>{t('feed.scroll.hint')}</p>
        </section>

        {title === t('shell.allposts') && <div className="category-strip"><Hash size={14} />{categories.map((category) => <Link key={category} to="/category/$category" params={{ category }}>{catName(category)}</Link>)}</div>}

        <div className="masonry-grid">
          {visiblePosts.slice(0, visibleCount).map((post, index) => (
            <Link to="/posts/$slug" params={{ slug: post.slug }} key={`${post.source}-${post.id ?? post.slug}`} className={`post-card tone-${(index % 5) + 1}`}>
              <article>
                <div className="card-top"><span className="file-kind">{index % 3 === 0 ? 'TSX' : index % 3 === 1 ? 'MD' : 'JSON'}</span><span>{String(index + 1).padStart(2, '0')}</span>{post.language !== lang && <span className="card-lang-badge" title={t('post.lang.other', { lang: t(`lang.${post.language}`) })}>{post.language.toUpperCase()}</span>}</div>
                <div className="card-symbol" aria-hidden="true">{['λ', '{}', '∿', '◌', '⌁'][index % 5]}</div>
                <div className="card-content">
                  <div className="card-tags">{post.categories.slice(0, 2).map((category) => <span key={category}>#{catName(category)}</span>)}</div>
                  <h3>{post.title}</h3>
                  <p>{post.summary}</p>
                  <div className="card-meta"><span><CalendarDays size={13} />{post.date}</span><span><Clock3 size={13} />{t('feed.minutes', { n: post.readingTime })}</span><ArrowUpRight size={17} /></div>
                </div>
              </article>
            </Link>
          ))}
        </div>
        <div ref={sentinel} className="feed-sentinel">{visibleCount < visiblePosts.length ? <><span /><span /><span /> {t('feed.loading.more')}</> : t('feed.end')}</div>
      </div>
    </div>
  )
}
