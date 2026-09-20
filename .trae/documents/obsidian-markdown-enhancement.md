# Obsidian 风格 Markdown 增强计划

## 背景

当前站点使用 `marked@17.0.6` + 自定义 Renderer 渲染 Markdown，仅支持 GFM、KaTeX 和表情包 shortcode。用户希望获得与 Obsidian 一致的 Markdown 功能集（高亮、脚注、Callout、Mermaid 图表、注释、对齐、内部链接、图片等），且所有样式仅作用于 `.markdown-body` 范围，不影响其他 UI。

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/lib/markdown.ts` | 核心：新增 5 个 marked 扩展 + 3 个 Renderer 覆写 + 2 个预处理 + 1 个后处理 |
| `src/styles.css` | 在 `.markdown-body` 块后追加 ~120 行 scoped CSS |
| `src/lib/use-mermaid.ts` | 新建：Mermaid 客户端懒加载 Hook |
| `src/routes/posts.$slug.tsx` | 加 ref + `useMermaidLazy` |
| `src/components/comment-section.tsx` | 加 ref + `useMermaidLazy` |
| `worker.ts` | `/vendor/` 加入静态资源路径 + immutable 缓存 |
| `public/vendor/mermaid.esm.min.mjs` | 下载自托管 Mermaid 11 ESM |

## 功能清单

### 1. 高亮 `==text==` → `<mark>`
inline 扩展，内层支持加粗/斜体/代码，CSS 用 `--orange` 半透明背景。

### 2. 脚注 `[^1]` + `[^1]: def`
- 预处理：正则提取 `[^\id]:` 定义到 Map，从源文移除
- inline 扩展：`[^id]` 引用 → `<sup class="footnote-ref"><a href="#fn-id">num</a></sup>`
- 后处理：在 HTML 末尾追加 `<section class="footnotes-section"><ol>…</ol></section>`
- 定义文本经同一 Marked 实例渲染（支持链接/强调）

### 3. Callout `> [!type] Title`
block 扩展，支持 7 种类型（note/tip/info/warning/danger/success/quote），3 种尺寸（small/normal/large），折叠变体（`+` 展开 / `-` 折叠）用原生 `<details>/<summary>` 免 JS。
- 语法：`> [!type|size](+/-) Title`
- 内部内容经 `this.lexer.block()` 递归解析（可嵌套 Callout/Mermaid/数学公式）

### 4. 标题锚点
Renderer 覆写 `renderer.heading`：slugify 标题文本 → `<h2 id="slug">Title <a class="anchor">#</a></h2>`
- Unicode 感知 slugify（保留 CJK）
- 重复标题自动加 `-2` `-3` 后缀
- hover 时显示 `#` 链接

### 5. Mermaid 图表
- Renderer 覆写 `renderer.code`：`lang === 'mermaid'` → `<div class="mermaid-source" data-mermaid-graph="1">escaped code</div>`
- 客户端 `useMermaidLazy` Hook：IntersectionObserver 懒加载 → 动态 `import('/vendor/mermaid.esm.min.mjs')` → `mermaid.run({ nodes })`
- 主题跟随站点 `data-theme` 属性
- CSP 无需修改（`script-src 'self'` 已允许同源 ESM）

### 6. 注释 `%%hidden%%`
预处理正则 `%%[\s\S]*?%%` → 空字符串，在 KaTeX 之前执行。

### 7. 对齐 `::: left|center|right`
block 扩展，内部内容经 `this.lexer.block()` 解析。

### 8. 内部链接 `[[slug]]` / `[[slug|Title]]`
inline 扩展 → `<a href="/posts/slug" class="internal-link">Title</a>`
- CSS 用 `::before`/`::after` 显示 Obsidian 风格的 `[[` `]]` 装饰

### 9. 图片 `![alt](https://url)`
Renderer 覆写 `renderer.image`：仅允许 `https://` 协议 → `<figure class="markdown-image"><img loading="lazy" /><figcaption>alt</figcaption></figure>`
- 非 https 保留现有 `[图片：alt]` 占位符

## 渲染管线（修改后）

```
renderMarkdown(source):
  1. 剥离 %%…%% 注释              (新增预处理)
  2. 提取 [^id]: 脚注定义          (新增预处理)
  3. KaTeX 预处理 (不变)
  4. new Marked({ gfm, breaks, renderer, extensions }) 解析
  5. 恢复数学公式占位符 (不变)
  6. 追加脚注章节 (新增后处理)
  7. renderStickerShortcode (不变)
```

每次调用创建独立 Marked 实例，状态通过闭包传递，无模块级可变状态。

## CSS 设计

所有选择器以 `.markdown-body` 或 `.markdown-body.compact` 开头。使用现有 CSS 变量（`--accent`, `--accent-2`, `--orange`, `--red`, `--purple`, `--line`, `--panel`, `--muted`），深色/浅色主题自动适配。

Callout 配色：
- note/info → `--accent-2`（蓝）
- tip/success → `--accent`（青绿）
- warning → `--orange`
- danger → `--red`
- quote → `--purple`

## 验证

1. `pnpm exec tsc --noEmit` 零错误
2. 创建测试 Markdown 文件验证所有语法
3. `pnpm dev` 本地验证：文章页 + 评论预览
4. `pnpm run deploy` 部署后线上验证
5. 浏览器检查：暗色/浅色主题、文章页/评论 compact 模式、Mermaid 渲染、Callout 折叠交互
