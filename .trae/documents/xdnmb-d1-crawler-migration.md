# X岛索引迁移 D1 + 爬虫抽离独立 Worker + GitHub Actions 深度爬取

## Context

**问题**：当前 X岛本地搜索索引存 Neon Postgres，每 5 分钟主站 Worker cron 同时跑 `warmupDb + autoRequeuePreviewFailed + checkXdnmbSubs + crawlXdnmbIndex`，导致：

1. Neon 5 分钟保活一次 → 720 小时/月持续运行，远超免费 191.9 计算小时/月上限
2. 单次 cron 子请求数 ~100-130（41 X岛 + ~60 Neon + 5 订阅 fetch），可能突破 CF Workers 免费 50 子请求/调用上限
3. 爬虫只爬 timeline → 长串中段楼层无索引、不在 timeline 上的存量串完全遗漏（用户已实证：69607298→69607195 需手动 deep-seed 补全）
4. 无删帖检测机制 → 已被版主删除的帖子仍出现在搜索结果里
5. 爬虫在主站 Worker 里跑 → 直接占用主站请求/CPU 预算，与文章/评论请求争资源

**目标**：
- D1 承载搜索索引（5GB / 5M 行读 / 10 万行写 / 天，无计算小时概念）
- 爬虫搬到独立 CF Worker（5 分钟 cron，与主站同账号但独立 Worker 脚本不抢请求配额，D1 binding 不计 50-subrequest 上限）
- GitHub Actions 私有仓库（Student Pack 3000 分钟/月）跑每日 catalog 全扫 + 每周长串深度爬
- 删帖检测：定期回扫串，diff 楼层 ID 集合，缺失的标记 `deleted_at`
- 主站 cron 瘦身：移除 `crawlXdnmbIndex` 与 `checkXdnmbSubs`（用户已确认不需要 TG 推送），仅保留 `warmupDb + autoRequeuePreviewFailed`

## 架构总览

```
┌─ 主站 Worker (wow.xn--fpr224a.mom) ────────────┐
│  fetch: 文章/评论/俄语工具箱/X岛浏览/搜索         │
│  cron 5min: warmupDb + autoRequeuePreviewFailed │
│  D1 binding XDNMB_DB (只读: search/stats)       │
│  Neon (文章/评论/用户/订阅表，xdnmb_index_* 弃用)│
└──────────────────┬──────────────────────────────┘
                   │ 共享同一 D1
┌──────────────────┴──────────────────────────────┐
│ 独立爬虫 Worker (xdnmb-crawler, 同账号, 免费)    │
│  cron 5min: timeline 增量 + recrawl diff         │
│  cron 6h : forum catalog 翻页枚举                 │
│  D1 binding XDNMB_DB (读写)                     │
│  Azure 网关 (复用 TG_GATEWAY_URL/SECRET)        │
└──────────────────┬──────────────────────────────┘
                   │ D1 REST API (CLOUDFLARE_API_TOKEN)
┌──────────────────┴──────────────────────────────┐
│ GitHub Actions (私有 repo, Student Pack 3000min) │
│  workflow nightly: catalog 全版面补充扫描         │
│  workflow weekly : 长串深度爬中段楼层            │
└───────────────────────────────────────────────────┘
```

## Step 1: D1 schema + 主站读 API 迁移

### 1.1 新建 `db/d1-schema.sql`（幂等 DDL）

三张原表（threads/posts/cursors）+ 新增 `xdnmb_index_recrawl_queue` + FTS5 虚表与同步触发器。

关键点：
- `BIGINT` → `INTEGER`（X岛 ID 都 < 2^53，JS 安全）
- `TIMESTAMPTZ DEFAULT NOW()` → `INTEGER DEFAULT (unixepoch())`
- pg_trgm GIN → FTS5 `unicode61` tokenizer（中文按字分词，子串搜索走倒排，比 ILIKE 快且不占 subrequest）
- 新增列 `deleted_at INTEGER`（软删）和 `crawled_at INTEGER`（回扫调度依据）
- FTS5 触发器（INSERT/UPDATE/DELETE 各一，threads 和 posts 两套共 6 个 trigger）保证索引实时同步

