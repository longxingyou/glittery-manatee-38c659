/**
 * 数学讲义渲染校验：用**站点真实渲染管线**（renderMarkdown）把讲义渲成 HTML，
 * 检查那些"只跑 KaTeX 检查器发现不了"的问题。
 *
 * ## 为什么需要它
 * `math_katex_check.mjs` 只验证公式本身合法，它不知道：
 *   * 公式会不会被 marked 的列表/表格规则吃掉，变成字面量 `$$…$$` 显示出来
 *   * KaTeX 渲染失败时站点插入的 `katex-error` 红字
 *   * 标题是否被 `renderMarkdown(src, 1)` 整体下移一级后仍能被大纲提取
 *   * 图片引用是否被 `resolveLessonImage` 解析到（讲义配图走 Vite glob）
 *
 * ## 用法
 *   pnpm tsx scripts/verify-math-lessons.ts
 *   pnpm tsx scripts/verify-math-lessons.ts <dir-or-file> [...]
 *
 * 退出码：0 全部通过；1 有失败。
 */
import fs from 'node:fs'
import path from 'node:path'
import { renderMarkdown, extractHeadingsFromHtml } from '../src/lib/markdown'

const DEFAULT_DIR = 'content/misc-lessons/linear-algebra'
const IMAGE_ROOT = 'src/assets/lessons'

/**
 * 复刻 lessons.ts 的 `resolveLessonImage` 解析顺序：
 *   先按完整相对路径（ch1/fig1.png），再退回全局同名文件。
 * 这里之所以自己实现，是因为 **`import.meta.glob` 是 Vite 专属**，
 * 在 tsx/node 下 import `lessons.ts` 会直接 `glob is not a function` 崩掉。
 */
function resolveImageOnDisk(href: string): string | undefined {
  const clean = href.trim().replace(/^\.\//, '').split(/[?#]/)[0]
  if (!clean || /^(?:[a-z]+:|\/)/i.test(clean)) return undefined
  const direct = path.join(IMAGE_ROOT, clean)
  if (fs.existsSync(direct)) return direct
  const base = path.basename(clean)
  const stack = [IMAGE_ROOT]
  while (stack.length) {
    const dir = stack.pop()!
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.name === base) return p
    }
  }
  return undefined
}

interface Problem {
  file: string
  kind: string
  detail: string
}

const problems: Problem[] = []

function collect(target: string): string[] {
  const st = fs.statSync(target)
  if (st.isFile()) return [target]
  return fs
    .readdirSync(target)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => path.join(target, f))
}

