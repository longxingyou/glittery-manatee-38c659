# 课程精讲独立为 /lessons 课程中心

## Context

俄语工具箱内的「课程精讲」 tab 当前通过 `import.meta.glob(..., eager:true)` 把 30 课约 1.8MB Markdown 全部内联进工具箱 lazy chunk，且导航是 chip 按钮墙（`ru-mat-chip` 横向排列），「一眼望去全是交互按钮」。用户要求：

1. 拆到独立路径 `/lessons`——通用课程中心，未来可挂其他学科（`BookMeta.subject` 字段预留）
2. 交互重构：`/lessons` 教材卡片概览 + `/lessons/$lessonId` 单课阅读页（可分享单课链接）
3. 俄语工具箱内的 lessons tab **彻底删除**（不留跳转卡片）

附带收益：md 改按需加载（每课独立 chunk），工具箱与概览页都不再背负全部正文。

## 改动清单

### 新建

- **`src/lib/lessons.ts`**：从 [russian-lessons.tsx](file:///c:/Projects/my-website/glittery-manatee-38c659/src/components/russian-lessons.tsx) L34-102 迁入 `BookMeta`/`LessonMeta`/`BOOKS`/`LESSONS`/`GROUPS`；`BookMeta` 加 `subject: 'russian'` 字段。md 加载改 `eager:false`，导出 `loadLessonSource(file): Promise<string|undefined>`
- **`src/components/lessons-index.tsx`**：教材卡片概览。subject→book 分组；卡片含书名/hint/课数/「继续阅读」主按钮（读 localStorage `dsh.ru.lessons.last`）；卡内课程列表改为 **Link 行**（替代 chip 墙）；reserved 书保留虚线占位
- **`src/components/lesson-page.tsx`**：单课阅读页。三栏：左目录（sticky，≥900px）｜正文 `markdown-body compact ru-les-body`｜`ArticleOutline`；底部「上一课/下一课」。迁入 `stressHtml`（仅 russian 套用）、打印逻辑（`.ru-mat-print` + `ru-mat-printing`，复用 [styles.css](file:///c:/Projects/my-website/glittery-manatee-38c659/src/styles.css) L2014-2029）、localStorage 写入

### 修改

- **`src/router.tsx`**：加 `lessonsRoute`（`/lessons`）与 `lessonDetailRoute`（`/lessons/$lessonId`），编程式 createRoute 仿 `/russian`（L139-150）；详情路由 `beforeLoad` 中 `findLesson` 不存在则 `throw notFound()`（模式见 `posts.$slug.tsx` L53），`head` 输出每课 title/canonical；`mergedChildren` 幂等合并追加两条
- **`src/components/russian-toolkit.tsx`**：删 L19 lazy import、L30 `'lessons'` union、L1252 tab 项、L1292-1302 渲染块
- **`src/components/site-shell.tsx`**：L208 后加 `/lessons` 导航（GraduationCap 图标，「课程中心.html」/「Lessons.html」/「Уроки.html」）
- **`src/lib/i18n-messages.ts`**：新增 `shell.lessons.file`、`les.index.title/sub`、`les.book.count`、`les.continue/start`、`les.prev/next`、`les.toc.open/close`、`les.back`；复用 `ru.les.group.*`、`ru.les.toc*`、`ru.mat.print/missing`；删除 `ru.tab.lessons`
- **`src/styles.css`**：新增 `les-index-grid`（`repeat(auto-fill,minmax(300px,1fr))`）、`les-book-card`、`les-lesson-row`、`les-layout`（≥900px `grid:250px 1fr`）、`les-toc`+`les-toc-mask`（抽屉，仿 L2814-2825 `x-drawer`）、`les-prevnext`；`ru-mat-chip` 保留（materials tab 仍在用）

### 删除

- `src/components/russian-lessons.tsx` 整文件

## 移动端

<900px 隐藏左目录，正文顶部显示「目录」按钮；抽屉 `width:min(88vw,320px)` 滑入，点课跳转并收起，Esc/mask 点击关闭。

## 关键风险

1. **分包边界**：`lessons.ts` 与 `lessons-index.tsx` 严禁 eager import md；构建后验证概览 chunk 不含正文（`Select-String` 查「Здра́вствуйте」只在单课 chunk）
2. **SSR**：详情路由 loader `await loadLessonSource()`，md 字符串序列化进首屏 HTML；`renderMarkdown` 纯字符串处理 SSR 安全（现状已依赖）
3. **localStorage**：key `dsh.ru.lessons.last` 不迁移，LessonPage 写、LessonsIndex 读
4. **重音**：`stressHtml` 仅 `subject==='russian'` 生效

## 验证

1. `pnpm exec tsc --noEmit`
2. dev：`/lessons` 卡片页 → `/lessons/l1` 直开（SSR 含正文）→ `/lessons/bad-id` 404 → 上一课/下一课 → 继续阅读 → 三语切换 → 打印预览
3. `pnpm run build` 对比 chunk 体积
4. 手机仿真：抽屉开合、无横向溢出
5. 部署 + Azure SOCKS 隧道实测线上 200
