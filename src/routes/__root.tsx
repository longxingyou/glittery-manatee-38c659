import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import { allPosts } from 'content-collections'
import { SiteShell } from '@/components/site-shell'
import 'katex/dist/katex.min.css'
import '../styles.css'

const themeScript = `(function(){try{var t=localStorage.getItem('theme');document.documentElement.dataset.theme=t||(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark')}catch(e){document.documentElement.dataset.theme='dark'}})()`

export const Route = createRootRoute({
  head: () => ({ meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { title: 'Syntax Garden · 可运行的文字' }, { name: 'description', content: 'VS Code 风格的独立技术博客，记录代码、设计与理性浪漫。' }] }),
  component: RootComponent,
  shellComponent: RootDocument,
})

function RootComponent() {
  const categories = Array.from(new Set(allPosts.flatMap((post) => post.categories))).sort()
  return <SiteShell categories={categories}><Outlet /></SiteShell>
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return <html lang="zh-CN" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: themeScript }} /><HeadContent /></head><body>{children}<Scripts /></body></html>
}
