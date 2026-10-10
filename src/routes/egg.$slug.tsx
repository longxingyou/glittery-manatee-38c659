import { createFileRoute } from '@tanstack/react-router'
import { useT } from '@/lib/i18n'
import { FONT_STACKS, ALL_FONT_IDS, type FontId } from '@/lib/font-prefs'
import { renderMarkdown } from '@/lib/markdown'

// Markdown 模式彩蛋使用主站同一套样式（.markdown-body 排版、Callout、标签等）
// 与 KaTeX 公式样式；均为 /assets/ 同源 CSS，被彩蛋 CSP 的 style-src 'self' 放行。
// KaTeX CSS 引用的 woff2 字体经 Vite 打包为同源 /assets/ 资源，font-src 'self' 放行。
import siteStyles from '../styles.css?url'
import katexCss from 'katex/dist/katex.min.css?url'

// 各字体 CSS 的构建后 URL（Vite ?url 导入 → /assets/xxx-[hash].css）。
// 彩蛋文档通过 <link rel="stylesheet"> 加载它们；CSS 内部 @font-face 的字体
// 文件同为 /assets/ 同源资源，由彩蛋 CSP 的 style-src/font-src 'self' 放行。
// 与 font-prefs.ts 的动态 import 指向同一批 CSS，Vite 不会重复打包。
import zhSans400 from '@fontsource/noto-sans-sc/400.css?url'
import zhSans500 from '@fontsource/noto-sans-sc/500.css?url'
import zhSans700 from '@fontsource/noto-sans-sc/700.css?url'
import zhSerif400 from '@fontsource/noto-serif-sc/400.css?url'
import zhSerif600 from '@fontsource/noto-serif-sc/600.css?url'
import zhSerif700 from '@fontsource/noto-serif-sc/700.css?url'
import wenkaiR from 'lxgw-wenkai-webfont/lxgwwenkai-regular.css?url'
import wenkaiB from 'lxgw-wenkai-webfont/lxgwwenkai-bold.css?url'
import smiley from '../lib/fonts/smiley-sans.css?url'
import kuaile from '@fontsource/zcool-kuaile/400.css?url'
import mashan from '@fontsource/ma-shan-zheng/400.css?url'
import inter from '@fontsource-variable/inter/index.css?url'
import lora from '@fontsource-variable/lora/index.css?url'
import pf400 from '@fontsource/playfair-display/400.css?url'
import pf600 from '@fontsource/playfair-display/600.css?url'
import pf700 from '@fontsource/playfair-display/700.css?url'
import syne400 from '@fontsource/syne/400.css?url'
import syne700 from '@fontsource/syne/700.css?url'
import caveat400 from '@fontsource/caveat/400.css?url'
import caveat700 from '@fontsource/caveat/700.css?url'
import manrope from '@fontsource-variable/manrope/index.css?url'
import pts400 from '@fontsource/pt-serif/400.css?url'
import pts700 from '@fontsource/pt-serif/700.css?url'
import yeseva from '@fontsource/yeseva-one/400.css?url'
import marck from '@fontsource/marck-script/400.css?url'

const EGG_FONT_CSS_URLS: Record<FontId, string[]> = {
  'zh-sans': [zhSans400, zhSans500, zhSans700],
  'zh-serif': [zhSerif400, zhSerif600, zhSerif700],
  'zh-wenkai': [wenkaiR, wenkaiB],
  'zh-smiley': [smiley, zhSans400],
  'zh-kuaile': [kuaile, zhSans400],
  'zh-mashan': [mashan, zhSerif400],
  // 隶书使用系统自带 LiSu/STLiti，无需加载
  'zh-lisu': [],
  'en-inter': [inter],
  'en-lora': [lora],
  'en-playfair': [pf400, pf600, pf700],
  'en-syne': [syne400, syne700],
  'en-caveat': [caveat400, caveat700],
  'ru-inter': [inter],
  'ru-manrope': [manrope],
  'ru-ptserif': [pts400, pts700],
  'ru-yeseva': [yeseva],
  'ru-marck': [marck],
}

function asFontId(v: string | null): FontId | null {
  return v && (ALL_FONT_IDS as string[]).includes(v) ? (v as FontId) : null
}

function asTheme(v: string | null): 'light' | 'dark' | null {
  return v === 'light' || v === 'dark' ? v : null
}

