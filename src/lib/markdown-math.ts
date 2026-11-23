/**
 * 客户端按需加载 KaTeX（≈255KB + mhchem ≈33KB）。
 *
 * 为什么不放在 markdown.ts 里静态 import：markdown.ts 被大量页面/组件引用，
 * 静态依赖会把 KaTeX 拖进主入口 chunk，让无公式页面也白付这份体积。
 * 这里只用动态 import，Vite 会把它拆成独立 chunk，只有确实需要公式时才下载。
 */
import { hasMathRenderer, setMathRenderer } from './markdown'

type Katex = typeof import('katex').default

let katex: Katex | null = null
let loading: Promise<void> | null = null

/** 内容里是否可能出现公式（宁可多加载一次，也不漏渲染） */
function sourceHasMath(source: string): boolean {
  return /\$\$|\\\[|\\\(|\\ce\{|\\pu\{|(?<![\\$])\$(?![\s$])/.test(source)
}

/** KaTeX 是否已就绪（服务端恒为 true；客户端动态加载完成后为 true） */
export function markdownMathReady(): boolean {
  return hasMathRenderer()
}

/** 启动 KaTeX chunk 下载并注册渲染器；重复调用共享同一个 Promise */
export function loadMarkdownMath(): Promise<void> {
  if (hasMathRenderer()) return Promise.resolve()
  if (!loading) {
    loading = (async () => {
      const [mod] = await Promise.all([
        import('katex'),
        // mhchem 必须与主 katex 是同一实例：走 package exports 的 import 条件解析到
        // dist/contrib/mhchem.mjs（其内部 import '../katex.mjs'）。若直接引
        // dist/contrib/mhchem.js（UMD），Vite 打包后会 require 另一个 katex.js 实例，
        // \ce 宏注册到未被使用的实例上 → 渲染时 \ce 变成未知命令（红色文本）。
        import('katex/contrib/mhchem'),
      ])
      katex = mod.default
      setMathRenderer((tex, displayMode) =>
        katex!.renderToString(tex, { displayMode, throwOnError: false, strict: false }))
    })().catch((error) => {
      // 失败不缓存，下次仍有公式时重试
      loading = null
      throw error
    })
  }
  return loading
}

/**
 * 页面内容含公式时再加载 KaTeX。
 * 只在浏览器生效：服务端在 Worker 启动时已同步注册（markdown-math.server.ts），
 * 因此 SSR 仍输出完整公式 HTML，不额外等待。
 */
export async function ensureMathForSource(source: string): Promise<void> {
  if (typeof document === 'undefined') return
  if (!sourceHasMath(source)) return
  await loadMarkdownMath()
}
