/**
 * /api/bot 的自描述清单：接口说明 + 站内 Markdown/LaTeX 语法速查。
 *
 * 维护约定：新增/修改 /api/bot 的 action 时同步改这里。外部 bot 只需要
 * `GET /api/bot` 或 `POST {"action":"help"}` 拉一次全文，缓存进自己的系统提示词，
 * 不必读仓库源码。
 */
export const BOT_API_VERSION = '2026-11-12'

export const BOT_SYNTAX_GUIDE = `# 站内 Markdown / LaTeX 渲染能力

## 公式（KaTeX）
- 行内：$E=mc^2$ 或 \\(E=mc^2\\)
- 块级：$$ \\int_0^1 x^2 dx $$ 或 \\[ ... \\]
- 多行：$$\\begin{aligned} a&=b+c \\\\ d&=e \\end{aligned}$$
- 常用环境：aligned、cases、pmatrix/bmatrix、array、\\tag{1}
- 化学（mhchem）：$\\ce{2H2 + O2 -> 2H2O}$，裸写 \\ce{...} / \\pu{...} 不套 $ 也能渲染
- 货币请写「$5 和 $10」：开头 $ 后紧跟空格或数字时不会当公式
- 列表项里写块级公式：与文字同缩进、公式前后不要多留空行，否则列表会断

## 站内扩展语法（Obsidian 风）
- 高亮：==重点==
- Callout：> [!tip] 标题（类型：note abstract info todo tip success important question warning failure danger bug example quote；别名 summary/check/caution/faq 等可用）
  - 折叠：> [!tip]- 默认收起，> [!tip]+ 默认展开
  - 尺寸：> [!tip|small] 或 |medium
- 对齐块：::: center / ::: right / ::: left 包裹内容
- 内部链接：[[文章slug]]、[[文章slug#标题]]、[[#本页标题]]、[[文章slug|别名]]
- 脚注：正文写 [^1]，文末写 [^1]: 说明
- 标签：#标签（渲染为徽章，不是链接）
- 任务列表：- [ ] 待办 / - [x] 已完成
- 表格：标准 GFM 表格（| 列 | 列 | + 分隔行）
- 代码块：三反引号 + 语言名；lang=mermaid 时输出 Mermaid 源码块
- 图片：![说明](https://...)；相对路径仅课程中心 /lessons 支持（图片放 src/assets/lessons/）
- 图片尺寸（消除布局抖动）：![说明|800x600](url) 或 ![说明](url "800x600")
- 月品木子取件链接：直接粘贴 https:// 取件页 URL，会渲染成取件卡片
- 引文标记（AI 检索报告）：列表行首 [cite:1]，正文 [cite:1 备注]，渲染为上标引用
- 置信徽章：[CONFIRMED] [MAJORITY] [SINGLE-SOURCE] [UNVERIFIED] [DISPUTED]
- 俄语重音：直接输入组合重音符号 U+0301（如 сло́во），无需额外标记
- 原始 HTML 会被转义；需要真正的整页 HTML 请用「彩蛋文章」（posts.egg.set）

## 文章字段
- slug：URL 路径，即 /posts/<slug>，全站唯一，建议小写英文/数字/连字符
- title / summary / content（Markdown 源）/ categories（中文权威名数组）
- date：YYYY-MM-DD；language：zh|en|ru；translationKey：同文多语言版本的共享键（通常取原文 slug）
- downloadable：是否给访客显示下载/导出入口
`

