import type { ComponentType, LazyExoticComponent } from 'react'
import { Outlet, createRoute, createRouter, notFound, redirect } from '@tanstack/react-router'
import React from 'react'

// Import the generated route tree
import { routeTree } from './routeTree.gen'
import { useT } from './lib/i18n'
import { ensureMathForSource, loadMarkdownMath } from './lib/markdown-math'
import { getPublicOrigin } from './lib/server-env'
import { bookOfLesson, findLesson, loadLessonSource } from './lib/lessons'
import { dashboardFn } from './components/ui/card'
import { PeriodicTableSkeleton } from './components/periodic-table-skeleton'

// 直达 /periodic-table 时立刻开始下载表格 chunk（与框架水合并行），
// 只在该路径生效，其它页面不会为它多付一个请求。
if (typeof window !== 'undefined' && window.location.pathname === '/periodic-table') {
  void import('./components/periodic-table')
}

// 后台 UI 组件统一从 ./components/ui/card（懒加载，避免把 server fns/CRUD 拖入首屏）
const AdminLayout = React.lazy(() => import('./components/ui/card').then((m) => ({ default: m.AdminLayout })))
const AdminDashboard = React.lazy(() => import('./components/ui/card').then((m) => ({ default: m.AdminDashboard })))
const PostEditorPage = React.lazy(() => import('./components/ui/card').then((m) => ({ default: m.PostEditorPage })))
const CategoryManager = React.lazy(() => import('./components/ui/card').then((m) => ({ default: m.CategoryManager })))
const SettingsPanel = React.lazy(() => import('./components/ui/card').then((m) => ({ default: m.SettingsPanel })))
const UserManager = React.lazy(() => import('./components/ui/card').then((m) => ({ default: m.UserManager })))
const FeedbackManager = React.lazy(() => import('./components/ui/card').then((m) => ({ default: m.FeedbackManager })))
const SiteContentEditor = React.lazy(() => import('./components/ui/card').then((m) => ({ default: m.SiteContentEditor })))
const NetworkTools = React.lazy(() => import('./components/network-tools').then((m) => ({ default: m.NetworkTools })))
const TrafficMonitor = React.lazy(() => import('./components/traffic-monitor').then((m) => ({ default: m.TrafficMonitor })))
const RussianToolkit = React.lazy(() => import('./components/russian-toolkit').then((m) => ({ default: m.RussianToolkit })))
// 弱网下动态 chunk 偶发请求失败时，React.lazy 会永久停在 fallback（页面变成死的加载中）。
// 周期表是体积最大的独立 chunk，最容易中招，这里失败后重试两次再放弃。
const PeriodicTable = React.lazy(async () => {
  for (let attempt = 0; ; attempt++) {
    try {
      const m = await import('./components/periodic-table')
      return { default: m.PeriodicTable }
    } catch (err) {
      if (attempt >= 2) {
        // 部署刚结束时，浏览器可能仍拿着旧 HTML（引用已删除的旧 hash chunk），
        // 重试注定失败。整页刷新一次即可取到新外壳；60 秒内只自愈一次，避免离线刷新循环。
        if (typeof window !== 'undefined') {
          try {
            const key = 'sg-pt-chunk-reload'
            const last = Number(window.sessionStorage.getItem(key) || 0)
            if (Date.now() - last > 60_000) {
              window.sessionStorage.setItem(key, String(Date.now()))
              window.location.reload()
            }
          } catch { /* 隐私模式禁用 storage 时忽略 */ }
        }
        throw err
      }
      await new Promise((r) => setTimeout(r, 800))
    }
  }
})
const LessonsIndex = React.lazy(() => import('./components/lessons-index').then((m) => ({ default: m.LessonsIndex })))
const LessonPage = React.lazy(() => import('./components/lesson-page').then((m) => ({ default: m.LessonPage })))
const XdnmbBrowser = React.lazy(() => import('./components/xdnmb-browser').then((m) => ({ default: m.XdnmbBrowser })))
const Chan233Browser = React.lazy(() => import('./components/chan233-browser').then((m) => ({ default: m.Chan233Browser })))
const AdminGateWrap = React.lazy(() => import('./components/ui/card').then((m) => ({ default: m.AdminGateWrap })))

