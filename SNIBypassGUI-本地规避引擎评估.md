# SNIBypassGUI 本地规避引擎评估

> 调研日期 2026-11-07。依据官方 README、源码、Release API、论文页与 Cloudflare 条款；只做评估与接入设计，不提供下载或安装步骤。

## 1. 结论摘要

现有链路是“NRPT 把域名指到 127.0.0.1 → sni-gate 终止客户端 TLS → 再向源站发起上游 TLS”。真正的缺口在**上游 ClientHello 的明文 SNI**：非 Cloudflare 站点被 SNI 阻断时，sni-gate 无能为力；ECH 硬失败时也没有退路。zapret 与 GoodbyeDPI 恰好作用在这一段出站包上，且默认排除 127.0.0.0/8，不会误伤本地回环，也不需要服务器，能补上这两个缺口。二者都要管理员权限和 WinDivert 内核驱动，**一次只能开一个**。首选 GoodbyeDPI 做可脚本化的“第 4 层补丁”，zapret 作为进阶策略引擎。sing-box、censorless、TiredVPN 均需自有服务器，当前不可用；evadedpi 不推荐；现有 Cloudflare 站点不能改造成代理。

## 2. 逐项审计

### 2.1 zapret（bol-van/zapret）

**是什么/活跃度**：跨平台 DPI 规避工具，C 语言，约 16.4k star，最后提交 2026-11-04，仍在活跃维护。Windows 形态是 `winws.exe`，即 nfqws 的 WinDivert 移植；官方文档明确“所有功能可用”，但需要管理员权限，并加载 `WinDivert64.sys` 内核驱动。**不需要服务器**。

**常用模式**：`--dpi-desync=fake`（低 TTL/错误校验和的伪造包抢先洗白）、`split2`（拆分 ClientHello）、`disorder2/multidisorder`（乱序发送）、`oob`（TCP 紧急数据）；配合 `--dpi-desync-fooling=md5sig|badseq|badsum|ttl`、`--dpi-desync-ttl`、`--hostlist/--hostlist-auto` 限制作用域名。Windows 官方 bundle 还提供 `service_create.cmd`、`service_start.cmd`、`service_stop.cmd`、`service_del.cmd`、`windivert_delete.cmd`，服务名示例为 `winws1/winws2`。

**与现有架构的作用点**：WinDivert 工作在 WFP 层，处理的是**离开本机网卡之前的出站包**。sni-gate/nginx 向源站重建 TLS 时，ClientHello 里是真实 SNI，因此会被 zapret 命中；浏览器到 `127.0.0.1:443` 的回环段不受影响。默认 `--wf-filter-lan=1` 会排除非全局地址（含 127/8、内网、链路本地），只有显式改成 `0` 或自写 `--wf-raw` 才可能碰到回环。

**风险**：内核驱动带来蓝屏/冲突面；Win7/Server 2008/2012 在 Secure Boot 下需先关闭 Secure Boot 才能加载驱动，Win8+ 一般可用签名驱动；杀软可能误报；只能绕过基于包/SNI 的 DPI，**不能突破 IP 封锁**；策略需按运营商用 blockcheck 实测，不能照抄。

### 2.2 GoodbyeDPI（ValdikSS/GoodbyeDPI）

**是什么/活跃度**：Windows 专用 DPI 规避工具，C 语言，约 9.2k star；最新 Release 为 0.2.3rc3（2024-09-14），仓库最后合并提交在 2026-01，属于“稳定但低频维护”。**不需要服务器**。

**Windows 形态**：`goodbyedpi.exe` 控制台程序，需管理员权限，加载 WinDivert 驱动；关闭窗口即退出。仓库另带 `service_install_*.cmd` / `service_remove.cmd`，可注册为 Windows 服务，服务名以脚本内 `sc create` 为准。

**常用参数**：`-6` = `-f 2 -e 2 --wrong-seq --reverse-frag --max-payload`；`-9` 是默认档，在 `-6` 基础上加 `--wrong-chksum` 和 `-q`（阻断 QUIC/HTTP3）。`--blacklist` 按 HTTP Host/TLS SNI 限定域名；`--native-frag`、`--reverse-frag`、`--fake-with-sni`、`--wrong-seq`、`--wrong-chksum` 是主要手法。官方明确 `--set-ttl/--auto-ttl` 属于“危险，可能以意外方式破坏网站”。

**与现有架构的作用点**：源码过滤器显式写了 `!loopback`，并对 IPv4/IPv6 的源和目的地址排除 127/8、10/8、172.16/12、192.168/16、链路本地；只处理目的端口 80/443 的非本地出站 TCP。也就是说，它**只改 sni-gate/nginx 发往源站的那一段**，不碰浏览器到本机的回环，也不会改 NRPT、系统代理或根证书。

