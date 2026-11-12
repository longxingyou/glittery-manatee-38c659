# 客户端 DjVu / 电子书预览 实施计划

## Context

站点现有附件预览矩阵（`src/lib/preview.ts`）只覆盖 pdf / 文本 / 图片 / 音视频 / 思维导图 / Office（服务端转 PDF）。DjVu、EPUB、MOBI、AZW3、CBZ、CBR 都返回 `null`，因此列表里连「预览」按钮都不显示。

目标：在**纯客户端**增加 DjVu 与 EPUB / MOBI / AZW3 / CBZ 预览；全部渲染器按需动态加载，不影响首屏与现有预览路径；解析失败/体积超限要优雅降级到下载。

已确认的可行性结论：

| 格式 | 方案 | 结论 |
|---|---|---|
| DjVu | `djvu-rs@0.43.0`（MIT，纯 Rust WASM，无 GPL；SIMD 582KB / 标量 573KB） | 可做。API：`init()` → `WasmDocument.from_bytes()` → `page.render(dpi)` 得到 RGBA |
| EPUB / MOBI / AZW3 / CBZ | `foliate-js@1.0.1`（MIT，纯 ESM，解包 375KB，内置 zip.js/fflate） | 可做。`view.open(File|Blob)` + `view.init()`，自动识别 EPUB/KF8(MOBI/AZW3)/CBZ |
| CBR (RAR) | 无可靠纯浏览器方案（libarchive.js 体积大、RAR5 兼容差） | **不做入口**（用户已确认）：不加入格式矩阵，维持「只能下载」 |

补充决策（用户已确认）：DjVu / 电子书 / CBZ 的整文件体积上限设为 **150 MiB**，超过则不显示预览按钮。

安全注意：foliate-js 的 paginator 用 `sandbox="allow-same-origin allow-scripts"` 的 iframe 渲染书页，若 EPUB/MOBI 内含脚本，会以本站同源身份执行。附件目前只有管理员能上传（`insertAttachment` 内部 `requireAdmin`），但仍需在渲染前给每个 HTML 资源注入 `script-src 'none'` 的 CSP meta，阻断电子书内脚本。

## 变更清单

### 1) `src/lib/preview.ts`（格式矩阵，前后端同构）

- `PreviewKind` 增加 `'djvu' | 'ebook'`。
- 新增：
  - `const EXT_DJVU = new Set(['djvu'])`
  - `const EXT_EBOOK = new Set(['epub', 'mobi', 'azw3', 'cbz'])`（**不含 cbr**）
  - `export const PREVIEW_EBOOK_MAX_BYTES = 150 * 1024 * 1024`
- `previewKind()`：`djvu` → `'djvu'`；ebook 集合 → `'ebook'`（放在 pdf 之后、文本之前）。
- `previewUiState()`：`kind === 'djvu' || kind === 'ebook'` 且 `sizeBytes > PREVIEW_EBOOK_MAX_BYTES` → `'none'`；其余逻辑不变。
- `isDirectPreviewKind()` 与 `isConvertibleForPreview()` 无需改动（新类型天然属于“直接渲染”）。
- `BlobPreviewKind` 保持不变（新类型由独立组件处理，不复用 `TextBlobView`）。

### 2) `src/lib/i18n-messages.ts`

在 `preview.*` 分组补充中/英（若有多语言）文案：
- `preview.djvu.loading` / `preview.djvu.page`（`{page}/{total}`）/ `preview.djvu.fail`
- `preview.ebook.loading` / `preview.ebook.prev` / `preview.ebook.next` / `preview.ebook.fail` / `preview.ebook.pct`（`{pct}%`）

### 3) `src/routes/preview.$id.tsx`（两个新视图 + 分派）

新增两个组件（沿用现有 `FetchHint` / `ProgressLine` / `formatBytes` / `DownloadFallback` 的写法）：

**`DjvuView({ url, filename })`**
1. `fetch(url, { credentials: 'same-origin' })` 取 `arrayBuffer`，有 `Content-Length` 时用现有 `ProgressLine` 显示进度（参照 `fetchText` 的 reader 写法，改为二进制累加）。
2. `const djvu = await import('djvu-rs'); await djvu.init(); const doc = djvu.WasmDocument.from_bytes(bytes)`。
3. 展示为**单页翻页器**（避免把几百页同时画进 canvas 造成内存暴涨）：
   - `doc.page_count()` 得到总页数；`doc.page(i).render(dpi)` → `putImageData` 到 `<canvas>`；
   - `dpi` 根据容器宽度计算（`canvas.clientWidth / page.width_at(96) * 96`，上限 200，避免超大画布）；
   - 上一页/下一页按钮 + 键盘 ←/→ + 页码显示；
   - 卸载时 `doc.free()`。
