---
name: deploy-sg-stack
description: 发布 Syntax Garden 的 Cloudflare Worker 网站与 Azure botapi 网关（scp 同步、SSH 重建容器）。用户说发布、部署网站、部署网关、同步网关改动、上线时使用。不用于日常改代码或纯本地验证。
---

# Deploy SG Stack

Syntax Garden 的发布流程。改动分两部分，先判断本次改动涉及哪些，再走对应流程。

## 固定环境（不要臆造其他值）

- 本地工作区：`C:\Projects\my-website\glittery-manatee-38c659`
- Azure 服务器：`azureuser@20.89.88.138`，SSH 私钥 `C:\Projects\keys\sg-gateway_key.pem`
- 远程目录：`~/glittery-manatee-38c659/deploy/botapi-gateway`
- 容器：`gateway`（Node 签名网关 + botapi）、`caddy`（自动 HTTPS）
- 域名：`gw.xn--fpr224a.mom`（灰云直连）、`dl.xn--fpr224a.mom`（Cloudflare 橙云，手机下载）
- 健康检查：`curl -s https://gw.xn--fpr224a.mom/healthz` 应返回 `{"ok":true,"service":"sg-bot-gateway"}`

## 两个窗口（给用户的每条命令必须标注窗口）

- **窗口 B（本地 PowerShell）**：`pnpm`、`scp`、`wrangler`、`ssh`（用于建立连接）
- **窗口 A（SSH，提示符 `azureuser@sg-gateway:...$`）**：`docker compose`、`curl` 验证服务器

PowerShell 中 `curl` 是 `Invoke-WebRequest` 别名，所有 `curl -s ...` 验证命令只能在窗口 A 执行。

## 第 0 步：判断改动范围

- 仅改了 `src/`、`db/`、`worker.ts`、`content/` 等 → 只走【网站发布】
- 改了 `deploy/botapi-gateway/gateway/server.mjs` → 走【网关脚本发布】
- 改了 `deploy/botapi-gateway/caddy/Caddyfile` → 走【Caddy 发布】（必须先 validate）
- 涉及 Worker secret 新增/变更 → 额外走【Secret 变更】

## 第 1 步：本地类型检查（任何发布前必做，窗口 B）

```powershell
cd C:\Projects\my-website\glittery-manatee-38c659
pnpm exec tsc --noEmit
```

无输出即通过。有报错先修，不要带错发布。

## 网站发布（窗口 B）

```powershell
pnpm run deploy
```

注意必须是 `pnpm run deploy`——`pnpm deploy` 会被 pnpm 内置命令拦截（ERR_PNPM_INVALID_DEPLOY_TARGET）。成功标志：输出含 `Uploaded syntax-garden` 与 `Deployed syntax-garden triggers`。

部署后首次访问可能超时或很慢：Worker 内存缓存清空 + Neon 冷启动，几分钟内被 `*/5 * * * *` 定时任务预热自愈，刷新即恢复，不要因此回滚。

## 网关脚本发布（server.mjs）

窗口 B 上传：

```powershell
scp -i C:\Projects\keys\sg-gateway_key.pem .\deploy\botapi-gateway\gateway\server.mjs azureuser@20.89.88.138:~/glittery-manatee-38c659/deploy/botapi-gateway/gateway/server.mjs
```

窗口 A 重建并验证：

```bash
cd ~/glittery-manatee-38c659/deploy/botapi-gateway
docker compose up -d --build gateway
sleep 3
curl -s https://gw.xn--fpr224a.mom/healthz
```

## Caddy 发布（Caddyfile，风险最高）

容器一直重启会导致 443 拒绝连接，所以**先 validate 再 restart**。

窗口 B 上传：

```powershell
scp -i C:\Projects\keys\sg-gateway_key.pem .\deploy\botapi-gateway\caddy\Caddyfile azureuser@20.89.88.138:~/glittery-manatee-38c659/deploy/botapi-gateway/caddy/Caddyfile
```

窗口 A 先验证（临时容器，不影响运行中服务）：

```bash
docker run --rm -v ~/glittery-manatee-38c659/deploy/botapi-gateway/caddy/Caddyfile:/etc/caddy/Caddyfile:ro caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile
```

出现 `Valid configuration` 才允许重启：

```bash
cd ~/glittery-manatee-38c659/deploy/botapi-gateway
docker compose restart caddy
sleep 8
curl -s https://gw.xn--fpr224a.mom/healthz
```

排障命令：`docker compose ps`（看是否 Restarting）、`docker compose logs --tail=30 caddy`。
教训：`protocols h1` 必须写在全局 `{ servers { } }` 块里，写进站点块会导致配置非法、容器崩溃循环。

## Secret 变更（窗口 B）

```powershell
cd C:\Projects\my-website\glittery-manatee-38c659
pnpm wrangler secret put <SECRET_NAME>
```

提示后粘贴值。改完必须再执行一次 `pnpm run deploy` 才生效（secret put 本身不触发新部署，但保险起见）。

## 常见坑（给用户命令时主动规避）

- 多条命令不要写成一行让用户粘贴；PowerShell 续行符 `>>` 会把命令粘连错位。一次给一条，或在同一代码块内用换行（SSH 窗口支持多行粘贴，PowerShell 谨慎）。
- 用户粘贴 URL 时容易带反引号（`` `https://...` ``），导致 curl 报 `Malformed input`；命令里的 URL 不要加反引号。
- scp 的本地相对路径依赖当前目录：让用户先 `cd` 到工作区，或直接给 `.\deploy\...` 相对路径并确认提示符在工作区。
- 远程服务器在日本，国内 PowerShell 直连 `api.telegram.org` 不通属正常；bot 侧操作（logOut 等）一律在窗口 A 执行。
- 网关排障组合拳：`docker compose ps` + `docker compose logs --tail=50 gateway` + `docker stats --no-stream`。
- DNS 记录（gw/dl 子域、橙灰云、SSL Full(strict)）在朋友的 Cloudflare 账号里，需要他操作；你只负责服务器与 Worker 侧。

## 发布后验证清单

- healthz 返回正常 JSON
- 网站页面可打开（冷启动等待后）
- 涉及下载改动时：桌面 Edge 测一次（Network 看 `gw.` 请求 206/协议），手机关浏览器重开测一次
- 1.2GB 参照文件完整大小为 1,200,791,668 字节，可用于字节级校验
