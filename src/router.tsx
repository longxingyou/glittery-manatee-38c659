import type { ComponentType, LazyExoticComponent } from 'react'
import { Outlet, createRoute, createRouter, redirect } from '@tanstack/react-router'
import React from 'react'

// Import the generated route tree
import { routeTree } from './routeTree.gen'
import { useT } from './lib/i18n'
import { dashboardFn } from './components/ui/card'

// 后台 UI 组件统一从 ./components/ui/card（懒加载，避免把 server fns/CRUD 拖入首屏）
const AdminLayout = React.lazy(() => import('./components/ui/card').then((m) => ({ default: m.AdminLayout })))
const AdminDashboard = React.lazy(() => import('./components/ui/card').then((m) => ({ default: m.AdminDashboard })))
const PostEditorPage = React.lazy(() => import('./components/ui/card').then((m) => ({ default: m.PostEditorPage })))
const CategoryManager = React.lazy(() => import('./components/ui/card').then((m) => ({ default: m.CategoryManager })))
const SettingsPanel = React.lazy(() => import('./components/ui/card').then((m) => ({ default: m.SettingsPanel })))
const UserManager = React.lazy(() => import('./components/ui/card').then((m) => ({ default: m.UserManager })))
const FeedbackManager = React.lazy(() => import('./components/ui/card').then((m) => ({ default: m.FeedbackManager })))
const SiteContentEditor = React.lazy(() => import('./components/ui/card').then((m) => ({ default: m.SiteContentEditor })))
const AdminGateWrap = React.lazy(() => import('./components/ui/card').then((m) => ({ default: m.AdminGateWrap })))

type AnyLazy = LazyExoticComponent<ComponentType<unknown>>

// Create a new router instance
export const getRouter = () => {
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
    adminSettingsRoute,
  ])

  // 注意：root.addChildren 是"替换+变异"语义，且 getRouter 每次请求都会执行。
  // 幂等策略：若 children 里已含编程式 /admin 路由则直接复用，否则合并文件路由 + 编程式路由。
  // ① 不合并文件路由会导致 / 与 /api/comments 404；② 重复合并会导致 Duplicate routes id:/admin。
  const existingChildren = ((root as unknown as { children?: unknown[] }).children ?? [])
  const alreadyMerged = existingChildren.some(
    (r) => (r as { options?: { path?: string } })?.options?.path === '/admin',
  )
  const mergedChildren = alreadyMerged
    ? existingChildren
    : [...existingChildren, adminWithChildren]

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
