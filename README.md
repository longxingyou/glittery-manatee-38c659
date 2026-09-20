# ThoracicTag4669

ThoracicTag4669 是一个类 VS Code 工作台风格的中文静态博客。首页以响应式瀑布流呈现 Markdown 文章，文章页支持 LaTeX 公式，并提供仅限完成邮箱验证用户使用的 Markdown / LaTeX 评论区。

## 技术栈

- TanStack Start、React 19 与 TanStack Router
- Tailwind CSS 4 与定制 CSS 视觉系统
- Content Collections 管理类型安全的 Markdown 文章
- KaTeX 与 Marked 渲染文章和评论
- Cloudflare Workers 部署（worker.ts 入口 + 安全响应头）
- 自建账户体系：PBKDF2 密码哈希 + HMAC JWT（httpOnly cookie）+ Resend 验证/找回邮件
- Neon Postgres（@neondatabase/serverless）、Drizzle ORM 持久化评论

## 本地运行

1. 安装依赖：`pnpm install`
2. 复制 `.dev.vars.example` 为 `.dev.vars`，填入 `DATABASE_URL`（Neon 连接串）、可选 `RESEND_API_KEY` / `RESEND_FROM` / `ADMIN_EMAILS`
3. 启动开发服务器：`pnpm dev`，浏览器访问 http://localhost:3000

未配置 `RESEND_API_KEY` 时注册账户会自动激活（仅建议本地开发）。数据表在首次访问时通过幂等 SQL 自动创建；管理员邮箱通过 secret `ADMIN_EMAILS` 配置。

## 部署

`pnpm run deploy`（先 `vite build` 再 `wrangler deploy`）。部署前通过 `wrangler secret put DATABASE_URL`、`wrangler secret put RESEND_API_KEY`、`wrangler secret put ADMIN_EMAILS` 配置密钥。

## 内容管理

在 `content/posts/` 中添加 Markdown 文件，并按现有文章填写标题、摘要、分类、slug 与日期。首页与侧栏会自动汇总分类，文章按日期排序并渐进加载。