**风险**：Killer 网卡的 Advanced Stream Detect 不兼容；QUIK 交易软件可能冲突；ESET 与 WinDivert 的历史冲突官方已标记为修复；老 Win7 缺 SHA256 补丁无法加载驱动；与 VPN/其它 WFP 过滤工具并存可能互相干扰；同样不能突破 IP 封锁。

### 2.3 sing-box

协议客户端/服务端一体，Windows 有官方 `sing-box for Desktop`（TUN、系统代理）与 CLI；VLESS+REALITY、Hysteria2、TUIC、ShadowTLS 等都需要一台自己的服务器。没有 VPS 时连“第 4 出口”都建不起来，只能做本地规则/DNS 工具，**当前不可用，仅作未来参考**；即便未来有服务器，它可用 SOCKS 模式 + 路由规则只服务特定域名、不必接管全局 TUN，但仍无法复用现有 MITM 证书链。

### 2.4 censorless

PoPETs 2026 论文《CensorLess: Cost-Efficient Censorship Circumvention Through Serverless Cloud Functions》，用 AWS Lambda 等 serverless 函数当桥，配本地代理与函数刷新器。它不需要 VPS，但**需要云账号和函数权限**，且只有论文原型、无 Windows 成品。按“不租服务器、只用现有 CF 站点”的约束，**当前不可用，仅参考其“函数轮换”思路**。

### 2.5 evadedpi（tazihad/evadedpi）

Rust 写的本地 SOCKS5/HTTP 代理，功能包括 SNI 分段、TLS record 分片、假 ClientHello、乱序、TCP OOB、阻断 QUIC、内置 DoH；**不需要服务器，也不装内核驱动**。但审计结果很差：仓库 2026-10-05 创建，0 star、0 fork，约 100 次提交全部集中在同一天，4 个 Release 也在同一天发布，且**只提供 linux-x86_64 二进制，没有 Windows 包**；无 issue、无社区审计、无独立复现。README 宣称“跨平台 CLI”，但实际只发 Linux 包，Windows 支持无法验证，代码质量与安全性也无法验证，属于典型的“一天生成的原型”。**结论：不推荐**。它没有要求关闭杀软或提权，但未审计的代理代码本身就能看到全部明文流量，供应链风险不可接受。

### 2.6 TiredVPN（tiredvpn/tiredvpn）

Go 写的抗 DPI VPN，42 star，2026-04 创建，最新 v1.11.9（2026-10-28），维护活跃；技术路线是“服务端 + 客户端”的加密隧道，带 20+ 规避策略、自适应回退、REALITY 风格握手、ECH、TUN/SOCKS5/HTTP 模式，另有 Android 客户端。**必须有自有 Linux 服务器、域名和证书**；Release 只有 linux-amd64/arm64 与 deb/rpm，没有 Windows 客户端。与本次“无服务器、Windows 本地”的需求不匹配，**结论：仅参考**（可借鉴其策略引擎与回退设计，不能直接接入）。

### 2.7 现有 Cloudflare 站点能承担什么

**能**：继续承载博客、Workers/Pages、评论与认证；为**自己的域名**提供 ECH、CDN、DNS 与静态资源。**不能**：把它当作通用代理或 VPN 出口。Cloudflare《Self-Serve Subscription Agreement》2.2.1(j) 明确禁止“use the Services to provide a virtual private network or other similar proxy services”；Workers 免费版每天 10 万请求、单次 10ms CPU、每请求 50 个子请求，也不适合做浏览流量转发。技术上用 Worker 对某个具体 API 做窄口径转发是可行的，但一旦变成通用转发就落入禁止条款，且有滥用封号风险。**结论：只服务博客自身业务，不要把博客改造成代理**。Cloudflare WARP 是另一款产品，不属于“现有站点”的改造范围。

## 3. 兼容性矩阵与关键问题

| 方案 | 与 NRPT+本地 MITM 共存 | 需管理员 | 装驱动 | 可逆性 | 推荐度 |
|---|---|---|---|---|---|
| GoodbyeDPI | 可，默认排除回环 | 是 | WinDivert | 停进程/删服务即可 | ★★★★ |
| zapret winws | 可，`--wf-filter-lan=1` 默认排除回环 | 是 | WinDivert | 停服务 + `windivert_delete` | ★★★☆ |
| sing-box | 仅并列，不能进 MITM 链 | 是（TUN） | WinTun | 是 | ★（无服务器不可用） |
| censorless | 否 | 否 | 否 | 是 | ☆（需云账号） |
| evadedpi | 需改上游，功能重叠 | 否 | 否 | 是 | ☆（未审计） |
| TiredVPN | 仅并列 | 是（TUN） | WinTun | 是 | ☆（需服务器） |
| Cloudflare 站点 | 否 | — | — | — | 禁止做代理 |

