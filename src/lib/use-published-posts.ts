import { useEffect, useState } from 'react'
import { publicServerFns } from '@/components/public-fns'
import type { PostData } from '@/lib/utils'

/**
 * 冷启动 SSR 降级（Neon 唤醒超时、DB 文章缺失）后的客户端补拉。
 *
 * SSR 请求本身已经触发 Neon 唤醒；客户端 hydration 后重拉时 DB 通常已就绪，
 * 能快速拿到 DB 文章并平滑补入列表，用户无需手动刷新。
 * 立即试一次；若仍无新文章（DB 尚未完全唤醒），3s 后再试一次兜底。
 *
 * 暖态 SSR 数据完整时，重拉结果 slug 集合相同 → 不更新，无闪烁。
 */
export function usePublishedPosts(ssrPosts: PostData[]): PostData[] {
  const [posts, setPosts] = useState<PostData[]>(ssrPosts)

  useEffect(() => {
    let alive = true
    const ssrSlugs = new Set(ssrPosts.map((p) => p.slug))

    const refresh = async (): Promise<boolean> => {
      try {
        const fresh = await publicServerFns.publishedPostsFn()
        if (alive && fresh.some((p) => !ssrSlugs.has(p.slug))) {
          setPosts([...fresh].sort((a, b) => b.date.localeCompare(a.date)))
          return true
        }
      } catch { /* 忽略，走重试 */ }
      return false
    }

    void (async () => {
      if (await refresh()) return
      await new Promise((r) => setTimeout(r, 3000))
      if (alive) await refresh()
    })()

    return () => { alive = false }
    // 仅挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return posts
}
