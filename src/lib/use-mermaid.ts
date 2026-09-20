import { useEffect, type RefObject } from 'react'

// 模块级缓存：mermaid 只加载初始化一次
let mermaidPromise: Promise<typeof import('mermaid')['default']> | null = null

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid')
      .then((mod) => {
        const mermaid = (mod as { default?: typeof import('mermaid')['default'] }).default ?? mod as unknown as typeof import('mermaid')['default']
        const theme = (typeof document !== 'undefined' && document.documentElement.dataset.theme) || 'dark'
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: theme === 'light' ? 'default' : 'dark',
          fontFamily: 'inherit',
        })
        return mermaid
      })
      .catch((err) => {
        mermaidPromise = null
        throw err
      })
  }
  return mermaidPromise
}

/**
 * 懒加载渲染 .mermaid-source[data-mermaid-graph="1"] 元素中的 Mermaid 图表。
 * 使用 IntersectionObserver 在元素接近视口时才加载 mermaid 库并渲染。
 */
export function useMermaidLazy(
  containerRef: RefObject<HTMLElement | null>,
  deps: unknown[] = [],
) {
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('.mermaid-source[data-mermaid-graph="1"]'))
    if (nodes.length === 0) return

    let cancelled = false
    const io = new IntersectionObserver((entries) => {
      const visible = entries.filter(e => e.isIntersecting).map(e => e.target as HTMLElement)
      if (visible.length === 0) return
      loadMermaid().then((mermaid) => {
        if (cancelled) return
        return mermaid.run({ nodes: visible }).catch((err: unknown) => {
          console.error('[mermaid] render failed', err)
          visible.forEach(n => n.classList.add('mermaid-error'))
        })
      }).then(() => {
        if (cancelled) return
        visible.forEach(n => {
          n.removeAttribute('data-mermaid-graph')
          n.setAttribute('data-mermaid-rendered', '1')
        })
      })
    }, { rootMargin: '300px' })

    nodes.forEach(n => io.observe(n))
    return () => { cancelled = true; io.disconnect() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, ...deps])
}
