# 文章「下载/导出」功能实施计划

## Context

访客目前只能在线阅读文章。需求：管理员可逐篇开启「下载」按钮；访客一键进入干净的导出页，把文章保存为 **PDF（打印另存）/ Word .docx / Markdown / 独立 HTML**。导出文件只含标题、梗概、分类、正文（普通文章），不含侧边栏、功能栏、附件与评论；彩蛋文章则下载完整页面。导出文件自带可跳转的目录（替代网页上的大纲浮动按钮），Obsidian 风格交互（折叠 callout、站内双链、mermaid 等）在静态文件中以「展开/绝对链接/图片化」方式不打折扣地降级。

已确认：四种格式全做；开关默认关、逐篇开启；普通文章按钮放在 meta 行（分享按钮旁），彩蛋页为接管页右上角浮动按钮。

## 关键现状（已勘察）

- 文章数据：`PostData`（[utils.ts](file:///c:/Projects/my-website/glittery-manatee-38c659/src/lib/utils.ts)）；静态文章经 [content-collections.ts](file:///c:/Projects/my-website/glittery-manatee-38c659/content-collections.ts) 编译，DB 文章走 `posts` 表（[db/schema.ts](file:///c:/Projects/my-website/glittery-manatee-38c659/db/schema.ts) + [db/index.ts](file:///c:/Projects/my-website/glittery-manatee-38c659/db/index.ts)，幂等建表/增量列模式：`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`）。
- 渲染：`renderMarkdown` / `extractHeadingsFromHtml`（[markdown.ts](file:///c:/Projects/my-website/glittery-manatee-38c659/src/lib/markdown.ts)）——callout（可折叠 details）、`[[双链]]`（相对 href `/posts/...`）、mermaid（`.mermaid-source` 待客户端渲染）、脚注、KaTeX。
- 文章页：[posts.$slug.tsx](file:///c:/Projects/my-website/glittery-manatee-38c659/src/routes/posts.$slug.tsx)（meta 行已有分享按钮；彩蛋 takeover 用 `body.egg-takeover` + CSS 隐藏站点 chrome，可仿照）。
- 大纲：[article-outline.tsx](file:///c:/Projects/my-website/glittery-manatee-38c659/src/components/article-outline.tsx)（`.outline-fab` 右下浮动）。
- 打印：[styles.css](file:///c:/Projects/my-website/glittery-manatee-38c659/src/styles.css) 尾部已有 `@media print` 块（未隐藏 `.outline-fab`）。
- 彩蛋 HTML 出口：[egg.$slug.tsx](file:///c:/Projects/my-website/glittery-manatee-38c659/src/routes/egg.$slug.tsx)（同源 iframe，`contentWindow.print()` 可用）。
- 绝对链接基址：`getPublicOrigin()`（[server-env.ts](file:///c:/Projects/my-website/glittery-manatee-38c659/src/lib/server-env.ts)）。
- 后台编辑器：[card.tsx](file:///c:/Projects/my-website/glittery-manatee-38c659/src/components/ui/card.tsx) `PostEditorPage`（`PostSaveInput` → `savePostFn` → `mod.savePost`）。
- i18n：[i18n-messages.ts](file:///c:/Projects/my-website/glittery-manatee-38c659/src/lib/i18n-messages.ts) 三语（zh/en/ru 各一组，参照 `post.share`）。

## 实施步骤

### 1. 开关字段（数据层）

- `content-collections.ts`：schema 加 `download: z.boolean().optional()`（静态文章 frontmatter 写法 `download: true`）。
- `db/schema.ts`：posts 加 `downloadable: boolean('downloadable').notNull().default(false)`。
- `db/index.ts`：
  - `ensureSchemaInternal`：posts 建表语句加列 + 追加幂等迁移 `ALTER TABLE posts ADD COLUMN IF NOT EXISTS downloadable BOOLEAN NOT NULL DEFAULT FALSE`。
  - `mapStaticPost`：`downloadable: (p as {download?: boolean}).download === true`；`mapDbPost`：`downloadable: row.downloadable === true`（`DbPostRow` 类型补 `downloadable?: boolean | null`）。
  - `savePost`：insert 与 update 均写入 `downloadable: input.downloadable === true`。
- `src/lib/utils.ts`：`PostData` 加 `downloadable: boolean`。
- 缓存兼容：KV/内存缓存中的旧 `PostData` 无此字段 → `undefined` 视为关，保存文章后 `invalidatePublishedCache` 已会刷新，无需额外处理。

### 2. 后台编辑器开关

`card.tsx` `PostEditorPage`：
- `bootstrap` state 加 `downloadable: boolean`（默认 `false`；编辑/译本初始化时从 `post.downloadable` 读入）。确认 `getPostForEditFn` 返回完整 post（走 `mapDbPost` 即自动带出新字段）。
- `PostSaveInput` 加 `downloadable?: boolean`；`submit` 带上。
- meta 区（`.editor-meta` 第二个 `meta-row` 附近）加 checkbox：「允许访客下载/导出本文」+ 提示小字（新增 i18n：`admin.f.download` / `admin.f.download.hint`）。

### 3. 导出文档生成（新文件 `src/lib/export-doc.ts`）

共享纯函数（SSR/客户端均可用）：

- `buildExportBody(post)`: `renderMarkdown(post.content)` 后做导出专用后处理（字符串级，幂等）：
  1. 相对链接/资源（`href="/`、`src="/`）→ 拼上 `getPublicOrigin()`，离线文件中站内链接仍跳回线上（双链因此可用）；
  2. `<details` 一律补 `open`（折叠 callout 在静态文件中展开，内容不打折）；
  3. 剔除标题尾部 `<a class="anchor">#</a>`（导出文件里无意义的自指链接）。
- `EXPORT_CSS`：独立内联样式字符串（系统字体栈、标题/表格/代码块/callout 基础配色、目录样式、`@media print { .export-toolbar{display:none} }` + `print-color-adjust: exact`）。导出页与 HTML 下载共用同一份。
- `buildStandaloneHtml(model)`：完整 HTML 文档 = 头部（标题/摘要/日期/分类）+ **目录**（`extractHeadingsFromHtml` 产物，h2-h4，`<a href="#id">`；<2 个标题则省略）+ 正文 + 页脚（来源 URL）。目录锚点与正文标题 `id` 对应：HTML/PDF 中可点击跳转；docx 经 altChunk 由 Word 转成书签内部链接。
- `buildDocx(html, title)`：纯 TS 生成真 .docx（**不新增依赖**）：ZIP(STORE) + CRC32（~80 行），包含 `[Content_Types].xml`、`_rels/.rels`、`word/document.xml`（`<w:altChunk r:id="htmlDoc"/>`）、`word/_rels/document.xml.rels`、`word/htmlDoc.html`。Word/WPS 打开即转换。
- `saveBlob(blob, filename)` 辅助（a[download] 触发）。
- Mermaid 处理在调用侧（见下）。

### 4. 导出页路由 `src/routes/export.$slug.tsx`

- loader：`getPublishedPostFn({slug})` + `postEggMetaFn`；文章不存在 / 未发布 / `post.downloadable !== true` → `notFound()`（开关关闭时导出入口不存在）。彩蛋文章重定向回 `/posts/$slug`（彩蛋走第 5 步的浮动按钮，不进此页）。
- 渲染纯净导出页：
  - `useEffect` 给 body 加 `export-mode` class（卸载移除），样式隐藏 titlebar/activitybar/sidebar/statusbar/tabs-row 等全部站点 chrome（仿 `egg-takeover` 手法）。
  - 页内 `<style>{EXPORT_CSS}</style>` 自包含排版。
  - 顶部工具条 `.export-toolbar`（`.no-print`，sticky）：**保存 PDF**（`window.print()`）、**下载 Word (.docx)**、**下载 Markdown**（`post.content` → blob）、**下载 HTML**（`buildStandaloneHtml` → blob）、**返回正文**（Link）。
  - 正文容器 ref + `useMermaidLazy(contentRef)`：客户端渲染 mermaid 为 SVG（打印/PDF/HTML 序列化均拿到渲染后结果）。
- **下载 Word** 点击流程：序列化正文容器 `innerHTML`（已是 mermaid 渲染后）→ 遍历其中 `svg` 尝试 canvas 转 PNG dataURL（try/catch；mermaid 含 foreignObject 时 canvas 会被污染抛错）→ 失败的图回退为「源码 pre + 在线查看链接」（需求 3 的降级策略）→ `buildDocx` → `saveBlob`。
- **下载 HTML**：同一序列化结果直接套 `buildStandaloneHtml`（SVG 在浏览器可正常显示，无需转 PNG）。
- 目录用 `extractHeadingsFromHtml(articleHtml)` SSR 直出。
- head()：加 `noindex` meta，title 用 `导出 · {post.title}`。

### 5. 文章页入口

`posts.$slug.tsx`：
- 普通文章：`post.downloadable` 时在 `.article-meta` 末尾加下载按钮（lucide `Download` 图标，样式同分享按钮），`<Link to="/export/$slug">`。打印时被现有 `@media print` 的 `.article-meta button` 规则隐藏；将其改为显式 class（如 `className="post-download-btn"`）并补进打印隐藏列表更稳妥（现有规则是元素选择器，Link 渲染为 `<a>` 不在其列——需在打印 CSS 中补 `.article-meta a.post-download-btn` 或统一包一层）。
- 彩蛋 takeover 分支：`post.downloadable` 时渲染右上角浮动小按钮（`.egg-download-fab`，z-index 高于 iframe），点击展开小菜单：
  - **下载完整 HTML**：`fetch('/egg/'+slug)`（得到字体注入后的完整页面）→ blob 保存；
  - **打印 / 存为 PDF**：同源 iframe `contentWindow.print()`（需求 6：彩蛋下载完整页面）。

### 6. 样式与打印补充（styles.css）

- 现有 `@media print` 块的选择器列表追加 `.outline-fab, .outline-panel, .post-download-btn, .egg-download-fab`（需求 2：大纲图标不进任何打印/保存产物）。
- 新增 `.export-mode` 隐藏站点 chrome 的规则（对照 692-698 行 `.egg-takeover` 列表）+ export 页最小布局（居中列、工具条样式，变量复用现有语义色）。
- 彩蛋浮动按钮样式（复用 outline-fab 的玻璃质感，位置 top-right 避免与 egg 内容底边操作冲突）。

### 7. i18n（三语）

`i18n-messages.ts` zh/en/ru 各加：`post.download`、`post.download.title`、`export.toc`（可复用 `article.outline`）、`export.pdf`、`export.docx`、`export.markdown`、`export.html`、`export.back`、`export.source`、`export.noindex` 相关、`egg.dl.html`、`egg.dl.pdf`、`admin.f.download`、`admin.f.download.hint` 等（以实际键名为准，参照 `post.share` 组的位置放置）。

## 涉及的文件

| 文件 | 改动 |
|---|---|
| `content-collections.ts` | schema 加 `download` 可选布尔 |
| `db/schema.ts` / `db/index.ts` | `downloadable` 列 + 幂等迁移 + map/save |
| `src/lib/utils.ts` | `PostData.downloadable` |
| `src/components/ui/card.tsx` | `PostSaveInput` + 编辑器 checkbox |
| `src/lib/export-doc.ts`（新） | 导出后处理 / EXPORT_CSS / docx 生成 / saveBlob |
| `src/routes/export.$slug.tsx`（新） | 导出页路由 |
| `src/routes/posts.$slug.tsx` | meta 行下载按钮 + 彩蛋浮动按钮 |
| `src/styles.css` | 打印隐藏补充 + export-mode + 按钮样式 |
| `src/lib/i18n-messages.ts` | 三语文案 |

## 验证

1. `pnpm typecheck` 通过。
2. `pnpm dev`（需 `.dev.vars` 配 DATABASE_URL 以测 DB 文章）：
   - 后台编辑器勾选「允许下载」→ 发布 → 文章页 meta 行出现下载按钮；取消勾选后按钮消失且 `/export/slug` 404。
   - 静态文章 frontmatter 加 `download: true` 同样生效。
3. 导出页逐项验证：
   - 目录出现在页面上方，点击锚点跳转；`window.print()` 打印预览中无工具条/大纲浮动图标、排版整洁；
   - 下载 .docx 用 Word/WPS 打开：目录为内部跳转链接、折叠 callout 已展开、双链指向线上绝对地址、mermaid 为图片（或降级为源码+链接）；
   - 下载 .md 为源文；下载 .html 双击打开样式完整、SVG 图表可见。
4. 彩蛋文章：接管页右上角浮动钮 → 下载完整 HTML（含字体注入）、iframe 打印存 PDF。
5. 在文章页直接 Ctrl+P：大纲浮动按钮与下载按钮均不出现在打印预览中。