**逐条回答**：

1. **无服务器用户能否补缺口**：能补“非 CF 站点被 SNI 阻断”——sni-gate/nginx 的上游 ClientHello 会被 zapret/GoodbyeDPI 分段或伪造，DPI 可能放行；也能补“ECH 不可用”后的普通 TLS 回退——但前提是配置允许从 ECH 降级到 nginx/普通 TLS。若 `require_ech=true` 保持“全有或全无”，连接根本不会发起，包级工具无从下手。还能顺带用 `-q` 阻断 QUIC，减少浏览器 UDP 直连绕过代理。**不能补**：IP 段封锁、主动探测、需要换出口地区的场景。

2. **作用点与回环误伤**：只作用于 sni-gate/nginx 向真实源站发起的上游 TLS；浏览器→127.0.0.1 的回环段被两者默认排除（GoodbyeDPI 源码 `!loopback` + 127/8 排除；zapret 默认 `--wf-filter-lan=1`）。只有把 zapret 改成 `--wf-filter-lan=0` 或自写 raw filter 才可能误伤。**不要同时运行两个 WinDivert 工具**，过滤器会叠加，行为不可预测。

3. **可脚本化启停**：可以。检测 `Get-Process winws/goodbyedpi`、`Get-Service winws1`、`sc query WinDivert`；启动用提权进程或 `sc start`；停止用 `sc stop`/`Stop-Process`；卸载用 `service_del.cmd`/`service_remove.cmd` 与 `windivert_delete.cmd`。两者都不改系统代理、NRPT、根证书，停止后即恢复原路径；C# 面板可直接调用 `sc.exe`/WMI 做开关与状态轮询。

4. **安全审计**：均需管理员 + 内核驱动，攻击面大于普通用户态程序；杀软误报常见；驱动签名在 Secure Boot/arm64/Win7 上有额外要求；官方 README 也提示第三方打包可能带毒，必须只用官方仓库产物并校验哈希。缓解：仅从官方 Release 获取、校验 SHA256、一次只装一个、服务账户最小权限、面板提供“一键停止/删除服务”、开启前记录基线、异常自动回滚。

5. **合规/稳定性**：不改 DNS/代理/证书，正常不会导致浏览器或系统更新失败；已知问题集中在驱动兼容（Killer 网卡、ESET、QUIK、老 Win7、Secure Boot）与 VPN/代理并存。未检索到大规模蓝屏报告，但 WinDivert 是内核驱动，仍应按“可能蓝屏/网络中断”做灰度与回滚；Windows 网络重置可能移除 WinDivert 服务，面板需重新检测。合规上能否使用取决于当地法律与运营商条款，面板应默认关闭、由用户显式开启并自担风险。

## 4. 明确不推荐项

- **censorless**：需云账号与 serverless 函数，无 Windows 成品，当前约束下不可用。
- **evadedpi**：一天生成、0 star、无 Windows 二进制、无审计，属于不可信原型。
- **TiredVPN**：需自有 Linux 服务器，无 Windows 客户端，只能参考设计。
- **sing-box + REALITY/Hysteria2**：无服务器即无出口；有服务器也只能并列，不能接入本地 MITM。
- **把 Cloudflare 站点改造成代理**：违反 2.2.1(j)，免费额度也不适合。
- **zapret 与 GoodbyeDPI 同时开**：两个 WinDivert 过滤器叠加，冲突风险高，只选一个。

## 5. 可落地的接入方案

> 以下仅描述面板如何检测、启停与回滚，不构成安装建议；实际参数须按当地运营商用 blockcheck 复核。

### 方案 A：GoodbyeDPI 作为首选“第 4 层补丁”

- **检测**：`Get-Process goodbyedpi`；`Get-Service` 中是否存在脚本注册的服务；`sc query WinDivert` 判断驱动状态；读取 exe 文件版本；检测当前进程是否提权。
- **参数层级**：L1 稳定档 `-6 -q --blacklist="<面板生成的域名列表>"`；L2 加强档 `-9 --blacklist=...`；不要用 `--set-ttl/--auto-ttl`，不要加 `--dns-addr`（会与现有 NRPT 抢 DNS）。
- **启动/停止**：优先以提权子进程启动，面板持有 PID；或用仓库 `service_install_*.cmd` 注册服务后 `sc start/stop`。停止时先停服务/杀进程，再确认 `WinDivert` 句柄释放；卸载时执行 `service_remove.cmd`。
- **失败回滚**：启动后 10 秒内做一次 `curl --resolve` 直连源站测试；若比基线更差或超时，自动停止并恢复原状；记录退出码与 stderr。
- **用户提示**：“实验性、仅影响本机出站 TLS；需管理员；可能与 VPN/杀软冲突；不能解决 IP 封锁；可一键停止。”

