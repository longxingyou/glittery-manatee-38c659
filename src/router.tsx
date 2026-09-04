import type { ComponentType, LazyExoticComponent } from 'react'
import { Outlet, createRoute, createRouter, redirect } from '@tanstack/react-router'
import React from 'react'

// Import the generated route tree
import { routeTree } from './routeTree.gen'
import { rssHandler } from './routes/api.comments'

// 后台 UI 组件统一从 ./components/ui/card（懒加载，避免把 server fns/CRUD 拖入首屏）
const AdminLayout = React.lazy(() => import('./components/ui/card').then((m) => ({ default: m.AdminLayout })))
const AdminDashboard = React.lazy(() => import('./components/ui/card').then((m) => ({ default: m.AdminDashboard })))
const PostEditorPage = React.lazy(() => import('./components/ui/card').then((m) => ({ default: m.PostEditorPage })))
const CategoryManager = React.lazy(() => import('./components/ui/card').then((m) => ({ default: m.CategoryManager })))
const SettingsPanel = React.lazy(() => import('./components/ui/card').then((m) => ({ default: m.SettingsPanel })))
const AdminGateWrap = React.lazy(() => import('./components/ui/card').then((m) => ({ default: m.AdminGateWrap })))

type AnyLazy = LazyExoticComponent<ComponentType<unknown>>

// Create a new router instance
export const getRouter = () => {
  const root = routeTree

  /** 所有管理端子路由均经过 AdminGateWrap 门控 + Suspense 包裹 */
  const wrap = (Child: AnyLazy) =>
    function Wrapped(props: object) {
      return (
        <React.Suspense fallback={<AdminLoading />}>
          <AdminGateWrap>
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
    component: wrap(AdminDashboard as unknown as AnyLazy),
  })
  const adminNewRoute = createRoute({
    path: 'posts/new',
    getParentRoute: () => adminRoute,
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

  // RSS：服务端 GET 直接返回 XML；客户端访问返回可读说明页
  const rssRoute = createRoute({
    path: 'rss.xml',
    getParentRoute: () => root,
    server: {
      handlers: {
        GET: async ({ request }) => rssHandler(request),
      },
    },
    component: () => (
      <div
        style={{
          padding: '80px 40px',
          maxWidth: 720,
          margin: '0 auto',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          color: 'var(--text, #111)',
        }}
      >
        <h1 style={{ marginBottom: 10 }}>RSS 订阅源</h1>
        <p>请使用支持 RSS 2.0 的阅读器订阅以下地址：</p>
        <p>
          <a href="/rss.xml" style={{ color: 'var(--accent, #087f6d)' }}>/rss.xml</a>
        </p>
      </div>
    ),
  })

  const adminWithChildren = adminRoute.addChildren([
    adminIndexRoute,
    adminPostsRoute,
    adminNewRoute,
    adminEditRoute,
    adminCategoriesRoute,
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
    : [...existingChildren, adminWithChildren, rssRoute]

  const router = createRouter({
    routeTree: root.addChildren(mergedChildren as never),
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    // 防止 TanStack Router 严格类型断言报错
  } as unknown as Parameters<typeof createRouter>[0])

  return router
}

function AdminLoading() {
  return (
    <div
      style={{
        padding: '120px 20px',
        textAlign: 'center',
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        color: 'var(--muted, #7f8b9b)',
      }}
    >
      正在加载管理后台…
    </div>
  )
}

// Outlet 重新导出（供 AdminLayout 等组件使用，TS 类型共享）
export { Outlet }
