---
name: "dual-identity-regression"
description: "Dual-perspective (admin JWT + guest) browser regression for this blog's login-gated features. Invoke when E2E-verifying comments, attachments, admin pages, or moderation flows before deployment."
---

# 双身份浏览器回归（管理员 / 访客）

Syntax Garden（TanStack Start + Cloudflare Workers）登录门禁类功能的端到端回归流程：评论、附件、admin 后台、X 岛树洞等。目标是同时回答两个问题——**管理员能做什么**、**访客被挡在哪里**。

> 2026-10 重写：站点已从 Netlify 迁到 Cloudflare Workers，鉴权是自建 JWT（PBKDF2 + HS256 存 httpOnly `sg_auth` cookie）。旧的 `DEV_MOCK_ADMIN_EMAIL` / Netlify Identity mock 流程已全部失效，勿再用。

## 触发时机

- 上线前验证评论 / 附件 / admin 后台 / X 岛树洞等门禁类改动
- 需要确认同一界面在"已登录管理员 / 未登录访客"两种身份下的差异
- API 逻辑已写完，需要浏览器层确认渲染、交互与门禁引导

## 标准流程

### 1. typecheck + 自签管理员 JWT

```powershell
pnpm exec tsc --noEmit
node .trae/skills/dual-identity-regression/scripts/mint-admin-jwt.mjs
```

mint 脚本读 `.dev.vars` 的 `DATABASE_URL` / `ADMIN_EMAILS`，直查 Neon（`users` 已确认行 + `settings.token_secret`），用 WebCrypto HMAC-SHA256 签出与 `/api/auth` 登录产物等价的 JWT，写到 `%TEMP%\sg-e2e\auth.json`（可用参数改输出目录）。

- `@neondatabase/serverless` 必须用 `neon()` 工厂创建查询函数（不是 `new`）；表名等标识符插值用 `sql.query(\`SELECT * FROM ${t}\`)`，模板标签不支持标识符插值。

### 2. 启动本地 dev server

```powershell
pnpm dev   # vite dev --port 3000，约 6s 就绪（日志出现 "VITE v7 ready"）
```

- dev 模式 HMR 自动生效，改代码后**不需要**重启（旧的 `vite preview 缓存 SSR bundle 必须重启`经验只适用于 preview）。
- 就绪判定用 `Invoke-WebRequest http://localhost:3000/ -UseBasicParsing` 看 200。

### 3. Playwright 双身份

在临时目录（如 `%TEMP%\sg-e2e`）`npm i playwright-core@1.58.0`，复用系统已装的 Chromium：

```js
import { chromium } from 'playwright-core'
const EXE = 'C:\\Users\\66386\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe'
// 版本号会随 playwright 更新变化，用 Glob 搜 %LOCALAPPDATA%/ms-playwright/chromium-*/chrome-win64/chrome.exe
const browser = await chromium.launch({ executablePath: EXE, headless: true })
```

- **管理员**：`ctx.addCookies([{ name: 'sg_auth', value: auth.token, domain: 'localhost', path: '/', httpOnly: true }])`，无需走登录 UI。
- **访客**：不带 cookie 的干净 context。门禁页面应被 AdminGate 拦截，API 应 401。
- 同一脚本可跑多视口（桌面 1280 / 移动 390）——X 岛树洞等移动端体验是重点回归面。

### 4. 先 API 层、后 UI 层

- 写操作与权限逻辑先用 HTTP 请求验证（快、稳、可精确断言），浏览器只验证渲染与交互。
- **中文请求体禁止用 PowerShell `Invoke-RestMethod`**：UTF-8 会被按 Latin-1 编码导致乱码。
- **PowerShell `Invoke-WebRequest -Headers @{Cookie=...}` 会吞掉自定义 Cookie header**（报"需要管理员登录"假象）。API 验证用 Node `fetch` 临时脚本或 Playwright cookie 注入。

### 5. 浏览器测试要点

- **SPA 内 `page.goBack()` 无效**（URL 不变），必须点应用内返回按钮。
- 选择器优先用语义 class；注意同一容器里 ghost 文本按钮常在 icon 按钮之前（如 `.x-actions` 里 `.x-actbtn` 第一个是"打开"，收藏/订阅是 `.x-icon-btn.x-actbtn`）。
- `window.confirm` 在自动化里不稳定：中间态用 API 播种，浏览器只做 DOM 断言。
- 控制台红色错误与 Network 4xx/5xx 都要收集（favicon 忽略）。

### 6. 收尾清理（必做）

- 停掉 dev server 后台 job（StopCommand）。
- 删除临时目录 `%TEMP%\sg-e2e`（含 auth.json，内有有效 JWT）。
- 确认仓库根没有遗留 `tmp-*.mjs`。

## 线上验证

本地直连 Cloudflare 生产域名（`wow.xn--fpr224a.mom`）常超时（GFW 节流边缘 IP）。线上验证走 Azure SSH SOCKS5 隧道，见 `azure-socks-site-check` skill。

## 已验证的测试矩阵（历史）

- **评论**：管理员长评折叠、排序/搜索/内联编辑/软删级联；访客锁图标门禁、登录弹窗引导。
- **附件**：未登录 401、解锁令牌流程。
- **X 岛树洞**：版面/时间线/串浏览、引用预览弹层、收藏订阅增删（tracked 接口返回完整对象）、沉浸模式（连外层 admin 侧栏/顶栏一并隐藏）、分页跳页、DawnIslandK 风格版块 chip、饼干绑定徽章。
