import { createFileRoute } from '@tanstack/react-router'
import { allPosts } from 'content-collections'
import BlogPosts from '@/components/blog-posts'

export const Route = createFileRoute('/')({ component: App })
function App() { return <BlogPosts title="全部文章" posts={[...allPosts].sort((a, b) => b.date.localeCompare(a.date))} /> }