### 方案 B：zapret winws 作为进阶策略引擎

- **检测**：`Get-Process winws`；`sc query winws1`；`sc query WinDivert`；检查 `windivert.filter` 与 `files/*.txt` 是否存在；校验版本。
- **参数层级**：L1 `--wf-tcp=443 --wf-filter-lan=1 --hostlist=<列表> --dpi-desync=split2`；L2 加 `--dpi-desync=fake,split2 --dpi-desync-fooling=md5sig --dpi-desync-ttl=3`；L3 用 `fake,multidisorder` + `badseq,md5sig`。**绝不要设 `--wf-filter-lan=0`**；hostlist 只放需要补的域名，避免破坏未封锁站点。
- **启动/停止**：用官方 `service_create.cmd`/`service_start.cmd` 注册为 `winws1`，或提权启动 `winws.exe`；停止用 `service_stop.cmd`/`sc stop winws1`；卸载用 `service_del.cmd` + `windivert_delete.cmd`。
- **失败回滚**：与 A 相同的直连基线测试；若策略导致 SNI 正常站点也失败，自动降级到 L1 或停止；保留上一版参数文件，支持一键还原。
- **用户提示**：强调“策略因运营商而异、需先跑 blockcheck、内核驱动、可能被杀软拦截”。

### 方案 C：健康检查与互斥护栏（面板层，必做）

- 启用前记录基线：对每个目标域名用 `curl --resolve 域名:443:真实IP` 直连测试 3 次，记录成功率/延迟。
- 启用后每 60 秒复测；连续 2 次劣化自动停止并提示；检测到 VPN/其它 WinDivert 工具时禁止启动。
- 面板维护“只允许一个引擎运行”的状态机；卸载/退出 SNIBypassGUI 时自动停止引擎并清理服务，避免留下后台过滤。
- 所有操作写本地日志（时间、参数、退出码、测试结果），便于回滚与排障。

## 6. 参考资料

- [bol-van/zapret](https://github.com/bol-van/zapret)（16.4k star，2026-11 活跃）
- [zapret Windows 文档](https://github.com/bol-van/zapret/blob/master/docs/windows.md)（winws、WinDivert、`--wf-filter-lan`、服务与 Secure Boot）
- [zapret Windows 快速开始](https://github.com/bol-van/zapret/blob/master/docs/quick_start_windows.md)（`--wf-*` 过滤器、hostlist、不能破 IP 封锁、杀软提示）
- [zapret-win-bundle](https://github.com/bol-van/zapret-win-bundle)（`service_*.cmd`、`windivert_delete.cmd`）
- [ValdikSS/GoodbyeDPI](https://github.com/ValdikSS/GoodbyeDPI)（9.2k star，0.2.3rc3）
- [GoodbyeDPI README](https://github.com/ValdikSS/GoodbyeDPI/blob/master/README.md)（`-6`/`-9`、`-q`、`--blacklist`、已知兼容性问题）
- [GoodbyeDPI 过滤器源码](https://github.com/ValdikSS/GoodbyeDPI/blob/master/src/goodbyedpi.c)（`!loopback` 与 127/8 等本地网段排除）
- [WinDivert 文档](https://reqrypt.org/windivert-doc.html)
- [SagerNet/sing-box](https://github.com/SagerNet/sing-box)
- [sing-box for Desktop](https://sing-box.sagernet.org/zh/clients/desktop/)
- [CensorLess 论文页（PoPETs 2026）](https://crysp.petsymposium.org/popets/2026/popets-2026-0096.php)
- [CensorLess  artifact](https://bitbucket.org/umass-lab/censorless/src/842c2e4458042d210c15f516fdc5fbb902a6f315/)
- [tazihad/evadedpi](https://github.com/tazihad/evadedpi)（0 star，单日提交，仅 Linux 产物）
- [tazihad/evadedpi Releases](https://github.com/tazihad/evadedpi/releases)
- [tiredvpn/tiredvpn](https://github.com/tiredvpn/tiredvpn)（Go，需自有 Linux 服务器）
- [Cloudflare Self-Serve Subscription Agreement](https://www.cloudflare.com/terms/)（2.2.1(j) 禁止 VPN/代理服务）
- [Cloudflare Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)（免费版 10 万请求/日、10ms CPU、50 子请求）
