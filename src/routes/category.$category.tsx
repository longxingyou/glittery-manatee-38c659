import { createFileRoute } from '@tanstack/react-router'
import BlogPosts from '@/components/blog-posts'
import { publicServerFns } from '@/components/public-fns'

export const Route = createFileRoute('/category/$category')({
  component: RouteComponent,
  loader: async ({ params }) => {
    const all = await publicServerFns.publishedPostsFn()
    const posts = all.filter((post) => post.categories.includes(params.category))
    if (posts.length === 0) {
      // 兼容：如果没有任何一篇文章带此分类也不 404，给个空列表即可
    }
    return { category: params.category, posts }
  },
})
function RouteComponent() {
  const { category, posts } = Route.useLoaderData()
  return <BlogPosts title={category} posts={posts} />
}
