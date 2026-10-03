# Syntax Garden 附件网关（本地 Telegram Bot API Server）— Koyeb 部署

把 Telegram 官方 Bot API 服务端以 `--local` 模式跑在 [Koyeb](https://www.koyeb.com)
免费 Web Service 里：**上传单片上限 2000MB、下载无大小限制**。Worker 与浏览器
只接触 HMAC 签名 URL，bot token 不出容器。

镜像与宿主无关：同一套文件也能跑在 VPS / Hugging Face Space（HF 需设
`PORT=7860`）。

## 本目录结构（部署仓库的根目录）

```
Dockerfile
start.sh
gateway/server.mjs
```

## 第一步：建一个公开的 GitHub 仓库

Koyeb 可以直接填**公开仓库 URL** 导入（不需要授权 GitHub App）。

1. 在 github.com 新建一个 **Public** 仓库（如 `sg-bot-gateway`），空仓库即可
   （代码里没有任何密钥，安全）。
2. 打开仓库页 → **Add file → Upload files**，把本目录下的 `Dockerfile`、
   `start.sh`、`gateway/` 整个拖进去（保留 `gateway/server.mjs` 层级），Commit。
   国内访问 github.com 网页一般可用；若连不上可挂代理完成这一次上传，之后
   Koyeb 在海外自行拉取，与你的网络无关。

## 第二步：Koyeb 创建服务

1. 用 GitHub 账号登录 [app.koyeb.com](https://app.koyeb.com)（免信用卡）。
2. **Create Web Service** → 部署方式选 **GitHub** → 切到 **Public GitHub
   repository** 标签 → 填你的仓库 URL。
3. Builder 选 **Dockerfile**（默认即可，Dockerfile 在仓库根目录）。
4. Region 选 **Frankfurt (fra)**（免费层可选 Fra/Was；法兰克福离 Telegram
   欧洲机房近，国内访问通常也更好）。
5. Instance 选 **Free**（512MB / 0.1 vCPU / 2GB 磁盘）。
6. Ports：服务端口 **8080**、协议 **HTTP**、路由 Path `/` 指向 8080
   （Koyeb 新版界面通常自动识别）。
7. Health Check：HTTP、路径 `/healthz`；若有启动宽限期设置填 **40s**
   （容器要先起 botapi 并与 Telegram 握手）。

## 第三步：环境变量（Settings → Environment variables and secrets）

敏感项一律用 **Secret** 类型：

| 变量 | 类型 | 说明 |
|---|---|---|
| `BOT_TOKEN` | Secret | BotFather token（与 Worker 的 `TG_BOT_TOKEN` 同一个） |
| `GATEWAY_SECRET` | Secret | 随机长串（PowerShell：`-join ((48..57)+(97..102) | Get-Random -Count 32 | % {[char]$_})`），与 Worker 的 `TG_GATEWAY_SECRET` 相同 |
| `TELEGRAM_API_ID` | Secret | my.telegram.org 申请的 api_id（过渡期可用 Telegram 桌面端公开 id `17349`） |
| `TELEGRAM_API_HASH` | Secret | 对应 api_hash（桌面端公开 hash：`344583e45741c457fe1862106095a5eb`） |
| `PUBLIC_ORIGIN` | 普通 | `https://wow.xn--fpr224a.mom`（浏览器跨域来源，精确匹配） |

`PORT` 不用设（代码默认 8080，与 Koyeb 一致）。不要设 `TELEGRAM_LOCAL`：
start.sh 固定以 `--local` 启动 botapi。

## 第四步：把 bot 从云端登出（一次性）

本地服务端要求 bot 先从 `api.telegram.org` 注销（只影响 getUpdates 接收，
本项目不用它；随时可以再登回来）：

```powershell
curl.exe -X POST "https://api.telegram.org/bot<BOT_TOKEN>/logOut"
```

建议等 Koyeb 第一次部署完成后再执行；登出后网关必须在线，否则云端 API 也
调不动。回切云端：删掉/暂停 Koyeb 服务后再对云端调一次 logOut 即可。

## 第五步：Worker 侧 secrets 并部署

```powershell
wrangler secret put TG_GATEWAY_URL     # https://<你的服务名>.koyeb.app（不带尾斜杠）
wrangler secret put TG_GATEWAY_SECRET  # 与第三步同一个值
```

本地开发在 `.dev.vars` 里加同名两项。然后 `pnpm run deploy`。

## 验证

1. `https://<服务名>.koyeb.app/healthz` 返回 `{"ok":true,...}`
   （首次冷启动可能要等 10~40 秒）。
2. 网站后台传一个 50MB 文件 → 再传 1.2GB 文件 → 前台下载并校验字节数。

## 免费层的三个已知限制（实测后决定是否升级）

1. **1 小时无流量自动缩容到零**，冷启动数秒到数十秒；上传/下载客户端都有
   指数退避重试，不影响正确性，只影响首个请求的等待。
2. **边缘单请求超时 120 秒**。90MiB 大片在弱网上行（<1MB/s）可能传不完。
   如实测遇到，给 Worker 加 secret `TG_LOCAL_PART_BYTES`（字节数，如
   `41943040` = 40MiB）调小分片，无需改代码、无需重新构建网关。
3. **每月出站流量 100GB**。存储在 Telegram 侧仍无限，但访客下载字节走
   Koyeb 出口；如果下载量超过这个量级，把同一镜像搬到 VPS（境外、支付宝
   年付即可），Worker 只需改 `TG_GATEWAY_URL` 一个 secret。

## 国内访问 *.koyeb.app 若不通

Koyeb 支持绑定自定义域名并自动签发 HTTPS：在服务 Settings → Domains 添加
如 `gw.xn--fpr224a.mom`，按提示请朋友在域名 DNS 加一条 CNAME 指向
`<服务名>-<组织名>.koyeb.app`（Cloudflare 代理可保持橙云开），然后：

- Worker 的 `TG_GATEWAY_URL` 改成新域名；
- 网关容器的 `PUBLIC_ORIGIN` 不用变（它是**网站**的 origin，不是网关自己的）。

## 本地自测（可选）

```bash
docker build -t sg-bot-gateway .
docker run --rm -p 8080:8080 \
  -e BOT_TOKEN=... -e GATEWAY_SECRET=... \
  -e TELEGRAM_API_ID=... -e TELEGRAM_API_HASH=... \
  -e PUBLIC_ORIGIN=http://localhost:3000 \
  sg-bot-gateway
```
