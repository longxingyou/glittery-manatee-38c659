import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ArrowLeft, CalendarDays, Check, Clock3, Hash, Share2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { ArticleOutline } from '@/components/article-outline'
import { CommentSection } from '@/components/comment-section'
import { AttachmentPanel, publicServerFns } from '@/components/public-fns'
import { getPostSiblings, type PostData } from '@/lib/utils'
import { renderMarkdown } from '@/lib/markdown'
import { useMermaidLazy } from '@/lib/use-mermaid'
import { useT, useCatName } from '@/lib/i18n'

export const Route = createFileRoute('/posts/$slug')({
  loader: async ({ params }) => {
    // 直接按 slug 查单篇（静态文章零成本，DB 文章单条查询），不再拉全量文章列表
    const post = await publicServerFns.getPublishedPostFn({ data: { slug: params.slug } })
    if (post) {
      // 无翻译组的文章 siblings 就是自身，无需拉全量列表；有翻译组才查同组兄弟
      const siblings = post.translationKey
        ? getPostSiblings(await publicServerFns.publishedPostsFn(), post.slug)
        : [post]
      return { post, siblings }
    }
    // 草稿预览兜底：后台"预览"指向 /posts/{slug}，草稿不在已发布列表；
    // adminPostPreviewFn 内部 requireAdmin，非管理员/无效 slug 仍走 404
    const draft = await publicServerFns.adminPostPreviewFn({ data: { slug: params.slug } }).catch(() => null)
    if (draft) return { post: draft, siblings: [] }
    throw notFound()
  },
  component: RouteComponent,
  head: ({ loaderData }) => ({
    meta: loaderData
      ? [
          { title: `${loaderData.post.title} · 笔记` },
          { name: 'description', content: loaderData.post.summary },
        ]
      : [],
  }),
})

/** 复制文本：优先 Clipboard API（需安全上下文），降级到 execCommand */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 剪贴板权限被拒或 webview 不支持，走兜底 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

function RouteComponent() {
  const t = useT()
  const catName = useCatName()
  const { post, siblings } = Route.useLoaderData()
  const [copied, setCopied] = useState(false)
  const articleRef = useRef<HTMLDivElement>(null)
  useMermaidLazy(articleRef)

  // 分享：优先系统分享面板（iOS Safari / Android Chrome）；
  // 微信/QQ 等内置浏览器不支持 navigator.share 时降级为复制链接，
  // 避免 `navigator.share?.()` 在不支持的环境下静默无响应。
  const handleShare = async () => {
    const url = location.href
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: post.title, url })
        return
      } catch (e) {
        // 用户取消分享（AbortError）属正常操作，不提示也不降级
        if (e instanceof DOMException && e.name === 'AbortError') return
      }
    }
    const ok = await copyText(url)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } else {
      // 极端兜底：弹窗让用户手动复制
      window.prompt(t('post.share.prompt'), url)
    }
  }

  return (
    <div className="page-view">
      <div className="tabs-row"><div className="editor-tab active"><span className="md-icon">M↓</span>{post.slug}.md<span className="tab-dot" /></div></div>
      <div className="article-scroll">
        <div className="article-shell">
          <article className="article-page">
          <Link to="/" className="back-link" title={t('post.back.title')}><ArrowLeft size={15} />{t('post.back')}</Link>
          <header className="article-header">
            <div className="article-kicker">// FIELD_NOTE_{post.date.replaceAll('-', '')}</div>
            <h1>{post.title}</h1>
            <p>{post.summary}</p>
            <div className="article-meta">
              <span title={t('post.meta.date')}><CalendarDays size={14} />{post.date}</span>
              <span title={t('post.meta.reading')}><Clock3 size={14} />{t('post.reading', { n: post.readingTime })}</span>
              <span title={t('post.meta.categories')}><Hash size={14} />{post.categories.map((c: string) => catName(c)).join(' · ')}</span>
              <button onClick={() => void handleShare()} className={copied ? 'share-copied' : ''} title={t('post.share.title')}>
                {copied ? <><Check size={14} />{t('post.share.copied')}</> : <><Share2 size={14} />{t('post.share')}</>}
              </button>
            </div>
            {siblings.length > 1 && (
              <div className="post-lang-bar">
                <span className="post-lang-label">{t('post.lang')}</span>
                <div className="post-lang-seg">
                  {siblings.map((s: PostData) => s.slug === post.slug
                    ? <span key={s.slug} className="post-lang-btn on" aria-current="true">{t(`lang.${s.language}`)}</span>
                    : <Link key={s.slug} className="post-lang-btn" to="/posts/$slug" params={{ slug: s.slug }}>{t(`lang.${s.language}`)}</Link>)}
                </div>
              </div>
            )}
          </header>
          <div className="article-rule" />
          <div
            ref={articleRef}
            className="markdown-body"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(post.content) }}
          />
          <AttachmentPanel postSlug={post.slug} />
          <CommentSection postSlug={post.slug} />
          </article>
          <ArticleOutline containerRef={articleRef} slug={post.slug} />
        </div>
      </div>
    </div>
  )
}