/**
 * /egg/$slug — 文章彩蛋的整页静态 HTML 出口（非 React SSR，直接输出原始 HTML）。
 * - 公开访问：仅当彩蛋 enabled=true 且对应文章已发布（getPublicPostEgg 内门控）；
 * - 管理员预览：?preview=1 查看未启用版本（requireAdmin 把关），no-store 不缓存；
 * - 两种内容模式（后台保存时由 render_md 标记）：
 *   · HTML 模式（默认）：原文不做删改，交互脚本允许存在，由后台审查面板列出
 *     脚本/外链供人工核对；
 *   · Markdown 模式：库存 Markdown 源，输出前经 renderMarkdown 渲染（含 KaTeX），
 *     套主站 markdown-body 样式；原始 HTML 被转义，无脚本注入面；
 * - ?font=<FontId>：父页面把当前主站字体偏好传入，服务端向彩蛋文档注入
 *   对应字体 CSS + font-family，使彩蛋呈现与主站一致的字体（如得意黑）；
 *   中文字体不含西里尔字形时，font-family 栈自动回退系统字体正常显示俄文；
 * - ?theme=light|dark：父页面传入当前主题（Markdown 模式套主站配色）；
 * - 安全性：worker.ts 对本路径改用彩蛋专用 CSP（sandbox allow-scripts 等，
 *   脚本在不透明源中运行，拿不到站点 cookie/存储），并豁免 frame-ancestors 'none'。
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
  const font = asFontId(url.searchParams.get('font'))
  const theme = asTheme(url.searchParams.get('theme'))
  const mod = await import('../../db/index.js')

  let html: string | null = null
  let renderMd = false
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
      renderMd = egg.renderMd
    } catch (e) {
      return new Response(e instanceof Error ? e.message : '无权访问', {
        status: 403,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    }
  } else {
    const pub = await mod.getPublicPostEgg(slug)
    html = pub?.html ?? null
    renderMd = pub?.renderMd ?? false
  }

  if (!html) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  }

  // Markdown 模式：源文经 renderMarkdown 渲染（含 KaTeX）后套主站样式骨架；
  // HTML 模式：完整文档直接把字体注入其 <head>，片段交由 wrapEggHtml 骨架注入
  const finalHtml = renderMd
    ? wrapEggMarkdown(html, slug, font, theme)
    : (/^\s*<!DOCTYPE/i.test(html) || /^\s*<html[\s>]/i.test(html)
      ? injectFontIntoDocument(html, font)
      : wrapEggHtml(html, slug, font ? buildEggFontHead(font) : ''))

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
  return new Response(finalHtml, { status: 200, headers })
}

/** 构造注入到彩蛋文档 <head> 的字体内容：字体 CSS link + font-family 覆盖样式 */
function buildEggFontHead(font: FontId): string {
  const links = EGG_FONT_CSS_URLS[font]
    .map((u) => `<link rel="stylesheet" href="${u}">`)
    .join('')
  // 仅强制 html/body，文档内图标字体等不被 * 选择器破坏；
  // 中文字体（如得意黑）缺西里尔字形时，浏览器按栈回退到系统字体显示俄文
  const stack = FONT_STACKS[font]
  return `${links}<style id="sg-egg-font">html,body{font-family:${stack} !important;}</style>`
}

/** 完整 HTML 文档注入：有 </head> 插到其前；有 <html> 无 head 则补 head */
function injectFontIntoDocument(html: string, font: FontId | null): string {
  if (!font) return html
  const headContent = buildEggFontHead(font)
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<\/head>/i, `${headContent}</head>`)
  }
  return html.replace(/(<html[^>]*>)/i, `$1<head>${headContent}</head>`)
}

/** 非整文档片段补全骨架；完整 <!DOCTYPE>/<html> 文档原样输出 */
function wrapEggHtml(body: string, slug: string, headExtra: string): string {
  if (/^\s*<!DOCTYPE/i.test(body) || /^\s*<html[\s>]/i.test(body)) return body
  const safeSlug = slug.replace(/[<>&"]/g, '')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<base href="/">
<title>Egg · ${safeSlug}</title>
${headExtra}
</head>
<body>
${body}
</body>
</html>`
}

/**
 * Markdown 模式彩蛋骨架：库存 Markdown 源经主站 renderMarkdown 渲染
 *（KaTeX 已在该函数内服务端渲染为安全 HTML），外包 .markdown-body 容器并
 * 加载主站样式与 KaTeX 样式；?theme / ?font 控制配色与字体，与文章页观感一致。
 * renderMarkdown 会转义原始 HTML，故该模式不存在脚本/事件属性注入面。
 */
function wrapEggMarkdown(source: string, slug: string, font: FontId | null, theme: 'light' | 'dark' | null): string {
  const safeSlug = slug.replace(/[<>&"]/g, '')
  const themeAttr = theme ? ` data-theme="${theme}"` : ''
  const fontHead = font ? buildEggFontHead(font) : ''
  const bodyHtml = renderMarkdown(source)
  return `<!DOCTYPE html>
<html lang="zh-CN"${themeAttr}>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<base href="/">
<title>Egg · ${safeSlug}</title>
<link rel="stylesheet" href="${siteStyles}">
<link rel="stylesheet" href="${katexCss}">
${fontHead}
</head>
<body>
<div class="markdown-body egg-md-body">
${bodyHtml}
</div>
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