4. 解析抛错 → `preview.djvu.fail` + `DownloadFallback`。

**`EbookView({ url, filename })`**
1. 整文件 `blob()`（带进度条），受 150 MiB 闸门保护。
2. `await import('foliate-js/view.js')` 注册 `<foliate-view>` 自定义元素；`const view = document.createElement('foliate-view')`，挂到容器，设固定高度（CSS 见第 6 条）。
3. `await view.open(blob)`；随后取 `view.book.transformTarget`，注册 `data` 监听：对 `type` 含 `html/xhtml/xml` 的资源，在 `<head>` 后注入
   `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'">`，其余资源原样返回。
   （若某个格式没有 `transformTarget`，退化为不注入，并在代码注释里标注。）
4. `await view.init({ showTextStart: true })`；监听 `relocate` 事件取 `fraction` 显示百分比；提供 ←/→ 按钮调用 `view.goLeft()/goRight()`。
5. 卸载时 `view.remove()`、`book.destroy?.()`；失败显示 `preview.ebook.fail` + 下载按钮。
6. `makeBook` 只认 zip/EPUB/MOBI/CBZ；对伪造扩展名或损坏文件会抛 `UnsupportedTypeError`，统一落到失败态。

**`PreviewBody` 分派**
```tsx
case 'djvu': return <DjvuView url={fileUrl} filename={info.filename || ''} />
case 'ebook': return <EbookView url={fileUrl} filename={info.filename || ''} />
```
不动 pdf/office/md/text/csv/html/mindmap/image/audio/video 分支。

### 4) `worker.ts`（CSP）

- `script-src` 追加 `'wasm-unsafe-eval'`（djvu-rs 实例化 WASM 必需；不含 `unsafe-eval`，不放宽 JS eval）。
- `font-src` 追加 `blob:`（EPUB 内嵌字体经 blob URL 加载）；`style-src` 视实测补 `blob:`。
- `frame-src` 已有 `blob:`，无需改；`img-src` 已有 `blob:`。
- 只改 `CONTENT_SECURITY_POLICY`，`EGG_CONTENT_SECURITY_POLICY` 不动。

### 5) `vite.config.ts`

`djvu-rs` 的 loader 用 `new URL('./simd128/djvu_rs_bg.wasm', import.meta.url)` 定位 WASM。开发期需将其排除预打包，避免路径被 esbuild 改写：
```ts
optimizeDeps: { exclude: ['djvu-rs'] }
```
（若现有配置已有该字段则合并。）构建后需确认 `dist/client/assets` 里出现 `.wasm` 资产，且 DjVu/foliate 各自是独立 chunk。

### 6) `src/styles.css`

新增少量样式，沿用语义变量（`--border` / `--bg` 等）：
- `.pv-djvu-wrap`、`.pv-djvu-bar`、`.pv-djvu-canvas`（`max-width: 100%`、居中、`background: var(--bg)`）
- `.pv-ebook-wrap`（`height: calc(100vh - 120px); min-height: 420px`）、`.pv-ebook-wrap foliate-view { display: block; width: 100%; height: 100% }`
- 移动端媒体查询里把 ebook 高度改为 `calc(100svh - 100px)`。

### 7) `package.json`

已安装：`djvu-rs@0.43.0`、`foliate-js@1.0.1`。`pnpm add` 顺带把 `katex` 从 0.19.0 升到 0.19.1（原声明是 `latest`）——建议保留（补丁版本），若不希望有额外变更则固定回 `0.19.0`。

## 验证

1. `pnpm typecheck` 通过。
2. `pnpm build` 通过；检查产物：
   - 出现 `djvu_rs_bg-*.wasm` 资产；
   - `foliate-js` / `djvu-rs` 只在按需 chunk 中，不进入首屏主包。
3. 本地临时验证页（**验证后删除**）：新增一个仅开发用的临时路由，用 `public/` 下的样例文件（脚本生成最小 EPUB/CBZ；DjVu 用 djvu-rs 仓库样例或本地已有 .djvu）挂载 `DjvuView` / `EbookView`，用 browser_use 检查：
   - DjVu 能翻页、缩放后清晰、失败文件落到降级页；
   - EPUB 目录/翻页正常、中文与内嵌字体显示正常、书内脚本被 CSP 拦截（控制台可见 violation）；
   - CBZ 能按图片顺序翻页；
   - 移动端视口（390×844）不横向溢出。
4. 回归：打开一个现有 PDF / Markdown / 图片预览页，确认原有分支渲染与下载不变。
5. 清理临时路由与 `public/` 样例文件，再次 `pnpm typecheck`。

## 不做的事

- 不引入 CBR/RAR 解压，CBR 不进入格式矩阵（保持现状：只能下载）。
- 不新增服务端转换、不改附件存储与上传链路。
- 不改动现有预览类型的渲染与交互。