function checkFile(file: string): { formulas: number; headings: number; images: number } {
  const src = fs.readFileSync(file, 'utf8')

  // ★ 必须自己传 resolveImage：站点里这个回调由 Vite 的 import.meta.glob 提供，
  //   而 **node/tsx 下没有 import.meta.glob**。不传的话 markdown.ts 会走
  //   `options.resolveImage?.(href) ?? ''` 分支 → 每张图都渲染成占位符
  //   `<span class="markdown-image-alt">[图片：…]</span>`，于是"渲染后 img 数"
  //   恒为 0，看起来像站点 bug（实际是校验脚本自己的缺口，踩过）。
  //   这里用一个只查文件系统、返回假 URL 的回调，专门验证 **markdown 管道能否产出 <img>**。
  const resolveImg = (href: string): string | undefined => {
    const hit = resolveImageOnDisk(href)
    return hit ? `/__verify__/${path.basename(hit)}` : undefined
  }

  // 与 lesson-page.tsx 一致：课程精讲用 renderMarkdown(src, 1)，标题整体下移一级
  const html = renderMarkdown(src, 1, { resolveImage: resolveImg })

  // 1. KaTeX 渲染失败（站点会把错误塞进 .katex-error）
  const katexErrors = html.match(/katex-error/g)?.length ?? 0
  if (katexErrors > 0) {
    problems.push({ file, kind: 'katex-error', detail: `${katexErrors} 处` })
  }

  // 2. 公式没被识别，泄漏成字面量（正文里出现 $$ 或 \[ 原样）
  //
  // ★ 必须先剥掉 KaTeX 自己产出的 <annotation> 标签再检测。
  //   KaTeX 会把公式**源码**原样塞进 `<annotation encoding="application/x-tex">`，
  //   于是像 `\\[2pt]`（pmatrix 的行距参数）这种内容会被 `/\\\[/` 误命中，
  //   报成「公式泄漏」——**这是误报**，实际渲染完全正常。
  //   （27 讲就因此被误报过一次，查了半天才发现是 annotation 里的字符串。）
  const htmlNoAnnotation = html.replace(
    /<annotation[^>]*>[\s\S]*?<\/annotation>/g, '',
  )
  const leaked =
    (htmlNoAnnotation.match(/\$\$/g)?.length ?? 0) +
    (htmlNoAnnotation.match(/\\\[/g)?.length ?? 0)
  if (leaked > 0) {
    problems.push({ file, kind: '公式泄漏成字面量', detail: `${leaked} 处 $$ 或 \\[ 未被渲染` })
  }

  // 3. 大纲能不能提取（renderMarkdown(src,1) 后标题落在 h2–h4）
  const headings = extractHeadingsFromHtml(html, 2, 4)
  if (headings.length === 0) {
    problems.push({ file, kind: '大纲为空', detail: 'h2–h4 一个都没提取到' })
  }
  const dupIds = new Set<string>()
  const seen = new Set<string>()
  for (const h of headings) {
    if (seen.has(h.id)) dupIds.add(h.id)
    seen.add(h.id)
  }
  if (dupIds.size > 0) {
    problems.push({ file, kind: '标题锚点重复', detail: [...dupIds].join(', ') })
  }

  // 4. 图片引用必须能解析到 src/assets/lessons/ 下的真实文件
  const imgs = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1])
  let badImages = 0
  for (const s of imgs) {
    // 站点渲染时已把相对路径替换成 Vite URL；这里回头查原始 md 里的引用更可靠
    if (!s || s.startsWith('data:')) continue
  }
  const mdImgs = [
    ...src.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g),
    ...src.matchAll(/!\[\[([^\]]+)\]\]/g),
  ].map((m) => m[1])
  for (const ref of mdImgs) {
    if (/^(?:https?:|data:|\/)/i.test(ref)) continue
    if (!resolveImageOnDisk(ref)) {
      badImages++
      problems.push({ file, kind: '图片未解析', detail: ref })
    }
  }

  // 5. 表格里混进块级公式（会破坏表格结构）；列表里混进块级公式同理
  const tableBlocks = [...src.matchAll(/^\|.*\$\$.*$/gm)].length
  if (tableBlocks > 0) {
    problems.push({ file, kind: '表格内含 $$', detail: `${tableBlocks} 行` })
  }

  return { formulas: (src.match(/\$[^$\n]+\$/g)?.length ?? 0), headings: headings.length, images: imgs.length }
}

const args = process.argv.slice(2)
const targets = args.length > 0 ? args : [DEFAULT_DIR]

let files: string[] = []
for (const t of targets) {
  if (!fs.existsSync(t)) {
    console.error(`找不到：${t}`)
    process.exit(2)
  }
  files = files.concat(collect(t))
}

console.log(`校验 ${files.length} 篇讲义\n`)
for (const f of files) {
  const r = checkFile(f)
  console.log(`  ${path.basename(f)}  标题 ${r.headings} · 渲染后 img ${r.images}`)
}

if (problems.length === 0) {
  console.log('\n✅ 渲染校验通过：无 katex-error、无公式泄漏、大纲与图片均正常')
  process.exit(0)
}

console.log(`\n❌ 发现 ${problems.length} 个问题\n`)
for (const p of problems) {
  console.log(`  ${path.basename(p.file)}  [${p.kind}]  ${p.detail}`)
}
process.exit(1)