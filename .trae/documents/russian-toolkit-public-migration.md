# 俄语工具箱公开化迁移 + 分享机制转移

## Context

当前俄语工具箱位于 `/admin/russian`（管理员专属）和 `/share/russian`（ru-share 多 IP 分享链接）两个入口。用户决定：

1. **将俄语工具箱迁移到网站主页**（公开访问），方便所有访客使用
2. **删除原 ru-share 系统**（`/admin/russian` + `/share/russian` + `/api/ru-share` 全部下线）
3. **将 ru-share 的多 IP 绑定机制移植到网络工具**（当前 net_share 为单设备独占，用户体验差），让"分享链接"功能由网络工具继承

核心动机：ru-share 的多 IP 链接机制（每链接允许 N 个不同 IP，同 IP 下设备数不限）比网络工具的"先到先得单设备独占"更适合分享场景；俄语工具箱本身是学习工具，无需门槛。

## 现状要点

### 待删除（俄语工具箱私有化痕迹）
- `src/router.tsx` L114-118 `adminRussianRoute`、L144-155 `shareRussianRoute`
- `src/routes/api.ru-share.ts` 整文件
- `src/components/russian-toolkit.tsx` L1227-1557 `RuShareButton` + `postRuShare` + `RU_SHARE_API`，L1560 `RussianToolkit({ shared })` 的 shared prop 与 cookie 自检
- `src/components/ui/card.tsx` L443 后台侧边栏 `<Link to="/admin/russian">`
- `db/index.ts` L3069-3318 全部 ru-share 函数；L458-475 ru-share DDL；L820 `ruShareEnabled: false`
- `db/schema.ts` L209 `ruShareEnabled`、L325-352 `ruShareLinks`/`ruShareBindings`
- `src/lib/i18n-messages.ts` 三语 `admin.nav.russian` + `admin.ru.share.*` 共 75 键

### 待升级（网络工具分享）
- 当前 `db/index.ts` L2919-3067 net-share 是**单设备独占**：`net_share_links.bound_hash` 一个字段，先打开者写入绑定哈希，之后只允许该 cookie 访问
- 当前 `api.net.ts` `handleClaimGet` 在 `taken` 时返回"链接已被占用"
- 当前 `network-tools.tsx` `SharePanel` 只显示 `bound: boolean`，无 IP 上限/已用数管理

## 实施步骤

### 步骤 1：db/schema.ts
- 删除 `ruShareLinks`、`ruShareBindings` 表定义
- 删除 `settings.ruShareEnabled` 字段
- 给 `netShareLinks` 新增 `maxIps: integer('max_ips').notNull().default(10)`
- 保留 `netShareLinks.boundHash` 字段（向后兼容旧数据；新逻辑不再使用，留作历史包袱不删 DB 列）
- 新增 `netShareBindings` 表（参考 ruShareBindings 结构）：
  ```typescript
  export const netShareBindings = pgTable('net_share_bindings', {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    linkId: text('link_id').notNull().references(() => netShareLinks.id, { onDelete: 'cascade' }),
    ipHash: text('ip_hash').notNull(),
    secretHash: text('secret_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  }, (table) => [index('net_share_bindings_link_idx').on(table.linkId)])
  ```

### 步骤 2：db/index.ts
- **L458-475 迁移 DDL 替换**：删除 ru-share DDL，改为：
  ```sql
  ALTER TABLE net_share_links ADD COLUMN IF NOT EXISTS max_ips INTEGER NOT NULL DEFAULT 10
  CREATE TABLE IF NOT EXISTS net_share_bindings (
    id BIGSERIAL PRIMARY KEY,
    link_id TEXT NOT NULL REFERENCES net_share_links(id) ON DELETE CASCADE,
    ip_hash TEXT NOT NULL, secret_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  CREATE INDEX IF NOT EXISTS net_share_bindings_link_idx ON net_share_bindings(link_id)
  ```
- **L820 删除** `ruShareEnabled: false`
- **L3069-3318 ru-share 函数块整体改写**：
  - 保留函数名骨架但语义改为操作 net_share：`getNetShareEnabled`、`listNetShareLinks`、`createNetShareLink(maxIps)`、`deleteNetShareLink`、`resetNetShareLink`、`setNetShareMaxIps`（新增）、`setNetShareEnabled`、`claimNetShareLink`、`verifyNetShareCookie`
  - 实现细节平移 ru-share 逻辑：`clientIpHash`、`normalizeClientIp`、`pruneStaleBindings`、同 IP 不占新槽位、60 天 stale 释放、`countDistinctIps`、bindings 校验 cookie
  - `NetShareLinkInfo` 增加 `ipCount: number`、`maxIps: number`，去掉 `bound: boolean`
  - `NetShareClaimResult` 用 `{ status: 'full'; used; max }` 替代 `{ status: 'taken' }`
  - `claimNetShareLink(token, cookieValue, clientIpRaw)` 增加 IP 参数
  - `verifyNetShareCookie(cookieValue, clientIpRaw)` 改为校验 bindings 而非 boundHash

### 步骤 3：删除 api.ru-share.ts
整文件删除。

### 步骤 4：api.net.ts
- `requireNetAccess` 改为传 `getClientIp(request)` 给 `verifyNetShareCookie`
- `handleClaimGet`：调用 `claimNetShareLink(token, cookie, ip)`；`taken` 分支改为 `full`，提示"该链接允许的 N 个同时访问名额已全部占用"
- `handleSharePost`：`share_create` 接受 `maxIps`；新增 `share_set_ips` 动作
- `shareHtmlPage` 文案微调

