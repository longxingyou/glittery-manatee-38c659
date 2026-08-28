import { createFileRoute } from '@tanstack/react-router'
import { allPosts } from 'content-collections'
import BlogPosts from '@/components/blog-posts'

export const Route = createFileRoute('/category/$category')({
  component: RouteComponent,
  loader: async ({ params }) => ({ category: params.category, posts: allPosts.filter((post) => post.categories.includes(params.category)) }),
})
function RouteComponent() { const { category, posts } = Route.useLoaderData(); return <BlogPosts title={category} posts={posts} /> }
