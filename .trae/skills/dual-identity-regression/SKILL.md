---
name: "dual-identity-regression"
description: "Dual-perspective (admin-mock + guest) browser regression for this blog's login-gated features. Invoke when E2E-verifying comments, attachments, or admin moderation flows before deployment."
---

# 双身份浏览器回归（管理员 / 访客）

Syntax Garden（TanStack Start + Netlify）登录门禁类功能的端到端回归流程：评论、附件下载、管理员审核等。目标是同时回答两个问题——**管理员能做什么**、**访客被挡在哪里**。

## 触发时机

- 上线前验证评论 / 附件 / 后台权限类改动
- 需要确认同一界面在"已登录管理员 / 未登录访客"两种身份下的差异
- API 逻辑已写完，需要浏览器层确认渲染、交互与门禁引导

## 标准流程

### 1. 构建与双实例启动

先 `npx tsc --noEmit` → `pnpm run build`。构建后**必须重启** `vite preview`（内存缓存 SSR bundle，不重启会跑旧代码）。

管理员实例（4173，mock 身份）：

```powershell
$dbUrl=(Select-String -Path .env -Pattern '^NETLIFY_DB_URL=(.+)$').Matches[0].Groups[1].Value; $env:NETLIFY_DB_URL=$dbUrl; $env:NODE_ENV='development'; $env:DEV_MOCK_ADMIN_EMAIL='663865846@qq.com'; $env:ADMIN_EMAILS='663865846@qq.com'; npx vite preview --port 4173 --strictPort
```

访客实例（4174，**必须显式禁用 mock**）：

```powershell
$dbUrl=(Select-String -Path .env -Pattern '^NETLIFY_DB_URL=(.+)$').Matches[0].Groups[1].Value; $env:NETLIFY_DB_URL=$dbUrl; $env:NODE_ENV='development'; $env:ADMIN_MOCK_DISABLED='1'; npx vite preview --port 4174 --strictPort
```

> 注意：`.env` 文件里写有 `DEV_MOCK_ADMIN_EMAIL`，vite preview 会自动加载它——不设 `ADMIN_MOCK_DISABLED=1` 的"访客实例"仍然是管理员，这是最容易踩的坑。

身份探针（启动后先验证）：`GET /api/comments?action=adminStatus`

- 管理员：`{"authed":true,"isAdmin":true,"mocked":true}`
- 访客：`{"authed":false,"isAdmin":false,"mocked":false}`

### 2. 先 API 层、后 UI 层

- 写操作与权限逻辑先用 HTTP 请求验证（快、稳、可精确断言），浏览器只验证渲染与交互。
- **中文请求体禁止用 PowerShell `Invoke-RestMethod`**：UTF-8 会被按 Latin-1 编码导致乱码且 body 长度异常膨胀。一律写临时 Node 脚本（`tmp-*.mjs`，根目录）用全局 `fetch` 发 JSON。
- 直接查库（含软删行）时，根 `node_modules` 没有 `pg`，从 pnpm store 引入：
  `import pg from './node_modules/.pnpm/pg@<版本>/node_modules/pg/lib/index.js'`，连接串从 `.env` 读 `NETLIFY_DB_URL`，`ssl: { rejectUnauthorized: false }`。

### 3. 用 API 播种中间态，不依赖 confirm 自动化

- `browser_use` 处理 `window.confirm` 不稳定（对话框重试会误触发破坏性操作——曾一次误删整批测试评论）。
- 需要"软删占位"等中间态时：用 API 直接播种到目标状态（如 POST 顶层评论 + 回复，再 `DELETE /api/comments?id=<顶层>` 不带 cascade），浏览器只做 DOM 断言，最多保留最后一步点击。
- 播种后 PATCH 编辑前 `sleep` ≥1.5s，保证 `editedAt` 与 `createdAt` 有可区分的时间差（排序/日期切换断言依赖它）。

### 4. browser_use 调用要点

- 单次调用聚焦 4–6 个检查项；该工具每轮约 20–27 步预算，超预算轨迹会被截断，未测项需要下一轮续测（query 里注明"从第 N 项继续"）。
- query 中写清：URL、预期 DOM 特征（文案/类名）、逐项 PASS/FAIL 报告要求、控制台红色错误与 Network 4xx/5xx 检查（favicon 忽略）。
- 文本输入兜底：先 focus，再 `document.execCommand('insertText', false, '文本')`。
- 破坏性按钮（删除）在浏览器测试 query 中明确禁止误点，或只允许点已预置状态上的特定按钮。

### 5. 收尾清理（必做）

- mock 身份写入的数据 `user_id` 恒为 `'dev-mock'`（真实访客是 Netlify Identity UUID），清理 SQL：
  `DELETE FROM comments WHERE user_id='dev-mock'`
- 删除所有 `tmp-*.mjs` 临时脚本。
- 停掉访客实例（4174）；管理员实例（4173）可保留给用户自查。
- 浏览器侧硬刷新 Ctrl+Shift+R 验证新构建。

## 评论功能已验证的测试矩阵

- **管理员**：长评折叠（>600 字渐隐遮罩 + 展开/收起）、编辑/发布日期点击切换、排序（新↔旧 × 发布↔编辑，回复跟随）、文本+正则搜索（非法正则红色提示）、匹配范围（内容/用户名/邮箱）开关、回复（对回复点回复归顶层）、内联编辑、软删占位 + "删除全部回复"级联。
- **访客**：附件面板显示锁图标门禁卡片（不拉附件列表）、编辑器 `guest · verification required`、评论上无编辑/删除按钮、点回复触发登录弹窗、评论可读且搜索可用。
- **API**：附件下载/解锁令牌未登录 401；二级回复（parentId 指向回复）400；非本人非管理员 PATCH/DELETE 403；软删后顶层占位 `body` 为空、回复保留；cascade 仅管理员可用。
