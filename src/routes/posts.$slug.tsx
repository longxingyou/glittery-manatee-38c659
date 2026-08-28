import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { allPosts } from 'content-collections'
import { ArrowLeft, CalendarDays, Clock3, Hash, Share2 } from 'lucide-react'
import { CommentSection } from '@/components/comment-section'
import { renderMarkdown } from '@/lib/markdown'

export const Route = createFileRoute('/posts/$slug')({
  loader: async ({ params }) => {
    const post = allPosts.find((entry) => entry.slug === params.slug)
    if (!post) throw notFound()
    return post
  },
  component: RouteComponent,
})

function RouteComponent() {
  const post = Route.useLoaderData()
  return <div className="page-view"><div className="tabs-row"><div className="editor-tab active"><span className="md-icon">M↓</span>{post.slug}.md<span className="tab-dot" /></div></div><div className="article-scroll"><article className="article-page"><Link to="/" className="back-link"><ArrowLeft size={15} />返回知识流</Link><header className="article-header"><div className="article-kicker">// FIELD_NOTE_{post.date.replaceAll('-', '')}</div><h1>{post.title}</h1><p>{post.summary}</p><div className="article-meta"><span><CalendarDays size={14} />{post.date}</span><span><Clock3 size={14} />{post.readingTime} 分钟阅读</span><span><Hash size={14} />{post.categories.join(' · ')}</span><button onClick={() => navigator.share?.({ title: post.title, url: location.href })}><Share2 size={14} />分享</button></div></header><div className="article-rule" /><div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(post.content) }} /><CommentSection postSlug={post.slug} /></article></div></div>
}
