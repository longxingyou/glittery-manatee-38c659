# 分类侧边栏修复/优化 + 附件「游客可见」开关

## Context（背景与目标）

站点 Syntax Garden（TanStack Start + Cloudflare Workers + Neon）有三个关联诉求：

1. **后台新建的分类不出现在侧边栏。** 根因有两层（均已核实）：
   - **边缘 HTML 缓存未失效**：侧边栏分类由 root loader（[__root.tsx:286-301](file:///c:/Projects/my-website/glittery-manatee-38c659/src/routes/__root.tsx)）经 `allCategoriesFn` 取数并编译进 SSR HTML；首页/归档/分类页被 worker 三级缓存缓存（[worker.ts:337-374](file:///c:/Projects/my-website/glittery-manatee-38c659/worker.ts)）。但 `createCategory` / `saveCategory` / `deleteCategory`（[db/index.ts:1571-1670](file:///c:/Projects/my-website/glittery-manatee-38c659/db/index.ts)）**都没有调用任何缓存失效**（对比发文路径的 `invalidatePublishedCache`，[db/index.ts:1061](file:///c:/Projects/my-website/glittery-manatee-38c659/db/index.ts)）。
   - **构建期静态快照优先直出**：worker 在三级缓存之前先用 `ASSETS.fetch` 直出 `scripts/snapshot-pages.mjs` 生成的静态 HTML（`X-Cache: HIT-ASSET`，[worker.ts:318-335](file:///c:/Projects/my-website/glittery-manatee-38c659/worker.ts)）。快照只在下次部署时重建，硬加载永远先吃到构建时点的分类。
2. **分类将来会变多**，需要更好的排序与展示逻辑，方便查找（用户重视手机端、防误触）。
3. **附件目前对游客全封闭**（列表、预览、下载、计数四个点都强制登录）。需要后台为单个附件增加「游客可见」开关，**默认关闭**；勾选后游客可看可下，其余附件维持登录可见。

目标：以最低成本、复用既有模式（缓存失效器、`usePublishedPosts` SWR、`setAttachmentPassword` 开关、幂等 ALTER 迁移）完成，不引入新问题，typecheck + build 通过。

---

## 第一部分：修复新分类不显示（需求 1）

### 1.1 服务端：分类增删改后失效边缘 HTML

文件：[db/index.ts](file:///c:/Projects/my-website/glittery-manatee-38c659/db/index.ts)

- 在 `invalidatePublishedCache`（L1061）附近**新增** `invalidateCategoryHtml(names: string[] = [])`：只清分类相关的 HTML 缓存，不动 `posts:published` 等文章数据缓存（分类变更不影响文章清单，零浪费）。
  - 删 KV：`html:/`、`html:/archive`、每个 name 的 `html:/category/<encodeURIComponent(name)>`（复用 `safeKvDelete` / `getEnv().SG_CACHE`）。
  - 删当前 colo 边缘缓存：`edgeCacheDelete(getWorkerOrigin()+path)`（与 `invalidatePublishedCache` 同口径）。
- 三个分类函数成功后调用：
  - `createCategory` → `invalidateCategoryHtml([trimmed])`。
  - `saveCategory` → 改名分支清 `[旧名, 新名]`；仅改译名 / 新建 / 已存在补译名分支清 `[name]`（共 4 个 return 前）。
  - `deleteCategory` → 删除后清 `[被删name]`（用 L1661 已查出的 `rows[0].name`）。

> 其它 colo 的边缘副本等 s-maxage（10 分钟）自然过期；硬加载的快照陈旧由 1.2 客户端补拉兜底（与文章列表同一既定策略）。

### 1.2 客户端：挂载后 SWR 补拉分类（兜快照/浏览器缓存）

文件：[__root.tsx](file:///c:/Projects/my-website/glittery-manatee-38c659/src/routes/__root.tsx)（RootComponent，L340 起）

- 仿 [use-published-posts.ts](file:///c:/Projects/my-website/glittery-manatee-38c659/src/lib/use-published-posts.ts) 的一次性挂载补拉：用 `useState(categories)` 保存 `liveCats`，`useEffect([], ...)` 调一次 `publicServerFns.allCategoriesFn()`（该 server fn 直查 DB、无 HTML 缓存），用 `name|nameEn|nameRu|count` 拼接签名比对，**有差异才 `setLiveCats`**（暖态无闪烁），失败静默。
- `setCategoryLabels(...)`（L366）与 `<SiteShell categories={...}>`（L406）改用 `liveCats`，保证侧边栏与文章页分类译名同时修正。首帧仍用 loader 数据，**无 hydration mismatch**。

---

## 第二部分：分类排序与展示优化（需求 2）

原则：热门（有文章、文章多）在前；分类很多时可折叠 + 框内筛选 + 限量展开，默认展开不隐藏，手机端友好。

### 2.1 透传统计数

- [utils.ts:100](file:///c:/Projects/my-website/glittery-manatee-38c659/src/lib/utils.ts)：`CategoryLabel` 增加可选字段 `count?: number`（`CategoryInfo` 已含 `dbCount/staticCount`，不改）。
- [public-fns.tsx:203-211](file:///c:/Projects/my-website/glittery-manatee-38c659/src/components/public-fns.tsx) `allCategoriesFn`：map 时输出 `count: c.dbCount + c.staticCount`。
- [__root.tsx:287-289](file:///c:/Projects/my-website/glittery-manatee-38c659/src/routes/__root.tsx) 静态降级 labels：用 `allPosts` 顺手算 count（降级路径也一致；可选链已兜底）。

### 2.2 排序 + 折叠 + 筛选 + 限量

文件：[site-shell.tsx](file:///c:/Projects/my-website/glittery-manatee-38c659/src/components/site-shell.tsx)（L55-58 排序、L186-198 渲染）

- 排序：先按 `count`（缺省 0）**降序**，count 相同再按当前语言展示名 `localeCompare`（保留现有 locale 逻辑）。0 篇的新分类仍展示，只是排在末尾。
- 新增三个本地 state：`catCollapsed`（默认 false）、`catFilter`（串）、`catShowAll`（默认 false）。常量 `FILTER_THRESHOLD = 8`、`REVEAL = 7`。
- `tree-caption`「分类」改为可点击按钮（含 `ChevronDown`，折叠时旋转 -90°，`aria-expanded`）。
- 未折叠且 `categories.length >= 8`：在标题下渲染一个小型筛选输入（`Search` 图标 + 占位文案 `shell.cat.filter`），对 `name/nameEn/nameRu` 做不区分大小写包含匹配；筛选时展示全部匹配项。
- 未筛选且条数 > 7：默认只显示前 7 条，末尾一个「显示其余 N 个 / 收起」按钮（`shell.cat.more` / `shell.cat.less`）。
- 每个分类项右侧在 count>0 时显示淡色计数徽标（新增 `.tree-count`，`margin-left:auto`）。

样式：[styles.css:132-136](file:///c:/Projects/my-website/glittery-manatee-38c659/src/styles.css) 的 `.tree-item/.tree-caption/.file-dot` 附近，新增少量类：`.tree-caption-btn`、`.tree-caption-chevron.collapsed`、`.tree-filter`（复用 `--panel-2/--border/--text/--faint/--accent` 变量，紧凑 11px）、`.tree-more`、`.tree-count`。沿用 VS Code 编辑器观感。

---

## 第三部分：附件「游客可见」全链路（需求 3）

语义：`guest_visible=true` 的附件对游客出现在列表、可预览、可下载；**默认 false**。若该附件同时设了密码，游客仍需输密码解锁（密码即门禁），不削弱密码锁。其余附件对游客依旧 401/不可见。

### 3.1 DB schema + 幂等迁移

- [db/schema.ts:75-97](file:///c:/Projects/my-website/glittery-manatee-38c659/db/schema.ts)：attachments 表加 `guestVisible: boolean('guest_visible').notNull().default(false)`（`boolean` 已在本文件用过）。
- [db/index.ts](file:///c:/Projects/my-website/glittery-manatee-38c659/db/index.ts) `ensureSchema`（L316-339）：CREATE TABLE DDL 加 `guest_visible BOOLEAN NOT NULL DEFAULT FALSE`，并在其后加幂等增量行 `ALTER TABLE attachments ADD COLUMN IF NOT EXISTS guest_visible BOOLEAN NOT NULL DEFAULT FALSE`（既有列缺失由 `readWithSchemaFallback` 42703 → ensureSchema → 重试自动补，见 L64-91）。

### 3.2 DB CRUD（db/index.ts）

- `toPublic`（L1696）：入参类型与返回对象加 `guestVisible: !!row.guestVisible`。
- `listAttachmentsPublic`（L1723）：增加可选参 `opts?: { guestOnly?: boolean }`；select 加列；**先按 guestOnly 过滤行，再 map/签 gwDl**（避免给游客签隐藏附件的直链）。
- `listAttachmentsAdmin`（L1773）、`insertAttachment` 的 returning（L1837）、`getAttachmentByStorageKey`（L1852）、`getAttachmentFullRow`（L1878，门禁要用）：select 加 `guestVisible`。
- 新增 `setAttachmentGuestVisible(id, visible)`：`requireAdmin()` 后 update（参照 `setAttachmentPassword` L1916，不额外 ensureSchema）。
- [utils.ts:80-97](file:///c:/Projects/my-website/glittery-manatee-38c659/src/lib/utils.ts)：`AttachmentPublic` 加 `guestVisible: boolean`。

### 3.3 服务端门禁

[public-fns.tsx](file:///c:/Projects/my-website/glittery-manatee-38c659/src/components/public-fns.tsx)：
- `postAttachmentsFn`（L258-266）：不再对游客 throw；`const user = await getCurrentUser()`，返回 `listAttachmentsPublic(slug, { guestOnly: !user })`。
- `attachmentPreviewFn`（L288-341）：把 user 门禁移到取 row 之后——`if (!user && !row.guestVisible) return { authRequired:true }`；后续密码 token 校验与 URL 拼装与用户身份无关，游客（含持 token 的密码解锁游客）自然走通。

[api.comments.ts](file:///c:/Projects/my-website/glittery-manatee-38c659/src/routes/api.comments.ts)：三处统一改为「先解析 id+取 row，再按 `!user && !row.guestVisible → 401 authRequired`」，密码锁/token 校验原样保留：
- `authorizeAttachment`（L234-251，覆盖 `handleFileGet` L355 与 `handleFileUrlsGet` L256）。
- `handleTokenPost`（L527-547）：游客对 guestVisible 附件可取 token（无密码直接签发短 token；有密码校验密码后签发）。
- `handleRecordDownloadPost`（L280-291）：游客对 guestVisible 非密码附件的网关直连计数放行（密码锁仍 204 不重复计）。

### 3.4 前台面板

[public-fns.tsx](file:///c:/Projects/my-website/glittery-manatee-38c659/src/components/public-fns.tsx) `AttachmentPanel`（L397-544）：
- 加载 effect 由「仅 authed」改为「`auth !== 'checking'` 即加载」（游客也拉，只收到 guestVisible 项）。
- 游客门禁块（L451-465）改为**仅当游客且确认 0 个可见附件且无 error 时**显示；加载中 items=null 走现有骨架，避免门禁闪烁；游客有可见附件时与登录用户同一套列表 UI（下载/预览/密码解锁都已被 3.3 放行）。
- `/preview/$id`（[preview.$id.tsx:867](file:///c:/Projects/my-website/glittery-manatee-38c659/src/routes/preview.$id.tsx)）以 `info.authRequired` 分支，server fn 放行后游客直接进预览/`LockView`，无需改动。

### 3.5 后台开关

[card.tsx](file:///c:/Projects/my-website/glittery-manatee-38c659/src/components/ui/card.tsx)：
- 新增 server fn `setAttachmentGuestVisibleFn`（POST，validator `{id:number, visible:boolean}`），仿 `setAttachmentPasswordFn`（L243-249）调 `mod.setAttachmentGuestVisible`。
- `AttachmentManager` 每行 meta 区（L1856 锁状态 chip 旁）加一个可点击 chip 开关：`att.guestVisible` 时为高亮 `chip unlock`（`Eye` + `admin.am.guest.on`），否则为 `chip lock`（`EyeOff` + `admin.am.guest.off`），`title=admin.am.guest.hint`，`disabled=busyId===id`；点击调 fn 并本地 `onChange` 更新 `guestVisible`（仿 `setPassword` L1784）。放在 meta 行不挤占已很满的操作行，利于手机端。lucide 增加 `Eye, EyeOff` 导入。

### 3.6 i18n（三语必须对齐）

文件：[i18n-messages.ts](file:///c:/Projects/my-website/glittery-manatee-38c659/src/lib/i18n-messages.ts)（zh 区块 L8 起、en 约 L1411 起、ru 约 L2743 起；三段各加同 key）：
- 后台附件：`admin.am.guest.on`、`admin.am.guest.off`、`admin.am.guest.hint`（中：游客可见 / 仅登录可见 / 提示语；英、俄对应）。
- 侧边栏：`shell.cat.filter`、`shell.cat.more`（带 `{n}` 占位）、`shell.cat.less`。
- 前台游客门禁复用现有 `attach.login.*`，不新增。

---

## 验证

1. 类型：`pnpm typecheck`（tsc --noEmit）零错误。
2. 构建：`node node_modules/vite/bin/vite.js` build，以 `"EXIT_CODE=$LASTEXITCODE"` 确认退出码 0（PowerShell 下 pnpm 输出走错误流易误判）。
3. 重建静态快照：`node scripts/snapshot-pages.mjs`（新分类/新字段随下次部署进 HIT-ASSET）。
4. 逻辑自查清单：
   - 后台新建/改名译名/改名/删除分类后：首页与归档侧边栏、相关分类页在 SSR 与硬加载（客户端补拉后）均反映变化。
   - 分类 ≥8 时出现筛选框、默认 7 条 + 展开/收起；排序为文章数降序、计数徽标正确；手机端无横向溢出、可点击区域不拥挤。
   - 附件默认游客不可见（游客列表/预览/下载/计数仍 401 或不出现）；后台勾选后：游客能在文章页看到并下载/预览该附件（含密码锁需输密码）；未勾选附件与所有非 guestVisible 路径依旧 401；登录用户行为不变。
