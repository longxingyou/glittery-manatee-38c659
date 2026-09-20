import { createFileRoute } from '@tanstack/react-router'
import BlogPosts from '@/components/blog-posts'
import { publicServerFns } from '@/components/public-fns'
import { useT } from '@/lib/i18n'

export const Route = createFileRoute('/')({
  loader: async () => {
    const all = await publicServerFns.publishedPostsFn()
    return { posts: [...all].sort((a, b) => b.date.localeCompare(a.date)) }
  },
  component: App,
})
function App() {
  const t = useT()
  const { posts } = Route.useLoaderData()
  return <BlogPosts title={t('shell.allposts')} posts={posts} />
}