type AnyLazy = LazyExoticComponent<ComponentType<unknown>>

// Create a new router instance
//
// 注意这里必须是 async：首屏 HTML 里已经含公式（KaTeX 输出 .katex 节点）时，
// 先下载 KaTeX chunk 再建路由/水合。React 19 一旦发现 dangerouslySetInnerHTML
// 与 SSR 不一致会整树重渲染，因此不能指望「先渲染占位符、稍后升级」保住首屏，
// 必须在首帧就与 SSR 逐字一致。无公式页面不会触发这份下载。
export const getRouter = async () => {
  if (typeof document !== 'undefined' && document.querySelector('.katex')) {
    await loadMarkdownMath()
  }
  const root = routeTree

  /** 所有管理端子路由均经过 AdminGateWrap 门控 + Suspense 包裹 */
  const wrap = (Child: AnyLazy) =>
    function Wrapped(props: object) {
      // 利用 root loader SSR 已鉴权的管理员状态，跳过客户端 adminStatusFn 二次往返
      const { adminStatus } = root.useLoaderData()
      return (
        <React.Suspense fallback={<AdminLoading />}>
          <AdminGateWrap initialStatus={adminStatus}>
            <Child {...(props as Record<string, unknown>)} />
          </AdminGateWrap>
        </React.Suspense>
      )
    }

  // /admin 布局路由（带 index 子路由重定向到 posts）
  // TanStack Router 规则：path 路由只传 path，index 路由只传 id:'/'，二者不可同时出现
  const adminRoute = createRoute({
    path: '/admin',
    getParentRoute: () => root,
    component: wrap(AdminLayout as unknown as AnyLazy),
  })

  const adminIndexRoute = createRoute({
    id: '/',
    getParentRoute: () => adminRoute,
    beforeLoad: () => redirect({ to: '/admin/posts', replace: true }),
  })

  const adminPostsRoute = createRoute({
    path: 'posts',
    getParentRoute: () => adminRoute,
    // SSR 预取仪表盘数据（与 root loader 并行），客户端 hydration 直接取，省去一次 dashboardFn 往返
    // 非管理员时 requireAdmin 抛错，吞掉返回 null，由 AdminGateWrap 展示登录卡片
    loader: async () => {
      try { return await dashboardFn() } catch { return null }
    },
    component: wrap(AdminDashboard as unknown as AnyLazy),
  })
  const adminNewRoute = createRoute({
    path: 'posts/new',
    getParentRoute: () => adminRoute,
    // 新建译本入口：?translate=<源文章id>&lang=<目标语言>，由 PostEditorPage 按源文章预填
    validateSearch: (search: Record<string, unknown>): { translate?: string; lang?: string } => ({
      translate: typeof search.translate === 'string' ? search.translate : undefined,
      lang: typeof search.lang === 'string' ? search.lang : undefined,
    }),
    component: wrap(PostEditorPage as unknown as AnyLazy),
  })
  const adminEditRoute = createRoute({
    path: 'posts/$id',
    getParentRoute: () => adminRoute,
    component: wrap(PostEditorPage as unknown as AnyLazy),
  })
  const adminCategoriesRoute = createRoute({
    path: 'categories',
    getParentRoute: () => adminRoute,
    component: wrap(CategoryManager as unknown as AnyLazy),
  })
  const adminSettingsRoute = createRoute({
    path: 'settings',
    getParentRoute: () => adminRoute,
    component: wrap(SettingsPanel as unknown as AnyLazy),
  })
  const adminUsersRoute = createRoute({
    path: 'users',
    getParentRoute: () => adminRoute,
    component: wrap(UserManager as unknown as AnyLazy),
  })
  const adminFeedbackRoute = createRoute({
    path: 'feedback',
    getParentRoute: () => adminRoute,
    component: wrap(FeedbackManager as unknown as AnyLazy),
  })
  const adminContentRoute = createRoute({
    path: 'content',
    getParentRoute: () => adminRoute,
    component: wrap(SiteContentEditor as unknown as AnyLazy),
  })
  const adminNetworkRoute = createRoute({
    path: 'network',
    getParentRoute: () => adminRoute,
    component: wrap(NetworkTools as unknown as AnyLazy),
  })
  const adminTrafficRoute = createRoute({
    path: 'traffic',
    getParentRoute: () => adminRoute,
    component: wrap(TrafficMonitor as unknown as AnyLazy),
  })
  const adminXdnmbRoute = createRoute({
    path: 'xdnmb',
    getParentRoute: () => adminRoute,
    component: wrap(XdnmbBrowser as unknown as AnyLazy),
  })
  const adminChan233Route = createRoute({
    path: 'c233',
    getParentRoute: () => adminRoute,
    component: wrap(Chan233Browser as unknown as AnyLazy),
  })

  // /share：网络工具分享模式的公开页（免登录，凭 SG_SHARE cookie 访问 /api/net）
  // 不走 AdminGateWrap；页面挂载时经 /api/net?action=share_info 自检，invalid 则显示拒绝提示
  const shareRoute = createRoute({
    path: '/share',
    getParentRoute: () => root,
    component: function SharePage() {
      return (
        <React.Suspense fallback={<AdminLoading />}>
          <NetworkTools shared />
        </React.Suspense>
      )
    },
  })

  // /russian：俄语工具箱公开页（免登录，全访客可用）
  const russianRoute = createRoute({
    path: '/russian',
    getParentRoute: () => root,
    component: function RussianPage() {
      return (
        <React.Suspense fallback={<AdminLoading />}>
          <RussianToolkit />
        </React.Suspense>
      )
    },
  })

  // /periodic-table：元素周期表独立页面（免登录）
  const periodicTableRoute = createRoute({
    path: '/periodic-table',
    getParentRoute: () => root,
    // ?el=Fe / ?el=26 —— 元素深链：SSR 首帧直接选中，刷新与分享都保留
    validateSearch: (search: Record<string, unknown>): { el?: string } => ({
      el: typeof search.el === 'string' ? search.el : undefined,
    }),
    component: function PeriodicTablePage() {
      // 表格由 SSR 直出，首屏即可读；水合完成前组件自己会标注「正在初始化交互」，
      // 不会出现「看得到却点不动却毫无提示」的情况。只有 chunk 还没下载完时才显示骨架屏。
      return (
        <div style={{ maxWidth: 1480, margin: '0 auto', padding: '18px 14px 40px' }}>
          <React.Suspense fallback={<PeriodicTableSkeleton />}>
            <PeriodicTable />
          </React.Suspense>
        </div>
      )
    },
  })

  // /lessons：课程中心概览（左教材 / 右课程，公开页）。
  // ?book= 记录当前选中的教材，刷新与分享都保留同一册的选择。
  const lessonsRoute = createRoute({
    path: '/lessons',
    getParentRoute: () => root,
    validateSearch: (search: Record<string, unknown>): { book?: string } => ({
      book: typeof search.book === 'string' ? search.book : undefined,
    }),
    component: function LessonsIndexPage() {
      return (
        <React.Suspense fallback={<AdminLoading />}>
          <LessonsIndex />
        </React.Suspense>
      )
    },
  })

  // /lessons/$lessonId：单课阅读页。md 按需加载（每课独立 chunk），
  // SSR 时正文随 loader 数据序列化进首屏 HTML；未知 id 走 404。
  const lessonDetailRoute = createRoute({
    path: '/lessons/$lessonId',
    getParentRoute: () => root,
    beforeLoad: ({ params }) => {
      if (!findLesson(params.lessonId)) throw notFound()
    },
    loader: async ({ params }) => {
      const les = findLesson(params.lessonId)
      if (!les) throw notFound()
      const source = await loadLessonSource(les.file)
      // 客户端软导航时先按需加载 KaTeX（服务端为 no-op）
      await ensureMathForSource(source ?? '')
      return { les, source }
    },
    head: ({ loaderData }) => {
      if (!loaderData) return {}
      const { les } = loaderData
      const book = bookOfLesson(les)
      // 规范 URL：跨账号代理下不能取 request.url（workers.dev 不可达）
      const origin = getPublicOrigin()
      const canonical = origin ? `${origin}/lessons/${les.id}` : `/lessons/${les.id}`
      const title = `${les.title}${book && !book.reserved ? ` ${book.title}` : ''} · 课程精讲`
      return {
        meta: [
          { title },
          { name: 'description', content: les.hint },
          { property: 'og:title', content: title },
          { property: 'og:url', content: canonical },
        ],
        links: [{ rel: 'canonical', href: canonical }],
      }
    },
    component: function LessonDetailPage() {
      const data = lessonDetailRoute.useLoaderData()
      return (
        <React.Suspense fallback={<AdminLoading />}>
          <LessonPage les={data.les} source={data.source} />
        </React.Suspense>
      )
    },
  })

  // /rss.xml 已改为文件路由 src/routes/rss[.]xml.tsx（[.] 是字面量句点），
  // 其 server.handlers 会被编译器在客户端构建中正确剥离；
  // 不能在此用编程式 createRoute 注册服务端 handler，否则静态导入的 db 链
  // 不会被 tree-shaking，会把 SSR 运行时拖入客户端 bundle。
  const adminWithChildren = adminRoute.addChildren([
    adminIndexRoute,
    adminPostsRoute,
    adminNewRoute,
    adminEditRoute,
    adminCategoriesRoute,
    adminUsersRoute,
    adminFeedbackRoute,
    adminContentRoute,
    adminNetworkRoute,
    adminTrafficRoute,
    adminXdnmbRoute,
    adminChan233Route,
    adminSettingsRoute,
  ])

  // 注意：root.addChildren 是"替换+变异"语义，且 getRouter 每次请求都会执行。
  // 幂等策略：若 children 里已含编程式 /admin 路由则直接复用，否则合并文件路由 + 编程式路由。
  // ① 不合并文件路由会导致 / 与 /api/comments 404；② 重复合并会导致 Duplicate routes id:/admin。
  const existingChildren = ((root as unknown as { children?: unknown[] }).children ?? [])
  const hasPath = (p: string) =>
    existingChildren.some((r) => (r as { options?: { path?: string } })?.options?.path === p)
  // ① 不合并文件路由会导致 / 与 /api/comments 404；② 重复合并会导致 Duplicate routes id:/admin
  const mergedChildren = [
    ...existingChildren,
    ...(hasPath('/admin') ? [] : [adminWithChildren]),
    ...(hasPath('/share') ? [] : [shareRoute]),
    ...(hasPath('/russian') ? [] : [russianRoute]),
    ...(hasPath('/periodic-table') ? [] : [periodicTableRoute]),
    ...(hasPath('/lessons') ? [] : [lessonsRoute, lessonDetailRoute]),
  ]

  const router = createRouter({
    routeTree: root.addChildren(mergedChildren as never),
    scrollRestoration: true,
    // 预加载数据 30s 内复用，避免悬停预取后立即过期导致重复请求
    defaultPreloadStaleTime: 30_000,
    // 悬停链接 120ms 后开始预加载该路由的 loader 数据 + 懒加载组件
    defaultPreload: 'intent',
    defaultPreloadIntentDelay: 120,
    // 路由切换时的 pending 状态：150ms 内不展示，避免快切换闪烁；超时后显示骨架
    defaultPendingMs: 150,
    defaultPendingComponent: () => (
      <div style={{ padding: '80px 20px', textAlign: 'center', color: 'var(--muted, #7f8b9b)' }}>
        <span style={{ display: 'inline-block', animation: 'spin 0.9s linear infinite' }}>⟳</span>
      </div>
    ),
    // 防止 TanStack Router 严格类型断言报错
  } as unknown as Parameters<typeof createRouter>[0])

  return router
}

function AdminLoading() {
  const t = useT()
  return (
    <div
      style={{
        padding: '120px 20px',
        textAlign: 'center',
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        color: 'var(--muted, #7f8b9b)',
      }}
    >
      {t('admin.loading')}
    </div>
  )
}

// Outlet 重新导出（供 AdminLayout 等组件使用，TS 类型共享）
export { Outlet }