### 1.2 新建 `db/d1.ts` — D1 原生查询层

放弃 Drizzle D1 driver（schema 太小、FTS5 触发器不在 Drizzle 表达范围内）。所有查询用 `env.XDNMB_DB.prepare(sql).bind(...)` 原生 SQL。

导出函数（签名与 `db/index.ts` 同名，便于 shim 替换）：
- `searchXdnmbIndexD1(db, q, limit=50)` — FTS5 MATCH 查 threads_fts + posts_fts，按 thread_id 去重，过滤 `deleted_at IS NULL`
- `findXdnmbThreadByPostIdD1(db, postId)` — `WHERE id=? AND deleted_at IS NULL` 反查 thread_id
- `getXdnmbIndexStatsD1(db)` — 三 count（threads / posts / recrawl 待办）+ 已删帖计数
- `getXdnmbIndexThreadD1(db, id)` — 单串查询
- 爬虫用 upsert 系列：`upsertXdnmbIndexThreadD1` / `upsertXdnmbIndexPostsD1` / `upsertXdnmbIndexCursorD1` / `listXdnmbIndexCursorsD1`（用 SQLite `INSERT ... ON CONFLICT(...) DO UPDATE`）
- 新增：`upsertRecrawlD1(db, tid, dueAt)` / `claimRecrawlD1(db, now, limit)` / `markRecrawlDoneD1(db, tid)` / `markPostsDeletedD1(db, ids)` / `settingsGetUserhashD1(db)` / `settingsSetUserhashD1(db, uh)`

### 1.3 主站改造

- `wrangler.jsonc`：在 `kv_namespaces` 同级加 `d1_databases: [{ "binding": "XDNMB_DB", "database_name": "xdnmb-index", "database_id": "<创建后填入>" }]`
- `src/lib/server-env.ts`：`ServerEnv` 接口加 `XDNMB_DB?: D1Database`（用 `import type { D1Database } from '@cloudflare/workers-types'`）
- `db/index.ts`：在 `searchXdnmbIndex` / `findXdnmbThreadByPostId` / `getXdnmbIndexStats` / `getXdnmbIndexThread` 顶部加 shim：
  ```ts
  const d1 = (getEnv() as { XDNMB_DB?: D1Database }).XDNMB_DB
  if (d1) return d1SearchXdnmbIndex(d1, q, limit)
  // 原 Neon 路径保留作为回滚兜底
  ```
- `api.xdnmb.ts`：零改动（仍调 `dbApi.searchXdnmbIndex` 等，shim 内部自动路由）

### 1.4 一次性数据迁移脚本 `scripts/migrate-xdnmb-to-d1.mjs`

Node 脚本（不入 Worker bundle）：
- 用 `@neondatabase/serverless` 直连 Neon（读 `DATABASE_URL`，非 pooled）
- 流式分批 `SELECT * FROM xdnmb_index_threads/posts/cursors`（每批 500 行）
- 调 Cloudflare D1 REST API 批量 INSERT：`POST https://api.cloudflare.com/client/v4/accounts/{aid}/d1/database/{did}/query`，每批 500 个 `?` 占位 bind
- 结尾跑 COUNT(*) 对账，打印 Neon count vs D1 count
- `package.json` 加 `"migrate-xdnmb-to-d1": "node scripts/migrate-xdnmb-to-d1.mjs"`
- 环境变量：`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` + `D1_DATABASE_ID` + `DATABASE_URL`（从 .env 读取，不写入文件）

## Step 2: 爬虫 Worker 抽离

### 2.1 共享 X岛 fetcher 提取

