import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ArrowLeft, CalendarDays, Check, Clock3, Hash, Share2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArticleOutline } from '@/components/article-outline'
import { CommentSection } from '@/components/comment-section'
import { AttachmentPanel, publicServerFns } from '@/components/public-fns'
import { getPostSiblings, DEFAULT_SITE_TITLE, type PostData } from '@/lib/utils'
import { renderMarkdown, extractHeadingsFromHtml } from '@/lib/markdown'
import { useMermaidLazy } from '@/lib/use-mermaid'
import { getPublicOrigin } from '@/lib/server-env'
import { useT, useCatName } from '@/lib/i18n'

export const Route = createFileRoute('/posts/$slug')({
  // ?preview=1：管理员后台"预览"入口。绕开发布缓存直接读 DB 最新保存版本
  // （草稿与已发布文章的改稿都即时可见）；非管理员/未保存的 slug 仍 404。
  validateSearch: (search: Record<string, unknown>) => ({
    preview: search.preview === '1' || search.preview === true ? true : undefined,
  }),
  loader: async ({ params, location }) => {
    const slug = params.slug
    const isPreview = (location.search as { preview?: boolean }).preview === true
    // 文章列表与下面的 DB 读取并行（siblings 依赖列表，先把 Promise 挂出去）
    const listPromise = publicServerFns.publishedPostsFn().catch(() => null)
    // 彩蛋开关并行拉取（失败默认关闭，不阻断正文加载）
    const eggPromise = publicServerFns.postEggMetaFn({ data: { slug } }).catch(() => ({ enabled: false }))

    // 预览模式：管理员实时版本优先（内部 requireAdmin，非管理员返回 null）
    let post = null as Awaited<ReturnType<typeof publicServerFns.getPublishedPostFn>>
    if (isPreview) {
      post = await publicServerFns.adminPostPreviewFn({ data: { slug } }).catch(() => null)
    }
    // 普通访问（或预览兜底失败）：已发布缓存版本
    if (!post) {
      post = await publicServerFns.getPublishedPostFn({ data: { slug } })
    }
    const all = await listPromise
    const egg = await eggPromise

    if (post) {
      // 无翻译组的文章 siblings 就是自身；有翻译组且列表可用时才算同组兄弟
      const siblings = post.translationKey && all
        ? getPostSiblings(all, post.slug)
        : [post]
      return { post, siblings, egg }
    }
    // 非预览模式下 published 查不到时，再给草稿兜底（兼容历史无参预览链接）；
    // adminPostPreviewFn 内部 requireAdmin，非管理员/无效 slug 仍 404
    if (!isPreview) {
      const draft = await publicServerFns.adminPostPreviewFn({ data: { slug } }).catch(() => null)
      if (draft) return { post: draft, siblings: [], egg }
    }
    throw notFound()
  },
  component: RouteComponent,
  head: ({ loaderData }) => {
    if (!loaderData) return {}
    const { post } = loaderData
    // 规范 URL：跨账号代理下不能取 request.url（workers.dev 不可达）
    const origin = getPublicOrigin()
    const canonical = origin ? `${origin}/posts/${post.slug}` : `/posts/${post.slug}`
    const published = /^\d{4}-\d{2}-\d{2}$/.test(post.date) ? `${post.date}T00:00:00Z` : undefined
    // 结构化数据：BlogPosting（作者/发布方用站点品牌 handle，真实标识不虚构）
    const brand = DEFAULT_SITE_TITLE.split(' · ')[0] || DEFAULT_SITE_TITLE
    const articleLd = {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: post.title,
      description: post.summary,
      ...(published
        ? {
            datePublished: published,
            dateModified: post.updatedAt || published,
          }
        : {}),
      ...(post.categories.length ? { keywords: post.categories.join(', ') } : {}),
      ...(origin
        ? { url: canonical, mainEntityOfPage: canonical }
        : {}),
      author: { '@type': 'Person', name: brand },
      publisher: { '@type': 'Organization', name: brand },
    }
    return {
      meta: [
        { title: `${post.title} · 笔记` },
        { name: 'description', content: post.summary },
        { property: 'og:type', content: 'article' },
        { property: 'og:title', content: post.title },
        { property: 'og:description', content: post.summary },
        { property: 'og:url', content: canonical },
        { name: 'twitter:title', content: post.title },
        { name: 'twitter:description', content: post.summary },
        ...(published
          ? [
              { property: 'article:published_time', content: published },
            ]
          : []),
      ],
      links: [{ rel: 'canonical', href: canonical }],
      scripts: [{ type: 'application/ld+json', children: JSON.stringify(articleLd) }],
    }
  },
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
  const { post, siblings, egg } = Route.useLoaderData()
  const [copied, setCopied] = useState(false)
  const articleRef = useRef<HTMLDivElement>(null)
  useMermaidLazy(articleRef)
  // markdown 产物一次计算、两处复用（正文渲染 + SSR 大纲提取），
  // 使大纲按钮直接进入首屏 HTML（不依赖水合，弱网下也可见）
  const articleHtml = useMemo(() => renderMarkdown(post.content), [post.content])
  const initialHeadings = useMemo(() => extractHeadingsFromHtml(articleHtml), [articleHtml])

  // 彩蛋文章：整页接管，隐藏站点默认 chrome（侧边栏/目录/返回等）
  const isEggTakeover = egg.enabled
  useEffect(() => {
    if (!isEggTakeover) return
    document.body.classList.add('egg-takeover')
    return () => document.body.classList.remove('egg-takeover')
  }, [isEggTakeover])

  // 读取主站当前字体偏好并随 iframe 传入；监听 data-font 变化（用户可在
  // 彩蛋接管状态下打开用户面板切换字体，iframe 即时换字体重载）。
  // undefined = 尚未在客户端完成读取（SSR 安全），此时先不渲染 iframe，
  // 避免先无 font 加载一次、水合后再带参重载。
  const [eggFont, setEggFont] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    const read = () => document.documentElement.getAttribute('data-font')
    setEggFont(read())
    const mo = new MutationObserver(() => setEggFont(read()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-font'] })
    return () => mo.disconnect()
  }, [])

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

  if (isEggTakeover) {
    // 字体偏好未读取完成（SSR/首帧）时先占位，读完再一次性加载带 font 的彩蛋
    const eggSrc = eggFont === undefined
      ? null
      : `/egg/${encodeURIComponent(post.slug)}${eggFont ? `?font=${encodeURIComponent(eggFont)}` : ''}`
    return (
      <div className="egg-post-view">
        {eggSrc && (
          <iframe
            className="egg-post-frame"
            src={eggSrc}
            title={post.title}
            sandbox="allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads"
          />
        )}
      </div>
    )
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
            dangerouslySetInnerHTML={{ __html: articleHtml }}
          />
          <AttachmentPanel postSlug={post.slug} />
          <CommentSection postSlug={post.slug} />
          </article>
          <ArticleOutline containerRef={articleRef} slug={post.slug} initialHeadings={initialHeadings} />
        </div>
      </div>
    </div>
  )
}
