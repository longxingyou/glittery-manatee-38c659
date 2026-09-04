import { createFileRoute } from '@tanstack/react-router'
import BlogPosts from '@/components/blog-posts'
import { publicServerFns } from '@/components/public-fns'

export const Route = createFileRoute('/')({
  loader: async () => {
    const all = await publicServerFns.publishedPostsFn()
    return { posts: [...all].sort((a, b) => b.date.localeCompare(a.date)) }
  },
  component: App,
})
function App() {
  const { posts } = Route.useLoaderData()
  return <BlogPosts title="全部文章" posts={posts} />
}
