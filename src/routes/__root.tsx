import { HeadContent, Outlet, Scripts, createRootRoute, createRoute, useLocation } from '@tanstack/react-router'
import { allPosts } from 'content-collections'
import { SiteShell } from '@/components/site-shell'
import { publicServerFns } from '@/components/public-fns'
import 'katex/dist/katex.min.css'
import '../styles.css'
import { DEFAULT_SITE_DESCRIPTION, DEFAULT_SITE_TITLE } from '@/lib/utils'

const themeScript = `(function(){try{var t=localStorage.getItem('theme');document.documentElement.dataset.theme=t||(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark')}catch(e){document.documentElement.dataset.theme='dark'}})()`

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: DEFAULT_SITE_TITLE },
      { name: 'description', content: DEFAULT_SITE_DESCRIPTION },
    ],
    links: [
      { rel: 'alternate', type: 'application/rss+xml', title: `${DEFAULT_SITE_TITLE} · RSS`, href: '/rss.xml' },
    ],
  }),
  loader: async () => {
    const [settingsResult, categoriesResult] = await Promise.all([
      publicServerFns.settingsFn().catch(() => ({ public: { siteTitle: DEFAULT_SITE_TITLE, siteDescription: DEFAULT_SITE_DESCRIPTION, customCss: '' }, isAdmin: false as const })),
      publicServerFns.allCategoryNamesFn().catch(() => Array.from(new Set(allPosts.flatMap((p: { categories: string[] }) => p.categories))).sort()),
    ])
    return {
      settings: settingsResult.public,
      isAdmin: settingsResult.isAdmin,
      categories: categoriesResult,
    }
  },
  component: RootComponent,
  shellComponent: RootDocument,
})

function RootComponent() {
  const { settings, categories } = Route.useLoaderData()
  const loc = useLocation()
  const inAdmin = loc.pathname.startsWith('/admin')

  // 客户端同步标题到站点设置
  if (typeof document !== 'undefined') {
    if (document.title === DEFAULT_SITE_TITLE && settings.siteTitle !== DEFAULT_SITE_TITLE) {
      document.title = settings.siteTitle
    }
  }

  if (inAdmin) {
    return (
      <>
        {settings.customCss ? <style data-role="site-custom-css" dangerouslySetInnerHTML={{ __html: settings.customCss }} /> : null}
        <Outlet />
      </>
    )
  }

  return (
    <>
      {settings.customCss ? <style data-role="site-custom-css" dangerouslySetInnerHTML={{ __html: settings.customCss }} /> : null}
      <SiteShell categories={categories || []}>
        <Outlet />
      </SiteShell>
    </>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}

// 防止 createRoute / Route 未使用告警（实际用于顶层 loader）
void createRoute
