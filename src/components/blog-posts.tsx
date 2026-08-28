import { Link } from '@tanstack/react-router'
import { ArrowUpRight, CalendarDays, Clock3, Hash, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Post } from 'content-collections'

export default function BlogPosts({ title, posts }: { title: string; posts: Post[] }) {
  const [visibleCount, setVisibleCount] = useState(6)
  const sentinel = useRef<HTMLDivElement>(null)
  const categories = useMemo(() => Array.from(new Set(posts.flatMap((post) => post.categories))), [posts])

  useEffect(() => {
    setVisibleCount(6)
  }, [posts])

  useEffect(() => {
    const node = sentinel.current
    if (!node) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setVisibleCount((count) => Math.min(count + 4, posts.length))
    }, { rootMargin: '300px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [posts.length])

  return (
    <div className="page-view">
      <div className="tabs-row"><div className="editor-tab active"><span className="md-icon">M↓</span>{title === '全部文章' ? 'README.md' : `${title}.md`}<span className="tab-dot" /></div></div>
      <div className="editor-scroll">
        <section className="hero-section">
          <div className="line-numbers" aria-hidden="true"><span>01</span><span>02</span><span>03</span><span>04</span><span>05</span><span>06</span></div>
          <div className="hero-copy">
            <div className="eyebrow"><Sparkles size={14} /> DIGITAL FIELD NOTES · VOL. 08</div>
            <h1><span>把想法写成</span><strong>可运行的文字。</strong></h1>
            <p>一个关于代码、设计、独立创作与理性浪漫的知识花园。支持 Markdown、LaTeX，以及慢慢生长的讨论。</p>
            <div className="hero-code"><span className="code-key">const</span> curiosity = <span className="code-string">"always_on"</span><span>;</span><span className="cursor" /></div>
          </div>
          <div className="hero-orbit" aria-hidden="true"><div className="orbit-ring"><span>∑</span></div><code>ideas.map(<b>build</b>)</code></div>
        </section>

        <section className="feed-header">
          <div><span className="comment-token">//</span><h2>{title}</h2><span className="count-badge">{posts.length}</span></div>
          <p>按下滚动键，瀑布流会继续加载。</p>
        </section>

        {title === '全部文章' && <div className="category-strip"><Hash size={14} />{categories.map((category) => <Link key={category} to="/category/$category" params={{ category }}>{category}</Link>)}</div>}

        <div className="masonry-grid">
          {posts.slice(0, visibleCount).map((post, index) => (
            <Link to="/posts/$slug" params={{ slug: post.slug }} key={post._meta.path} className={`post-card tone-${(index % 5) + 1}`}>
              <article>
                <div className="card-top"><span className="file-kind">{index % 3 === 0 ? 'TSX' : index % 3 === 1 ? 'MD' : 'JSON'}</span><span>{String(index + 1).padStart(2, '0')}</span></div>
                <div className="card-symbol" aria-hidden="true">{['λ', '{}', '∿', '◌', '⌁'][index % 5]}</div>
                <div className="card-content">
                  <div className="card-tags">{post.categories.slice(0, 2).map((category) => <span key={category}>#{category}</span>)}</div>
                  <h3>{post.title}</h3>
                  <p>{post.summary}</p>
                  <div className="card-meta"><span><CalendarDays size={13} />{post.date}</span><span><Clock3 size={13} />{post.readingTime} 分钟</span><ArrowUpRight size={17} /></div>
                </div>
              </article>
            </Link>
          ))}
        </div>
        <div ref={sentinel} className="feed-sentinel">{visibleCount < posts.length ? <><span /><span /><span /> 正在读取更多笔记</> : '// 已到达当前知识边界'}</div>
      </div>
    </div>
  )
}