### 步骤 5：router.tsx
- 删除 `adminRussianRoute`（L114-118）和 `shareRussianRoute`（L144-155），从 `adminWithChildren` 数组中移除 `adminRussianRoute`
- 新增公开路由：
  ```typescript
  const russianRoute = createRoute({
    path: '/russian',
    getParentRoute: () => root,
    component: function RussianPage() {
      return (
        <React.Suspense fallback={<AdminLoading />}>
          <RussianToolkit />
        </React.Suspense>
      )
    },
  })
  ```
- 加入 `mergedChildren`：`...(hasPath('/russian') ? [] : [russianRoute])`
- `RussianToolkit` 导入从 admin 块移到公共 lazy 区（位置不变即可）

### 步骤 6：russian-toolkit.tsx
- 删除 L1227-1557 整个 `RU_SHARE_API`、`RuShareLinkInfo`、`postRuShare`、`copyText`、`showRuToast`、`shareOrCopy`、`RuShareButton`（注意：`copyText`/`showRuToast` 可能被其他面板使用，需先 grep 确认；若是共享工具则保留，否则删除）
- `RussianToolkit` 改为无 props：`export function RussianToolkit()`
- 删除 `shared` 相关：`checking`、`denied` state 与 useEffect 自检、`!shared && <RuShareButton />`、i18n key `admin.ru.share.page-sub` 引用
- 标题副标题固定用 `ru.page.sub`

### 步骤 7：network-tools.tsx
- `ShareLinkInfo` 接口改为 `{ id, createdAt, lastUsedAt, ipCount, maxIps }`
- `SharePanel` UI 参考 RuShareManager 风格（但保留 panel 内嵌形式，不改抽屉）：
  - 每行显示 `已用 IP: ipCount/maxIps`（满时变红）、最近使用
  - 新增 `IP 上限` 数字输入框（失焦提交 `share_set_ips`）
  - `重置绑定`按钮在 `ipCount > 0` 时显示
  - `新增链接` 旁加"上限"输入框
  - 移除 `bound/unbound` 文案，改用 `ipCount/maxIps`
- 新增 i18n 键：`admin.net.share.usage`、`admin.net.share.maxips`（zh/en/ru）；移除 `admin.net.share.bound`/`unbound`；`admin.net.share.desc` 改为多 IP 描述

### 步骤 8：card.tsx
删除 L443 `<Link to="/admin/russian">` 行及未再使用的 `BookA` 图标导入。

### 步骤 9：site-shell.tsx（公开站侧边栏入口）
- 在 L205 `/archive` 之后插入：
  ```tsx
  <Link to="/russian" className={`tree-item${activeRussian ? ' selected' : ''}`} onClick={() => setSidebarOpen(false)}><BookA size={15} /><span>{t('shell.russian.file')}</span></Link>
  ```
- 顶部导入 `BookA` 图标
- 计算 `activeRussian = path === '/russian' || pathname.startsWith('/russian')`（参照 L51 附近现有 activeX 模式）
- 新增 i18n 键 `shell.russian.file`：zh="俄语工具箱.r"、en="russian-toolkit.r"、ru="instrumenty.r"（或类似，遵循 `.r` 后缀伪装源码文件的站点语言风格——需先 grep 确认 `.file` 后缀惯例）

### 步骤 10：i18n-messages.ts
- 删除三语 `admin.nav.russian`（L591、1943、3294）
- 删除三语 `admin.ru.share.*` 全部键（约 L835-858、L2187-2210、L3538-3561）
- 修改三语 `admin.net.share.desc` 为多 IP 描述
- 新增三语 `admin.net.share.usage`、`admin.net.share.maxips`
- 删除三语 `admin.net.share.bound`、`admin.net.share.unbound`
- 新增三语 `shell.russian.file`

## 数据库兼容性

- `net_share_links.bound_hash` 列保留不删（DB 不动旧列），新代码不再读它
- `ru_share_links`/`ru_share_bindings` 表保留在 DB（DDL 用 `CREATE TABLE IF NOT EXISTS`，迁移脚本只增不删），但代码不再访问
- `settings.ru_share_enabled` 列保留在 DB，代码不再读

## 验证

1. `pnpm exec tsc --noEmit` 通过
2. `pnpm run deploy` 部署到 Cloudflare Workers
3. 浏览器验证：
   - 公开访问 `https://wow.xn--fpr224a.mom/russian` 无需登录即可见工具箱（每日一句、变格速查等）
   - 侧边栏显示"俄语工具箱"入口，可点击跳转
   - `/admin/russian` 与 `/share/russian` 返回 404
   - 后台 `/admin/network` 分享面板可创建带 IP 上限的链接，显示 `已用 IP: 0/10`
   - 用新链接在无痕窗口打开 → 种 cookie 跳转 `/share` 可见网络工具
   - 用另一 IP/代理打开同链接 → 仍可使用（IP 数 +1），第三个 IP 达到上限时显示"访问人数已满"
   - 管理员点击"重置绑定"→ 所有绑定释放，可重新打开

## 提交策略

完成后单条 git commit：「迁移俄语工具箱至公开页 /russian，多 IP 分享机制移植至网络工具」，排除 `deploy/botapi-gateway/layer`。