新建 `src/lib/xdnmb-api.ts`：
- `export interface XdGateway { url: string; dlUrl: string; secret: string }`
- `export async function xFetchRaw(path: string, userhash: string, gw: XdGateway | null): Promise<Response>` — 从 [xdnmb-server.ts#L29-L61](file:///c:\Projects\my-website\glittery-manatee-38c659\src\lib\xdnmb-server.ts#L29-L61) 搬来，把 `gatewayConfig()` 调用替换为参数 `gw`，`signGwToken` 也接受 `gw` 作为第三参数（或内联 HMAC）
- `export async function xFetch<T>(path, userhash, gw)` — 解析+错误处理逻辑搬过来
- `export async function getThread(id, page, userhash, gw)` / `showForum` / `showTimeline` / `getTimelineList` / `getRef` — 纯 fetcher，**不做 HTML 净化**（爬虫只需要纯文本搜索内容）
- `export { toPlain } from './xdnmb-crawler.js'` — 复用现有 HTML→纯文本函数

修改 `src/lib/xdnmb-server.ts`：
- 删除本地 `xFetchRaw` / `xFetch` 定义，改为 `export { xFetchRaw, xFetch, getThread, showForum, showTimeline, getTimelineList, getRef } from './xdnmb-api.js'`
- 保留 `purifyXHtml` / `xSubmitPost` / `xImgUpstream`（主站专用）
- 内部其他调用点（如 `getForums`）改为 `xFetch(..., gw ?? gatewayConfig())` 形式，主站保留旧行为

### 2.2 新建 `crawler/` 目录（独立 Worker 项目）

```
crawler/
  wrangler.jsonc
  src/
    worker.ts        # scheduled 路由 + fetch handler (健康检查)
    timeline.ts      # crawlXdnmbIndex（从主站 xdnmb-crawler.ts 搬来，db 调用改 D1）
    recrawl.ts       # 删除 diff 回扫
    settings.ts      # 从 D1 settings 表读 userhash
    catalog.ts       # 留空 stub，GitHub Actions 走 catalog 时也用此模块（共享代码）
  tsconfig.json      # extends 主项目 tsconfig
```

`crawler/wrangler.jsonc`：
```jsonc
{
  "name": "xdnmb-crawler",
  "main": "./src/worker.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "triggers": { "crons": ["*/5 * * * *", "0 */6 * * *"] },  // 5min timeline, 6h catalog
  "d1_databases": [{ "binding": "XDNMB_DB", "database_name": "xdnmb-index", "database_id": "<同主站>" }],
  "vars": { "PUBLIC_ORIGIN": "https://wow.xn--fpr224a.mom" }
  // secrets: TG_GATEWAY_URL, TG_GATEWAY_SECRET, TG_GATEWAY_DL_URL (Azure 网关签名用)
}
```

`crawler/src/worker.ts` 调度逻辑：
```ts
async scheduled(event, env, ctx) {
  const cron = (event.cron || '')  // '*/5 * * * *' or '0 */6 * * *'
  ctx.waitUntil((async () => {
    if (cron === '0 */6 * * *') {
      await runCatalogCycle(env)
    } else {
      // 5 分钟：timeline + recrawl（共享 50-subrequest 预算）
      await runTimelineCycle(env)    // ~30 subrequest (10 threads × 2 fetch + 1 timeline + 1 forum list)
      await runRecrawlCycle(env, 5)  // 剩余预算做 5 个串回扫 diff
    }
  })())
}
```

预算控制：
- 5 分钟 cron：1 timeline + 1 forums list + 10 threads × 2 fetch = 22 subrequest；recrawl 5 × 2 fetch = 10；总 32 subrequest，安全 < 50
- 6 小时 cron：遍历每个 forum 翻页（每页 1 subrequest），最多 ~25 版面 × 10 页 = 250 subrequest，超 50 上限 → 必须拆批，每轮只跑 5 个版面 × 10 页 = 50 subrequest，下次 cron 继续

`crawler/src/settings.ts`：
- `getUserhash(env): Promise<string>` — `env.XDNMB_DB.prepare('SELECT xdnmb_userhash FROM settings WHERE id=1').first()` 返回 userhash
- 管理员改 userhash 时：主站 `api.xdnmb.ts` 的 `setcookie` 动作改成写 D1 settings 表（不再写 Neon settings）。同时为了回滚兼容，可双写 D1 + Neon

### 2.3 主站 cron 瘦身

`worker.ts` [L467-L488](file:///c:\Projects\my-website\glittery-manatee-38c659\worker.ts#L467-L488) 的 scheduled handler 改为：
```ts
async scheduled(event, env, ctx) {
  setWorkerEnv(env)
  const minute = ...
  const refreshCache = minute % 20 === 0
  ctx.waitUntil(import('./db/index.js').then(async (m) => {
    await m.warmupDb(refreshCache)
    try { await m.autoRequeuePreviewFailed() } catch {}
    // 删除 checkXdnmbSubs（用户已确认不需要 TG 推送）
    // 删除 crawlXdnmbIndex（搬到 crawler Worker）
  }))
}
```

`src/lib/xdnmb-cron.ts` 文件保留但标记 `@deprecated`，不再被任何路径引用。`xdnmb-crawler.ts` 同样保留作为历史参考，主站不再 import。

## Step 3: Catalog 全枚举 + 删帖 diff

### 3.1 Catalog 全版面枚举（6 小时 cron in crawler）

X岛无 catalog.json，用 `showf?id=<fid>&page=<n>` 翻页直到空页。算法：
```
async function runCatalogCycle(env):
  const db = env.XDNMB_DB
  const uh = await getUserhash(env)
  const gw = makeGwFromEnv(env)
  const forums = await getForums(uh, gw)              // 1 fetch
  const fids = flattenForumIds(forums)               // ~25 版面
  const cursor = await getCatalogCursor(db)          // 记录已扫到哪个 forum+page
  let budget = 45  // 留 5 个 subrequest 余量
  while budget > 0 and cursor.idx < fids.length:
    const fid = fids[cursor.idx]
    const posts = await showForum(fid, cursor.page, uh, gw)  // 1 fetch
    if posts.length === 0:
      cursor.idx++; cursor.page = 1; continue
    for p in posts:
      // 只入队：检查索引中是否已有且 reply_count 落后
      const existing = await getXdnmbIndexThreadD1(db, p.id)
      if !existing or existing.replyCount < p.ReplyCount:
        await enqueueCrawl(p.id, dueAt=0)  // 立即待爬
    cursor.page++
    budget--
  await saveCatalogCursor(db, cursor)
```

### 3.2 删帖 diff（5 分钟 cron 内剩余预算）

```
async function runRecrawlCycle(env, limit=5):
  const db = env.XDNMB_DB
  const uh = await getUserhash(env)
  const gw = makeGwFromEnv(env)
  const now = unixepoch()
  const claim = await claimRecrawlD1(db, now, limit)  // SELECT ... WHERE due_at<=now AND status='pending' LIMIT ?
  for row in claim:
    try:
      const page1 = await getThread(row.thread_id, 1, uh, gw)        // 1 fetch
      const lastPage = await getThread(row.thread_id, 999, uh, gw)   // 1 fetch
      const liveIds = new Set([page1.id, ...page1.Replies.map(r=>r.id), ...lastPage.Replies.map(r=>r.id)])
      const stored = await getStoredPostIdsD1(db, row.thread_id)    // SELECT id WHERE thread_id=? AND deleted_at IS NULL
      const missing = stored.filter(id => !liveIds.has(id))
      if missing.length:
        await markPostsDeletedD1(db, missing)  // UPDATE ... SET deleted_at=now WHERE id IN (...)
      // 新增楼层（liveIds 中 stored 没有的）由下次该串被 timeline 命中时补全，或 deep crawl 处理
      await markRecrawlDoneD1(db, row.thread_id, now + 7*86400)  // 7 天后再扫
    except:
      await markRecrawlRetryD1(db, row.thread_id, now + 3600)  // 1 小时后重试
```

入队时机：
- `crawlThread` 成功后：`upsertRecrawlD1(tid, dueAt = now + 7*86400)` — 7 天后回扫
- catalog 发现新串时：`upsertRecrawlD1(tid, dueAt = 0)` — 立即待爬

### 3.3 GitHub Actions 工作流

`.github/workflows/xdnmb-catalog-full.yml`（nightly 03:00 Asia/Shanghai）：
- 触发：`cron: '0 19 * * *'`（UTC 19:00 = Asia/Shanghai 03:00）
- 步骤：checkout → setup-node 20 → pnpm install → `node scripts/xdnmb-catalog-full.mjs`
- 脚本职责：遍历所有 forum 全部页（不受 50-subrequest 限制），与 crawler 的 6 小时增量扫互补
- D1 写入：走 REST API（`CLOUDFLARE_API_TOKEN` secret），按 thread 入队（不直接爬）
- 预算：~25 版面 × 平均 20 页 × 200ms = 100 秒，远低于 6 小时上限

`.github/workflows/xdnmb-deep-crawl.yml`（weekly Sunday 04:00 Asia/Shanghai）：
- 触发：`cron: '0 20 * * 0'`（UTC 20:00 周日 = Asia/Shanghai 周一 04:00）
- 步骤：同上 + 跑 `node scripts/xdnmb-deep-crawl.mjs`
- 脚本职责：从 D1 读 `reply_count > 200` 的串，逐页爬中段楼层（每串可能 10+ 页），写入 posts 表
- 预算：假设 200 长串 × 20 页 × 300ms = 1200 秒 = 20 分钟/周 → 80 分钟/月，远低于 Student Pack 3000 分钟/月

两个脚本放 `scripts/` 目录，复用 `src/lib/xdnmb-api.ts` 的 fetcher（通过 ts-node 或编译为 mjs）。

仓库结构选项（实施时确认）：
- Option A：在主站 repo 加 `.github/workflows/` + `scripts/`，repo 设为 private（Student Pack 3000 min/月）
- Option B：新建独立 private repo `xdnmb-actions`，只放 workflows + scripts

推荐 Option A（共享代码 + 类型定义，单仓库维护）。

## 回滚

主站 `db/index.ts` 的 shim 是双向：`if (env.XDNMB_DB)` 走 D1，否则走 Neon。回滚步骤：
1. `wrangler.jsonc` 注释 `d1_databases` binding
2. `pnpm run deploy` 重部署
3. 主站立即回退到 Neon 路径（Neon 中 `xdnmb_index_*` 表保留未删，可继续 cron 写入）
4. crawler Worker：`cd crawler && npx wrangler delete` 即停
5. GitHub Actions：repo Settings → Actions → Disable workflows

## 验证

1. **本地 D1 schema**：
   ```powershell
   npx wrangler d1 create xdnmb-index --local
   npx wrangler d1 execute xdnmb-index --local --file=db/d1-schema.sql
   npx wrangler d1 execute xdnmb-index --local --command "SELECT name FROM sqlite_master WHERE type='table'"
   ```
   应见 7 张表：3 主表 + 2 FTS5 + recrawl_queue + settings

2. **数据迁移对账**：
   ```powershell
   $env:CLOUDFLARE_API_TOKEN='...'
   $env:DATABASE_URL='<从 .dev.vars 复制>'
   pnpm run migrate-xdnmb-to-d1
   ```
   末尾打印 `Neon: threads=N1 posts=N2 cursors=N3` vs `D1: threads=N1' posts=N2' cursors=N3'`，三者应一致

3. **爬虫本地 cron**：
   ```powershell
   cd crawler
   npx wrangler d1 execute xdnmb-index --local --file=../db/d1-schema.sql
   $env:XDNMB_USERHASH='<测试 userhash>'
   npx wrangler dev --test-scheduled
   # 在另一个终端触发 cron：
   echo "" | npx wrangler triggers cron
   ```
   日志应见：`timeline tick: timeline_id=..., threads=10, posts=190`

4. **主站搜索走 D1**：
   ```powershell
   # 在主站 wrangler.jsonc 加 D1 binding 后
   pnpm dev
   # 浏览器登录管理员，访问 /admin/xdnmb 搜索任意关键词
   # Network 中 /api/xdnmb?action=index_search&q=... 应返回 200，响应时间 < 100ms（D1 边缘读）
   ```

5. **生产灰度**：
   - Day 1：部署 crawler Worker（含 D1 schema + 数据迁移），主站保持 Neon 路径
   - Day 1-3：观察 crawler 写入 D1，`wrangler d1 execute xdnmb-index --command "SELECT COUNT(*) FROM xdnmb_index_threads"` 应持续增长
   - Day 4：主站加 D1 binding 部署，监控 `/api/xdnmb?action=index_search` 与 `index_stats` 5 分钟
   - 异常处理：注释 binding → 重部署 → 立即回退 Neon
   - 正常：保留部署，主站 cron 仍跑 warmupDb（防 Neon 休眠影响文章/评论，但不影响 X岛索引）

## 文件清单

**新建：**
- `db/d1-schema.sql` — D1 DDL + FTS5 + triggers
- `db/d1.ts` — D1 原生查询层（~15 函数）
- `src/lib/xdnmb-api.ts` — 共享 X岛 fetcher（xFetchRaw/xFetch/getThread/showForum/showTimeline/getTimelineList/getRef 接受 gw 参数）
- `crawler/wrangler.jsonc` + `crawler/src/{worker,timeline,catalog,recrawl,settings}.ts` + `crawler/tsconfig.json`
- `scripts/migrate-xdnmb-to-d1.mjs` — 一次性数据迁移
- `scripts/xdnmb-catalog-full.mjs` — GitHub Actions nightly
- `scripts/xdnmb-deep-crawl.mjs` — GitHub Actions weekly
- `.github/workflows/xdnmb-catalog-full.yml`
- `.github/workflows/xdnmb-deep-crawl.yml`

**修改：**
- `wrangler.jsonc` — 加 `d1_databases` binding
- `src/lib/server-env.ts` — `ServerEnv` 加 `XDNMB_DB?: D1Database`
- `src/lib/xdnmb-server.ts` — `xFetchRaw` 等委托给 `xdnmb-api.ts`，保留 `purifyXHtml`/`xSubmitPost`/`xImgUpstream`
- `src/lib/xdnmb-crawler.ts` — 标记 `@deprecated`（保留作为 crawler Worker 的逻辑参考源）
- `src/lib/xdnmb-cron.ts` — 标记 `@deprecated`（用户已确认不需要 TG 推送）
- `db/index.ts` — `searchXdnmbIndex`/`findXdnmbThreadByPostId`/`getXdnmbIndexStats`/`getXdnmbIndexThread` 加 D1 shim；保留 Neon 路径作为回滚兜底；userhash 读写改走 D1
- `worker.ts` — scheduled handler 删除 `checkXdnmbSubs` 与 `crawlXdnmbIndex` 调用
- `package.json` — 加 `migrate-xdnmb-to-d1` 脚本
- `api.xdnmb.ts` — `setcookie` 动作改写 D1 settings（双写 Neon 兼容回滚）

## 关键代码路径参考

- [db/schema.ts L259-L311](file:///c:\Projects\my-website\glittery-manatee-38c659\db\schema.ts#L259-L311) — 现有 Drizzle 表定义
- [db/index.ts L399-L438](file:///c:\Projects\my-website\glittery-manatee-38c659\db\index.ts#L399-L438) — 现有 Neon DDL（pg_trgm）
- [db/index.ts L3731-L4019](file:///c:\Projects\my-website\glittery-manatee-38c659\db\index.ts#L3731-L4019) — 现有 upsert/search/cursor 函数签名
- [src/lib/xdnmb-server.ts L17-L145](file:///c:\Projects\my-website\glittery-manatee-38c659\src\lib\xdnmb-server.ts#L17-L145) — X岛 API 客户端（要抽取到 xdnmb-api.ts）
- [src/lib/xdnmb-crawler.ts](file:///c:\Projects\my-website\glittery-manatee-38c659\src\lib\xdnmb-crawler.ts) — 现有爬虫逻辑（搬到 crawler/）
- [src/routes/api.xdnmb.ts L231-L251](file:///c:\Projects\my-website\glittery-manatee-38c659\src\routes\api.xdnmb.ts#L231-L251) — 主站仅有的索引消费点
- [worker.ts L467-L488](file:///c:\Projects\my-website\glittery-manatee-38c659\worker.ts#L467-L488) — 主站 scheduled handler（要瘦身）
- [wrangler.jsonc](file:///c:\Projects\my-website\glittery-manatee-38c659\wrangler.jsonc) — 主站 Worker 配置（要加 D1 binding）
