import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ArrowLeft, FileDown, FileText, Globe, Printer } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { publicServerFns } from '@/components/public-fns'
import { getPublicOrigin } from '@/lib/server-env'
import { useT, useCatName } from '@/lib/i18n'
import { renderMarkdown, extractHeadingsFromHtml } from '@/lib/markdown'
import { useMermaidLazy } from '@/lib/use-mermaid'
import { buildExportBody, downloadDocx, downloadHtml, downloadMarkdown, EXPORT_CSS } from '@/lib/export-doc'

export const Route = createFileRoute('/export/$slug')({
  loader: async ({ params }) => {
    const slug = params.slug
    const post = await publicServerFns.getPublishedPostFn({ data: { slug } }).catch(() => null)
    if (!post || post.status !== 'published' || post.downloadable !== true) throw notFound()
    const egg = await publicServerFns.postEggMetaFn({ data: { slug } }).catch(() => ({ enabled: false }))
    if (egg.enabled) {
      // 彩蛋页不进此路由：在文章页由浮动按钮接管
      throw notFound()
    }
    return { post }
  },
  component: ExportPage,
  head: ({ loaderData }) => {
    if (!loaderData) return {}
    const { post } = loaderData
    return {
      meta: [
        { title: `导出 · ${post.title}` },
        { name: 'robots', content: 'noindex, nofollow' },
      ],
    }
  },
})

function ExportPage() {
  const t = useT()
  const catName = useCatName()
  const { post } = Route.useLoaderData()
  const articleRef = useRef<HTMLDivElement>(null)
  useMermaidLazy(articleRef)

  const articleHtml = useMemo(() => {
    const origin = getPublicOrigin()
    return buildExportBody(renderMarkdown(post.content), origin)
  }, [post.content])
  const headings = useMemo(() => extractHeadingsFromHtml(articleHtml), [articleHtml])
  const url = `${getPublicOrigin()}/posts/${post.slug}`

  useEffect(() => {
    document.body.classList.add('export-mode')
    return () => document.body.classList.remove('export-mode')
  }, [])

  const doPrint = () => window.print()

  return (
    <>
      <style>{EXPORT_CSS}</style>
      <div className="export-toolbar no-print">
        <div className="export-toolbar-inner">
          <button type="button" onClick={doPrint}>
            <Printer size={14} />{t('export.pdf')}
          </button>
          <button type="button" onClick={() => {
            try {
              console.log('docx download triggered', post.slug)
              downloadDocx(post, articleRef.current)
            } catch (e) {
              console.error('docx download failed', e)
            }
          }}>
            <FileDown size={14} />{t('export.docx')}
          </button>
          <button type="button" onClick={() => downloadMarkdown(post)}>
            <FileText size={14} />{t('export.markdown')}
          </button>
          <button type="button" onClick={() => downloadHtml(post, articleRef.current)}>
            <Globe size={14} />{t('export.html')}
          </button>
          <Link to="/posts/$slug" params={{ slug: post.slug }} className="export-back">
            <ArrowLeft size={14} />{t('export.back')}
          </Link>
        </div>
      </div>
      <div className="export-body">
        <header className="export-header">
          <h1>{post.title}</h1>
          <p>{post.summary}</p>
          <div className="meta">
            <span>{post.date}</span>
            <span>{t('post.reading', { n: post.readingTime })}</span>
            <span>{post.categories.map((c: string) => catName(c)).join(' · ')}</span>
          </div>
        </header>
        {headings.length >= 2 && (
          <nav className="export-toc" aria-label={t('export.toc')}>
            <h3>{t('export.toc')}</h3>
            <ol>
              {headings.map(h => (
                <li key={h.id} className={`lv${h.level}`}>
                  <a href={`#${h.id}`}>{h.text || '…'}</a>
                </li>
              ))}
            </ol>
          </nav>
        )}
        <article
          ref={articleRef}
          className="markdown-body"
          dangerouslySetInnerHTML={{ __html: articleHtml }}
        />
        <footer className="export-footer">
          {t('export.source')}：<a href={url}>{url}</a>
        </footer>
      </div>
    </>
  )
}
