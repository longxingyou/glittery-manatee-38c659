import { useEffect, useState } from 'react'

import { loadMarkdownMath, markdownMathReady } from './markdown-math'

/**
 * 客户端按需等待 KaTeX，就绪后触发一次重渲染。
 *
 * 用于「水合之后才出现公式」的组件（评论、用户面板、后台预览）：
 * 首帧可能输出 TeX 占位符，KaTeX chunk 到达后本 hook 让组件重新渲染，
 * renderMarkdown 随即输出真实公式 HTML。
 * 服务端渲染时注册器已就绪，返回 true，不产生额外开销。
 *
 * `enabled` 用于把加载推迟到真正需要时（例如用户面板关闭时不必下载 KaTeX）。
 */
export function useMarkdownMath(enabled = true): boolean {
  const [ready, setReady] = useState(markdownMathReady)

  useEffect(() => {
    if (ready || !enabled) return
    let alive = true
    void loadMarkdownMath()
      .then(() => {
        if (alive) setReady(true)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [ready, enabled])

  return ready
}
