import { createFileRoute } from '@tanstack/react-router'
import BlogPosts from '@/components/blog-posts'
import { publicServerFns } from '@/components/public-fns'
import { useT } from '@/lib/i18n'
import { usePublishedPosts } from '@/lib/use-published-posts'

export const Route = createFileRoute('/')({
  loader: async () => {
    const all = await publicServerFns.publishedPostsFn()
    return { posts: [...all].sort((a, b) => b.date.localeCompare(a.date)) }
  },
  component: App,
})
function App() {
  const t = useT()
  const { posts: ssrPosts } = Route.useLoaderData()
  // 冷启动 SSR 若降级（缺 DB 文章），客户端挂载后自动补拉，无需手动刷新
  const posts = usePublishedPosts(ssrPosts)
  return <BlogPosts title={t('shell.allposts')} posts={posts} />
}
