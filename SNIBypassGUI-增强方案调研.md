# SNIBypassGUI 增强方案调研

> 调研日期 2026-11-07。所有链接均为当日检索所得；抓取失败的站点已注明。

## 1. 摘要

八个名词中只有四个能落到真实项目：naiveproxy、protozoa、censorless、linksocks。"mirage" 对应 NDSS 2026 的一篇路由论文而非代理；reality-hydra 没有同名项目，最接近的是 OpenRung 的 "hydra broker" 志愿中继池；elahe tunnel 查无实据；evadedpi 是 2026-10 才出现的零 star 个人仓库。

对这台没有公网 IPv6、没有服务器的 Windows 机器，真正提升可用性的不是换协议，而是把现有三条出口的分流表按"该域名有没有 AAAA / 是否 Cloudflare / 证书能否伪造"重排，并关掉浏览器自带 DoH——零成本、当天见效。抗 IP 封锁必须落到海外主机；志愿中继可白嫖但等于把元数据交给陌生人。本地根 CA 的 MITM 是整套架构最大的安全负债，闭源程序尤甚。

## 2. 逐项分析

### reality-hydra

未找到同名项目、论文或协议。GitHub 搜索仅命中两处：`rcq-messenger/rcq-relay`（"self-registers with the broker (the hydra)"）与 OpenRung。OpenRung（[github.com/openrung/openrung](https://github.com/openrung/openrung)，744★）是 sing-box 内核的 VLESS+REALITY 客户端，流量走志愿者中继，broker 只签发并分发中继列表（Ed25519 签名），配合双 CDN fronting。因此它更像"REALITY 中继池 + 调度器"的产品命名，不是新技术。威胁模型：抗 SNI、靠换中继抗 IP、弱抗主动探测。服务器：由他人提供。Windows：官方有移动端，桌面仅有第三方 WinUI3 客户端（3★）。与本架构：只能作并列的第 4 条出口，不能经过本地 CA。风险：中继可见元数据、随时下线、共享 IP 易被连带封锁。

### mirage

真实来源是 NDSS 2026 论文《MIRAGE: Private, Mobility-based Routing for Censorship Evasion》（[PDF](https://www.ndss-symposium.org/wp-content/uploads/2026-s237-paper.pdf)）：按人群移动模式概率转发消息、用本地差分隐私隐藏个体轨迹，是去中心化消息系统，不是 TLS 代理。另有同名的 MirageOS（OCaml unikernel）与 mirage-proxy（LLM 密钥脱敏），均无关。威胁模型：抗流量关联分析，不解决 SNI 阻断。服务器：无中心节点但需参与者。Windows：无客户端。与本地分流：无法组合。风险：纯论文，无工程实现。

### naiveproxy

[klzgrad/naiveproxy](https://github.com/klzgrad/naiveproxy)，9,612★，C++，2026-11 仍更新。复用 Chromium 网络栈，握手与指纹就是真 Chrome，HTTP/2 CONNECT 加自定义 padding。威胁模型：强抗 SNI 与主动探测，不抗 IP 封锁。服务器：必须海外 VPS + 自有域名 + 有效证书（Caddy + forwardproxy 插件）。Windows：仅命令行 `naive.exe`，输出本地 SOCKS/HTTP，无 GUI、无 TUN。与本架构：可作并列上游，但 MITM 之后证书链已断，不能串进 nginx。风险：证书过期即断，域名可能被针对性封锁。

### protozoa

CCS 2020 论文《Poking a Hole in the Wall》的参考实现，[github.com/dmbb/Protozoa](https://github.com/dmbb/Protozoa)，C，28★，2020-10 后无提交。把 IP 包寄生在 WebRTC 视频流中，达到"行为不可区分"，实测约 1.4 Mbps。威胁模型：抗统计与 ML 流量分析、抗主动探测；不抗 IP 封锁（需信令）。服务器：网关 + 信令。Windows：无成品。与本架构：不可组合。风险：论文原型、带宽低、依赖组件早已过时。

### censorless

PoPETs 2026 论文《CensorLess: Cost-Efficient Censorship Circumvention Through Serverless Cloud Functions》（[论文页](https://crysp.petsymposium.org/popets/2026/popets-2026-0096.php)），用 AWS Lambda 等 serverless 函数当代理，配本地代理与函数刷新器，约 2000 行 TypeScript/Node/Python。威胁模型：靠函数域名轮换抗 IP 封锁。服务器：无需 VPS，但要云账号。Windows：无发行版，需自行编译。与本架构：理论可作出口，实际无接口。风险：云厂商 ToS、冷启动延迟、论文代码。注意另一个 `sh4den/censorless-web-router` 只是防域名查封的小工具，与本文无关。

### linksocks

[github.com/linksocks/linksocks](https://github.com/linksocks/linksocks)，Go，88★，2026-11-07 仍在提交。SOCKS5 over WebSocket，正向/反向/中继三种模式，同端口兼容 SOCKS5 与 HTTP CONNECT，含 UDP ASSOCIATE 与 token 鉴权。威胁模型：抗 SNI（WSS 与普通站点同形）、穿企业防火墙；不抗 IP 封锁与行为分析。服务器：一台能跑 WSS 的公网主机。Windows：有 CLI 二进制。与本架构：适合把 `127.0.0.1:22222` 反向暴露或从公网取流，与"抗审查出口"目标错位。风险：定位是内网穿透，不是抗封锁。

### elahe tunnel

中/英/俄/波斯语检索均无结果：GitHub 仓库搜索 "elahe tunnel" 为 0，网页检索只返回同名个人主页。判定为私域/Telegram 售卖的中继服务名，或拼写有误。无代码、无文档，威胁模型与安全性均无法评估，不建议纳入方案。

### evadedpi

[github.com/tazihad/evadedpi](https://github.com/tazihad/evadedpi)，Rust，0★，2026-10-05 创建，单人项目。功能是本地 DPI 规避：SNI 分段（sni/mid-sni/multisplit）、TLS record 分片、低 TTL 假 ClientHello 洗白、TCP OOB、阻断 QUIC、内置 DoH，本地 9090 同时提供 SOCKS5 与 HTTP 代理。威胁模型：抗 SNI 阻断与部分主动探测，不抗 IP 封锁。服务器：不需要。Windows：声称跨平台 CLI，README 未说明包注入驱动，可用性未验证。与本架构：与 sni-gate 功能重叠。风险：无 release、无社区审计。

## 3. 横向对比表

| 项目 | 需服务器 | 抗 SNI | 抗 IP 封锁 | 抗主动探测 | Windows 可用性 | 与本地分流兼容 |
|---|---|---|---|---|---|---|
| reality-hydra / OpenRung | 用他人中继 | 强 | 中 | 中 | 移动端为主 | 仅并列 |
| mirage | 需参与者 | 否 | 否 | 是 | 无 | 否 |
| naiveproxy | 必需 | 强 | 弱 | 强 | CLI | 仅并列 |
| protozoa | 必需 | 是 | 否 | 强 | 无 | 否 |
| censorless | 云账号 | 中 | 中 | 中 | 无 | 否 |
| linksocks | 必需 | 强 | 弱 | 弱 | CLI | 可做管道 |
| evadedpi | 不需要 | 强 | 否 | 弱 | 未验证 | 重叠 |
| VLESS+Reality | 必需 | 强 | 弱 | 强 | GUI/CLI | 仅并列 |
| Hysteria2 | 必需 | 中 | 弱 | 中 | GUI/CLI | 仅并列 |
| TUIC | 必需 | 中 | 弱 | 中 | GUI/CLI | 仅并列 |
| sing-box | 视协议 | 视协议 | 视协议 | 视协议 | GUI/CLI/TUN | 仅并列 |
| ShadowTLS v3 | 必需 | 强 | 弱 | 中 | CLI | 仅并列 |
| Cloak | 必需 | 强 | 中 | 强 | CLI | 仅并列 |
| domain fronting | 需 CDN | 强 | 强 | 中 | 无 | 否 |
| zapret / GoodbyeDPI | 不需要 | 强 | 否 | 弱 | 原生 | 冲突 |
| 内建 ECH 出口 | 不需要 | 中 | 否 | 弱 | 已内建 | 原生 |

补充活跃度（2026-11）：Xray-core 42.7k★、sing-box 39.7k★、Hysteria2（已迁至 `HyNetworks/hysteria`）22.9k★、GoodbyeDPI 28.8k★、zapret 16.4k★、Cloak 4.1k★、GreenTunnel 4.9k★、dpibreak 149★；TUIC 最后提交 2025-05、ShadowTLS 2025-04，维护明显放缓。

## 4. 俄语社区发现

- [habr.com/ru/articles/1024990/](https://habr.com/ru/articles/1024990/)：NaiveProxy 接入 sing-box 的实测，指出其 padding 与 HTTP/2 复用是抗 DPI 的关键。
- [habr.com/ru/amp/publications/1047442/](https://habr.com/ru/amp/publications/1047442/)：2026-06 起 ТСПУ 从"签名匹配"转向"行为指纹"，SOCKS5、VLESS、L2TP 都被波及。
- [habr.com/ru/articles/1104872/](https://habr.com/ru/articles/1104872/)：明确区分"有服务器的隧道"和"无服务器的本地 DPI 规避（zapret/GoodbyeDPI/ByeDPI）"。
- [habr.com/ru/articles/1095490/](https://habr.com/ru/articles/1095490/)：ТСПУ 对 Cloudflare/ECH 的多特征联合判定，说明 ECH 不是万能。
- [habr.com/ru/articles/1021160/](https://habr.com/ru/articles/1021160/)：四层架构 + Reality 多 SNI 轮换，指出"IP 在白名单"是误区。
- [habr.com/ru/articles/956916/](https://habr.com/ru/articles/956916/)：nginx `ssl_preread` 按 SNI 转发 + 自建 DNS，与 SNIBypassGUI 的 sni-gate 思路同源，可借鉴其 resolver 写法。
- [habr.com/ru/en/articles/1064682/](https://habr.com/ru/en/articles/1064682/)：被封后用 nginx 镜像"复活"代理，涉及 `proxy_bind` 与后端切换。
- [habr.com/ru/sandbox/285332/](https://habr.com/ru/sandbox/285332/)：zapret-core 自动搜索可用策略，说明本地规避高度依赖运营商。
- [habr.com/ru/articles/990300/](https://habr.com/ru/articles/990300/)：ByeDPI/SpoofDPI 的落地方式，可作为 Windows 之外的对照。
- [ntc.party 的 OpenRung 帖](https://ntc.party/t/openrung-%E2%80%94-%D0%B1%D0%B5%D1%81%D0%BF%D0%BB%D0%B0%D1%82%D0%BD%D1%8B%D0%B9-%D0%BE%D0%BF%D0%B5%D0%BD%D1%81%D0%BE%D1%80%D1%81%D0%BD%D1%8B%D0%B9-%D0%BE%D0%B1%D1%85%D0%BE%D0%B4-%D0%B1%D0%BB%D0%BE%D0%BA%D0%B8%D1%80%D0%BE%D0%B2%D0%BE%D0%BA-%D0%BD%D0%B0-%D0%B2%D0%BE%D0%BB%D0%BE%D0%BD%D1%82%D1%91%D1%80%D1%81%D0%BA%D0%B8%D1%85-%D1%80%D0%B5%D0%BB%D0%B5%D1%8F%D1%85-%D1%80%D0%B0%D0%BD%D0%BD%D0%B8%D0%B9-%D0%B4%D0%BE%D1%81%D1%82%D1%83%D0%BF/25364)：俄语圈对志愿中继的讨论，重点是"可用性优先、不做匿名"。
- 未找到：habr/telegram 上关于 "Mirage 翻墙"、"Elahe tunnel"、"reality-hydra" 的实测帖——三者要么是产品命名，要么根本不存在。

## 5. 可落地清单

### A. 现在就能做（不需要服务器）

1. **关掉浏览器 DoH**。Chrome/Edge 设置里关闭"使用安全 DNS"，Firefox 关 TRR。为什么：NRPT 只对系统 DNS 客户端生效，浏览器 DoH 会绕过 `dns_hosts.txt`，域名直接解析到真实 IP。收益：恢复分流命中率。风险：无。
2. **按出口能力重排站点表**。把没有 AAAA 的站点（grok.com、chatgpt.com 等）从 NAT64 组移到 nginx/ECH 组。为什么：本机无公网 IPv6，NAT64 必然失败。收益：这批站点立刻恢复 200。风险：需逐站 `Resolve-DnsName -Type AAAA` 核对。
3. **ECH 只留给 Cloudflare 站点**，非 CF 站点强制走 nginx，并定期更新优选 IP。收益：减少无效重试。风险：部分运营商已开始标记 ECH 扩展。
4. **收紧本地根 CA**：确认只信任一次、导出后删除多余副本；nginx 上游开启 `proxy_ssl_verify on` 与正确 SNI；不要对不需要 MITM 的域名签发。为什么：闭源程序持有根 CA 等于全流量可解密可注入。收益：安全收益最大。风险：部分站点会因证书校验失败而断，需白名单。
5. **拿到任意公网 IPv6**（HE 6in4 或运营商下发）即可让 NAT64 组复活。收益：整组站点恢复。风险：协议 41 可能被上游封、延迟增加。

### B. 需要一台海外 VPS

1. **sing-box + VLESS+REALITY**（约 $3–5/月，RackNerd/Vultr/Netcup）。Windows 端用 sing-box TUN 或 v2rayN，把失败域名按规则单独走 TUN，**不要试图塞进本地 MITM**。收益：同时抗 SNI 与主动探测，IP 被封换 IP 即可。风险：需长期维护，单 IP 仍会被墙。
2. **NaiveProxy**（VPS + 自有域名约 $10/年 + Caddy）。作为备用出口，指纹最像浏览器。风险：证书与域名都要续。
3. **Hysteria2**：仅在丢包严重的线路上作为补充；UDP 443 常被 QoS。

### C. 不适用或纯理论

- protozoa、censorless、mirage：论文原型，无 Windows 成品。
- elahe tunnel：无可靠来源，不要碰。
- reality-hydra：命名不成立，实质是 OpenRung 式志愿中继，属 B 档且要信任他人。
- 纯 TLS fragmentation（zapret/GoodbyeDPI）：与本地 MITM 架构冲突，且 sni-gate 已替代其作用。
- domain fronting：主流 CDN 自 2018 年起已封禁。
- ShadowTLS/TUIC：能用但维护放缓，收益不如 Reality。

## 6. 对 SNIBypassGUI 的增强建议（按性价比）

1. **出口能力感知的分流表 + 失败自动降级**（配置层，零成本）。给每个站点标注 `ipv6_required / cloudflare / mitm_ok`，失败三次自动切下一出口。收益最高。
2. **统一 DNS 入口**（零成本）。面板里检测并提示关闭浏览器 DoH，或把系统 DoH 指到遵守 hosts 的解析器。
3. **最小化本地 CA 与上游校验**（安全收益最高）。默认不 MITM，按域名白名单开启；nginx 强制校验上游证书。
4. **新增第 4 条出口：本地 sing-box SOCKS**（需 VPS）。sni-gate 识别失败域名后转发到 `127.0.0.1:1080`，与现有三条并列而非嵌套。
5. **不要叠加 WinDivert 类工具**。zapret/GoodbyeDPI 会与 NRPT 和本地回环监听互相打架，只在完全退出 SNIBypassGUI 时使用。
