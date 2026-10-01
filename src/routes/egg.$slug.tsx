import { createFileRoute } from '@tanstack/react-router'
import { useT } from '@/lib/i18n'

/**
 * /egg/$slug — 文章彩蛋的整页静态 HTML 出口（非 React SSR，直接输出原始 HTML）。
 * - 公开访问：仅当彩蛋 enabled=true 且对应文章已发布（getPublicPostEgg 内门控）；
 * - 管理员预览：?preview=1 查看未启用版本（requireAdmin 把关），no-store 不缓存；
 * - 安全性：worker.ts 对本路径改用彩蛋专用 CSP（sandbox allow-scripts 等，
 *   脚本在不透明源中运行，拿不到站点 cookie/存储），并豁免 frame-ancestors 'none'；
 * - HTML 原文不做删改：交互脚本允许存在，由后台审查面板列出脚本/外链供人工核对。
 */

export const Route = createFileRoute('/egg/$slug')({
  server: {
    handlers: {
      GET: ({ request, params }) => handleEggGet(request, params.slug),
    },
  },
  component: EggInfoPage,
})

async function handleEggGet(request: Request, slug: string): Promise<Response> {
  const url = new URL(request.url)
  const isPreview = url.searchParams.get('preview') === '1'
  const mod = await import('../../db/index.js')

  let html: string | null = null
  if (isPreview) {
    // 管理员预览：鉴权后输出最新保存版本（无论是否启用）
    try {
      await mod.requireAdmin()
      const egg = await mod.getPostEggAdmin(slug)
      if (!egg) {
        return new Response('该文章尚未设置彩蛋。', {
          status: 404,
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
        })
      }
      html = egg.html
    } catch (e) {
      return new Response(e instanceof Error ? e.message : '无权访问', {
        status: 403,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    }
  } else {
    html = await mod.getPublicPostEgg(slug)
  }

  if (!html) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  }

  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'X-Frame-Options': 'SAMEORIGIN',
    'Cache-Control': isPreview
      ? 'private, no-store, must-revalidate'
      : 'public, max-age=300, s-maxage=600, stale-while-revalidate=3600',
  })
  if (isPreview) {
    headers.set('X-Preview', '1')
    headers.set('X-Robots-Tag', 'noindex, nofollow')
  }
  return new Response(wrapEggHtml(html, slug), { status: 200, headers })
}

/** 非整文档片段补全骨架；完整 <!DOCTYPE>/<html> 文档原样输出 */
function wrapEggHtml(body: string, slug: string): string {
  if (/^\s*<!DOCTYPE/i.test(body) || /^\s*<html[\s>]/i.test(body)) return body
  const safeSlug = slug.replace(/[<>&"]/g, '')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<base href="/">
<title>Egg · ${safeSlug}</title>
</head>
<body>
${body}
</body>
</html>`
}

// 浏览器地址栏直接打开且 GET handler 未命中（理论上不发生）时的兜底说明页
function EggInfoPage() {
  const t = useT()
  const { slug } = Route.useParams()
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
      <h1 style={{ marginBottom: 10 }}>{t('egg.info.title')}</h1>
      <p>{t('egg.info.desc')}</p>
      <p style={{ color: 'var(--text-dim, #666)', fontSize: 14 }}>
        <code>/egg/{slug}</code>
      </p>
    </div>
  )
}
