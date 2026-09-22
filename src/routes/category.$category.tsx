import { createFileRoute } from '@tanstack/react-router'
import { useMemo } from 'react'
import BlogPosts from '@/components/blog-posts'
import { publicServerFns } from '@/components/public-fns'
import { useCatName } from '@/lib/i18n'
import { usePublishedPosts } from '@/lib/use-published-posts'

export const Route = createFileRoute('/category/$category')({
  component: RouteComponent,
  loader: async ({ params }) => {
    const all = await publicServerFns.publishedPostsFn()
    const posts = all.filter((post) => post.categories.includes(params.category))
    return { category: params.category, posts }
  },
})
function RouteComponent() {
  const { category, posts: ssrPosts } = Route.useLoaderData()
  // hook 补拉返回的是完整已发布列表（冷启动降级时补入 DB 文章），再按当前分类过滤
  const all = usePublishedPosts(ssrPosts)
  const posts = useMemo(() => all.filter((p) => p.categories.includes(category)), [all, category])
  // 标题按当前语言展示；URL / loader 过滤仍使用权威中文名
  const catName = useCatName()
  return <BlogPosts title={catName(category)} posts={posts} />
}
