# ThoracicTag4669

ThoracicTag4669 是一个类 VS Code 工作台风格的中文静态博客。首页以响应式瀑布流呈现 Markdown 文章，文章页支持 LaTeX 公式，并提供仅限完成邮箱验证用户使用的 Markdown / LaTeX 评论区。

## 技术栈

- TanStack Start、React 19 与 TanStack Router
- Tailwind CSS 4 与定制 CSS 视觉系统
- Content Collections 管理类型安全的 Markdown 文章
- KaTeX 与 Marked 渲染文章和评论
- Netlify Identity 提供注册、邮箱验证与登录
- Netlify Database、Drizzle ORM 与 Postgres 持久化评论

## 本地运行

1. 安装依赖：`pnpm install`
2. 启动 Netlify 开发环境：`netlify dev --port 8889`
3. 在浏览器中访问 Netlify CLI 输出的本地地址

邮箱验证依赖真实的 Netlify Identity 服务，完整验证流程应在 Deploy Preview 或生产部署中测试。数据库迁移位于 `netlify/database/migrations/`，由 Netlify 在部署时自动应用。

## 内容管理

在 `content/posts/` 中添加 Markdown 文件，并按现有文章填写标题、摘要、分类、slug 与日期。首页与侧栏会自动汇总分类，文章按日期排序并渐进加载。