export const BOT_MANIFEST = {
  apiVersion: BOT_API_VERSION,
  endpoint: '/api/bot',
  method: 'POST',
  auth: 'Authorization: Bearer <BOT_TOKEN>（Worker secret）。GET /api/bot 无需令牌；所有 POST（含 help）都需要。',
  requestShape: '{ "action": "<名称>", ...参数 }',
  notes: [
    '服务端默认只开放：ping、help、posts.list/get/search、posts.create、comments.list、categories.list、feedback.list、settings.get。其余 action 返回 403，扩权需显式配置 BOT_ALLOWED_ACTIONS。',
    'ping 只回 ok、落库账号和开放动作数，不重复吐整份清单；清单走 GET /api/bot。',
    'posts.create / posts.update 永远写草稿；对外发布必须单独调 posts.publish。',
    '只管理数据库文章（后台发布的文章）。content/posts 下的静态 Markdown 属于仓库文件，接口不修改。',
    '所有写操作以 BOT_EMAIL 账号落库；该邮箱必须在 ADMIN_EMAILS 内。',
    '彩蛋 HTML 上限 512KB；附件单次 base64 上传上限 4MB（解码后）。',
    '覆盖范围：文章/评论/分类/彩蛋/附件/站点设置/关于与友链/用户资料与标签/警告/反馈。X 岛匿名版与网络分享不在此接口内。',
  ],
  actions: [
    { name: 'ping', params: {}, returns: '{ ok, bot, actions: 当前开放动作数 }', example: { action: 'ping' } },
    { name: 'help', params: {}, returns: '本清单（含语法速查）' },

    {
      name: 'comments.list',
      params: {
        postSlug: '可选，按文章过滤',
        status: 'published|deleted，可选',
        afterId: '可选，真增量：只返回 id > afterId 的评论，按 id 升序',
        limit: '1-100，默认 30',
      },
      returns: '{ ok, comments[{ id, postSlug, parentId, userName, body, status, createdAt }], nextAfterId }（不含邮箱/userId）',
    },
    {
      name: 'comments.reply',
      params: { id: '可选，回复某条评论', postSlug: '可选，新开顶层评论时必填', body: '2-4000 字', parentId: '可选' },
      returns: '{ ok, comment }',
      example: { action: 'comments.reply', id: 123, body: '谢谢反馈，已修复。' },
    },
    {
      name: 'comments.hide',
      params: { id: '评论 id（必填）', cascade: '可选，连带隐藏其下回复' },
      returns: '{ ok, id, postSlug }',
    },
    { name: 'comments.delete', params: { id: '同 comments.hide（软删）', cascade: '可选' }, returns: '{ ok, id, postSlug }' },

    {
      name: 'posts.list',
      params: {
        status: 'draft|published|all，默认 all',
        keyword: '可选，匹配 slug/标题/摘要/分类',
        offset: '可选，默认 0',
        limit: '1-200，默认 50',
      },
      returns: '{ ok, total, offset, posts[{ id, slug, title, summary, status, date, categories, language, commentCount }] }（不含正文）',
    },
    {
      name: 'posts.get',
      params: { id: '可选', slug: '可选（id 与 slug 二选一）' },
      returns: '{ ok, post: { ..., content, headings[{ level, text, line }] } }（line 为 Markdown 源行号，从 1 开始）',
    },
    {
      name: 'posts.search',
      params: {
        q: '必填，检索词（≤100 字）',
        limit: '可选，默认 20，最多 50',
      },
      returns: '{ ok, total, results[{ slug, title, status, date, matches[{ line, text }] }] }（每篇最多 3 处命中行）',
      example: { action: 'posts.search', q: 'VSEPR' },
    },
    {
      name: 'posts.create',
      params: {
        slug: '必填，全站唯一',
        title: '必填',
        content: '必填，Markdown 源',
        summary: '可选',
        categories: '可选，中文分类名数组',
        date: '可选，缺省为今天（Asia/Shanghai）',
        language: '可选 zh|en|ru，默认 zh',
        translationKey: '可选，多语言同文共享键',
        downloadable: '可选，默认 false',
      },
      returns: '{ ok, id, slug, status: "draft" }',
      example: { action: 'posts.create', slug: 'my-new-post', title: '标题', summary: '摘要', content: '# 正文', categories: ['随笔'] },
    },
    {
      name: 'posts.update',
      params: {
        id: '可选',
        slug: '可选；改路径时传新 slug',
        title: '可选',
        summary: '可选',
        content: '可选',
        categories: '可选',
        date: '可选',
        language: '可选',
        translationKey: '可选',
        downloadable: '可选',
      },
      returns: '{ ok, id, slug, status }（保留原发布状态）',
    },
    { name: 'posts.publish', params: { id: '可选', slug: '可选' }, returns: '{ ok, id, slug, status: "published" }' },
    { name: 'posts.unpublish', params: { id: '可选', slug: '可选' }, returns: '{ ok, id, slug, status: "draft" }' },
    { name: 'posts.delete', params: { id: '可选', slug: '可选' }, returns: '{ ok, id, slug }（连带附件与彩蛋）' },

    {
      name: 'posts.egg.get',
      params: { id: '可选', slug: '可选' },
      returns: '{ ok, egg: { postSlug, html, renderMd, enabled, updatedAt } | null }',
    },
    {
      name: 'posts.egg.set',
      params: {
        id: '可选',
        slug: '可选',
        html: '必填，彩蛋正文；renderMd=true 时是 Markdown 源，否则是整页 HTML',
        renderMd: '可选，默认 false',
        enabled: '可选，默认 true（false=待审/停用）',
      },
      returns: '{ ok, egg }',
      example: { action: 'posts.egg.set', slug: 'my-new-post', html: '<!doctype html>...', renderMd: false, enabled: true },
    },
    { name: 'posts.egg.delete', params: { id: '可选', slug: '可选' }, returns: '{ ok, slug }' },

    { name: 'attachments.list', params: { postSlug: '可选，按文章过滤；不传则列全部' }, returns: '{ ok, attachments[] }（含 locked/guestVisible/previewState）' },
    {
      name: 'attachments.upload',
      params: {
        postSlug: '必填',
        filename: '必填',
        mimeType: '可选',
        base64: '必填，文件内容的 base64（解码后 ≤4MB）',
        password: '可选，设置下载密码',
        guestVisible: '可选，默认 false（需登录才能看到）',
      },
      returns: '{ ok, attachment }',
    },
    {
      name: 'attachments.update',
      params: { id: '必填', password: '可选，传空串清除密码', guestVisible: '可选，true/false' },
      returns: '{ ok, id }',
    },
    { name: 'attachments.delete', params: { id: '必填' }, returns: '{ ok, id }' },

    { name: 'categories.list', params: {}, returns: '{ ok, categories: [{ id, name, nameEn, nameRu, dbCount, staticCount, builtin }] }' },
    {
      name: 'categories.upsert',
      params: {
        id: '可选，编辑既有分类时传',
        name: '必填，中文权威名（分类页与文章分类数组的键）',
        nameEn: '可选，英文译名',
        nameRu: '可选，俄文译名',
      },
      returns: '{ ok, category: { id, name } }',
    },
    { name: 'categories.delete', params: { id: '必填' }, returns: '{ ok, id }' },

    { name: 'settings.get', params: {}, returns: '{ ok, settings: { siteTitle, siteDescription, customCss, adminEmails(脱敏), bannedWords } }' },
    {
      name: 'settings.update',
      params: {
        siteTitle: '可选，≤120 字',
        siteDescription: '可选，≤500 字',
        customCss: '可选，≤100KB',
        adminEmails: '可选，逗号/换行分隔；注意别把 bot 自己移除，否则后续写操作会被拒绝',
        bannedWords: '可选，逗号/换行分隔，≤5000 字',
      },
      returns: '{ ok, settings }（只传要改的字段，其余保持不变）',
    },
    { name: 'siteContent.list', params: {}, returns: '{ ok, contents: [{ key, lang, body, updatedAt }] }' },
    {
      name: 'siteContent.save',
      params: { key: 'about|links', lang: 'zh|en|ru', body: 'Markdown 源，≤20000 字' },
      returns: '{ ok, content: { key, lang, body } }',
      example: { action: 'siteContent.save', key: 'about', lang: 'zh', body: '# 关于本站\n...' },
    },
    {
      name: 'users.list',
      params: { keyword: '可选，按 userId / 邮箱 / 昵称过滤' },
      returns: '{ ok, users: [{ userId, email, displayName, signature, tags, commentCount, warningCount, createdAt }] }',
    },
    { name: 'users.setSignature', params: { userId: '必填', signature: '必填，Markdown，空串=清空' }, returns: '{ ok, signature, updatedBy }' },
    { name: 'users.setTags', params: { userId: '必填', tagIds: '必填，覆盖式；[] 清空' }, returns: '{ ok, tags }' },
    { name: 'users.warn', params: { userId: '必填', message: '2–500 字' }, returns: '{ ok, id }' },
    { name: 'userTags.list', params: {}, returns: '{ ok, tags: [{ id, name, color, effect }] }' },
    {
      name: 'userTags.create',
      params: { name: '必填，≤20 字', color: '可选，#hex', effect: '可选 solid|glow|gradient|outline' },
      returns: '{ ok, tag }',
    },
    { name: 'userTags.update', params: { id: '必填', name: '可选', color: '可选', effect: '可选' }, returns: '{ ok, tag }' },
    { name: 'userTags.delete', params: { id: '必填' }, returns: '{ ok, id }（连带清理用户资料中的引用）' },
    { name: 'feedback.list', params: { status: 'open|resolved|dismissed|all，默认 open' }, returns: '{ ok, status, feedback[](含附件元数据) }' },
    { name: 'feedback.setStatus', params: { id: '必填', status: 'open|resolved|dismissed' }, returns: '{ ok, id, status }' },
  ],
  syntax: BOT_SYNTAX_GUIDE,
} as const
