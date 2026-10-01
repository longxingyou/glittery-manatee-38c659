import { useEffect, useState } from 'react'
import { publicServerFns } from '@/components/public-fns'
import { isCurrentUserAdmin } from '@/lib/auth-client'
import type { PostData } from '@/lib/utils'

/**
 * 冷启动 SSR 降级（Neon 唤醒超时、DB 文章缺失）后的客户端补拉。
 *
 * SSR 请求本身已经触发 Neon 唤醒；客户端 hydration 后重拉时 DB 通常已就绪，
 * 能快速拿到 DB 文章并平滑补入列表，用户无需手动刷新。
 *
 * 弱网（Watt Toolkit 代理、跨境）下 Server Function 可能超时，采用指数退避
 * 多次重试，确保 DB 文章最终能补上。
 *
 * 暖态 SSR 数据完整时，重拉结果 slug 集合相同 → 不更新，无闪烁。
 *
 * 预渲染快照页（构建时点）与降级页都可能既缺新文章、也含已删除的文章，
 * 因此 slug 集合在任一方向上有差异（新增或减少）都用最新列表整体替换。
 */
export function usePublishedPosts(ssrPosts: PostData[]): PostData[] {
  const [posts, setPosts] = useState<PostData[]>(ssrPosts)

  useEffect(() => {
    let alive = true
    const ssrSlugs = new Set(ssrPosts.map((p) => p.slug))

    const refresh = async (fresh: boolean): Promise<boolean> => {
      try {
        // 客户端补拉用 20s 超时：页面已渲染，用户愿意等待完整 DB 文章；
        // 弱网（Watt Toolkit 代理、跨境）下给 Neon 充足时间响应。
        // 管理员（站方发文后立即查看）带 fresh 绕过跨 colo 内存/KV 缓存，
        // 保证新文章/删除即时可见；普通访客继续走缓存省钱。
        const freshPosts = await publicServerFns.publishedPostsFn({ data: { timeoutMs: 20_000, fresh } })
        const freshSlugs = new Set(freshPosts.map((p) => p.slug))
        const changed =
          freshPosts.some((p) => !ssrSlugs.has(p.slug)) ||
          ssrPosts.some((p) => !freshSlugs.has(p.slug))
        if (alive && changed) {
          setPosts([...freshPosts].sort((a, b) => b.date.localeCompare(a.date)))
          return true
        }
      } catch { /* 忽略，走重试 */ }
      return false
    }

    // 管理员立即强制新鲜；非管理员走常规缓存补拉。
    // 立即试一次；失败按 2s / 5s / 10s 退避重试，覆盖 Neon 冷启动 + 弱网抖动
    const delays = [0, 2000, 5000, 10000]
    void (async () => {
      const fresh = await isCurrentUserAdmin().catch(() => false)
      for (const delay of delays) {
        if (delay > 0) await new Promise((r) => setTimeout(r, delay))
        if (!alive) return
        if (await refresh(fresh)) return
      }
    })()

    return () => { alive = false }
    // 仅挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return posts
}
