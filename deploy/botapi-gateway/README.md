# Syntax Garden 附件网关（本地 Telegram Bot API Server）— Zeabur 部署

把 Telegram 官方 Bot API 服务端以 `--local` 模式跑在 [Zeabur](https://zeabur.com)
免费容器里：**上传单片上限 2000MB、下载无大小限制**。Worker 与浏览器只接触
HMAC 签名 URL，bot token 不出容器。

为什么不是 Koyeb：Koyeb 已于 2026 年被 Mistral 收购，新注册账号无法使用经典
部署控制台与 API token。Zeabur 为华人团队产品，中文界面、国内可直连、无需
信用卡、支持 Dockerfile 与免费 HTTPS 域名，机房在香港/新加坡/日本（可直连
Telegram）。

镜像与宿主无关：同一套文件也能跑在 VPS / 其他 Docker 平台（平台注入 `PORT`
即可，默认 8080）。

## 本目录结构（GitHub 仓库根目录）

```
Dockerfile
start.sh
gateway/server.mjs
```

## 第一步：公开 GitHub 仓库

1. github.com 新建 **Public** 仓库（如 `sg-bot-gateway`）。
2. 网页端 **Add file → Upload files**，把本目录的 `Dockerfile`、`start.sh`、
   `gateway/` 整个上传（保持 `gateway/server.mjs` 层级），Commit。

## 第二步：注册 Zeabur 并创建项目

1. 打开 [zeabur.com](https://zeabur.com)（国内可直连），用 GitHub 账号登录。
2. 首次创建项目时可能要求**验证账号**：三选一为手机号验证 / 预付额度 /
   信用卡——选**手机号验证**即可（免费，支持 +86 号码），不需要卡。
3. **Create Project（创建项目）**，区域（Region）优先选 **Hong Kong（香港）**；
   若免费集群香港不可用，选 **Singapore（新加坡）**或 **Tokyo（东京）**。
   不要选美西以外的美洲节点（国内访问绕路）。

## 第三步：从 GitHub 部署（自动识别 Dockerfile）

1. 项目页点 **Add Service（添加服务）→ Deploy from GitHub（从 GitHub 部署）**。
2. 首次使用按提示授权 GitHub（只授权 `sg-bot-gateway` 这一个仓库即可）。
3. 选中该仓库，Zeabur 检测到根目录的 Dockerfile 后自动以 Docker 方式构建，
   直接点 **Deploy（部署）**。首次构建约 2~5 分钟（拉取 botapi 镜像）。

## 第四步：环境变量

进入该服务 → **Variables（变量）** 标签，逐条添加（值即文本，含 token 的
变量 Zeabur 默认加密存储）：

| 变量 | 值 |
|---|---|
| `BOT_TOKEN` | BotFather token（与 Worker 的 `TG_BOT_TOKEN` 同一个） |
| `GATEWAY_SECRET` | 随机长串，与 Worker 的 `TG_GATEWAY_SECRET` 相同 |
| `TELEGRAM_API_ID` | api_id（过渡期可用 Telegram 桌面端公开 id `17349`） |
| `TELEGRAM_API_HASH` | 对应 hash（桌面端公开值 `344583e45741c457fe1862106095a5eb`） |
| `PUBLIC_ORIGIN` | `https://wow.xn--fpr224a.mom` |

`GATEWAY_SECRET` 在本地 PowerShell 生成：

```powershell
-join ((48..57)+(97..102) | Get-Random -Count 32 | % {[char]$_})
```

`PORT` 不需要设置（Zeabur 自动注入，网关代码读取该变量）。保存后服务会自动
重新部署。

## 第五步：绑定域名

服务 → **Networking（网络）/ Domains（域名）** 标签 → **Generate Domain
（生成域名）**，起一个前缀（如 `sg-gateway`），得到：

```
https://sg-gateway.zeabur.app
```

（实际以后缀显示为准，形如 `https://<前缀>.<区域/集群>.zeabur.app`。）
HTTPS 证书由 Zeabur 自动签发。以后也可以随时改绑自己的域名（CNAME）。

## 第六步：把 bot 从云端登出（一次性）

本地 Bot API Server 要求 bot 先从 `api.telegram.org` 注销：

```powershell
curl.exe -X POST "https://api.telegram.org/bot<BOT_TOKEN>/logOut"
```

返回 `{"ok":true}` 即可。回切云端：暂停/删除 Zeabur 服务后再调一次该接口。

## 第七步：Worker 侧 secrets 并部署

```powershell
wrangler secret put TG_GATEWAY_URL     # https://<你的域名>.zeabur.app（不带尾斜杠）
wrangler secret put TG_GATEWAY_SECRET  # 第四步同一个值
```

本地开发在 `.dev.vars` 里加同名两项。然后 `pnpm run deploy`。

## 验证

1. `https://<你的域名>.zeabur.app/healthz` 返回 `{"ok":true,...}`
   （冷启动可能等待数秒到数十秒）。**在国内、不开代理的浏览器里测**。
2. 网站后台传 50MB 文件 → 再传 1.2GB 文件 → 前台下载并校验字节数。
3. 日志在服务 → **Deployments / Logs** 标签查看。

## 免费层注意事项（实测后决定是否升级）

1. **无流量一段时间后自动休眠**，下次请求冷启动（官方称数秒）；上传/下载
   客户端都有指数退避重试，不影响正确性。
2. **流量与资源额度**：免费方案不承诺 SLA、出站流量有月度额度。存储在
   Telegram 侧仍无限，但访客下载字节走 Zeabur 出口；若额度吃紧，
   账号用量页可以看到消耗，届时把同一镜像搬 VPS，Worker 只改一个
   `TG_GATEWAY_URL`。
3. **单请求大小/时长**：如果 90MiB 分片上传被平台边缘拒绝或超时，给 Worker
   加 secret `TG_LOCAL_PART_BYTES`（字节数，如 `41943040` = 40MiB，
   再不行 `20971520` = 20MiB），无需改代码、无需重建网关。

## 本地自测（可选）

```bash
docker build -t sg-bot-gateway .
docker run --rm -p 8080:8080 \
  -e BOT_TOKEN=... -e GATEWAY_SECRET=... \
  -e TELEGRAM_API_ID=... -e TELEGRAM_API_HASH=... \
  -e PUBLIC_ORIGIN=http://localhost:3000 \
  sg-bot-gateway
```
