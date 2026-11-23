---
name: sg-phone-deploy
description: 校验并把手机 sing-box 配置（sg-phone.json）部署到 Android 手机：本地 JSON 校验 → Azure 上 sing-box check → MTP 写入手机 Download → 回读校验。用户要求更新/推送/写入手机 VPN 配置、改 sg-phone.json 后下发到手机时使用。不用于改服务器端 sing-box 配置或普通文件拷贝。
---

# SG Phone Deploy

把改好的手机 sing-box 配置安全地推到手机上的标准流程。核心是一条命令完成「校验 → 写入 → 回读」，避免 MTP 假写入（Size 恒为 0）和配置语法错误。

## 固定环境（不要臆造）

- 本地工作配置目录：`C:\Users\66386\AppData\Local\Temp\sg-phone\`
  - `sg-phone.json`：手机客户端配置（含 UUID / Reality 公钥，**不要提交到 git**）
  - `README.txt`：会以 `sg-phone-README.txt` 为名写入手机
- Azure 校验节点：`azureuser@20.89.88.138`，SSH 私钥 `C:\Projects\keys\sg-gateway_key.pem`，远程用 `/tmp/sg-phone.json` 做 `sing-box check`
- 手机写入目标：`内部存储设备/Download/sg-phone.json`（通过 MTP，USB 直连）
- 手机 MTP 设备路径（硬编码在脚本里的 `$DevicePath`）：换手机或换 USB 口后需重新获取，见下

## 何时触发

- 用户改了 `sg-phone.json`（域名清单、IP 段、rule_set、节点地址等）并要求「推到手机 / 下发 / 更新手机配置」
- 用户报告手机连不上，需要重新部署一份配置
- 需要验证新配置在 sing-box 1.x 下语法合法

## 标准动作

1. 先在本地编辑 `C:\Users\66386\AppData\Local\Temp\sg-phone\sg-phone.json`（改内容）。
2. 跑部署脚本（一条命令完成校验+写入+回读）：

```powershell
& "C:\Projects\my-website\glittery-manatee-38c659\.trae\skills\sg-phone-deploy\scripts\deploy-to-phone.ps1"
```

成功标志：末尾输出绿色「部署完成」，并给出回读字节数与「JSON valid」。失败会在对应步骤抛错并中止，不会写入半残配置。

可选参数：
- `-ConfigPath`：换配置文件路径
- `-SkipServerCheck`：跳过服务器 `sing-box check`（仅在服务器不可达时用，不推荐）
- `-Server` / `-Key`：换节点或密钥

3. 提醒用户在手机 SFA 中**重新导入** `sg-phone.json`（覆盖旧配置）再启用 VPN——只替换文件不会让已运行的客户端重新加载。

## 单独只写文件（不校验）

```powershell
& "...\scripts\copy-phone.ps1" -SrcDir "C:\Users\66386\AppData\Local\Temp\sg-phone"
```

它只做 MTP 写入，不做语法校验。一般直接用 `deploy-to-phone.ps1` 即可。

## 常见坑

- **MTP `Size` 恒为 0**：不能用 `ParseName(...).Size` 判断写入是否成功，必须回读到本地再看字节数和 JSON 能否解析。脚本已处理。
- **设备路径变化**：换手机/换 USB 口后 `shell.Namespace($DevicePath)` 取不到设备，报 `device not found`。重新获取路径的方法：资源管理器地址栏复制手机存储的完整 `::{...}` 路径，更新两个脚本顶部的 `$DevicePath`。
- **`NewFolder` 返回 null**：直接写入已有的 `Download` 目录，不要尝试在 MTP 上新建子目录。
- **远程 `pkill -f` 自杀**：服务器上做测试客户端清理时不要用 `pkill -f <config>`，会匹配到 ssh shell 自身；用 `fuser -k <port>/tcp` 或记 PID。
- **sing-box 1.12+ 才支持的写法**：配置用新版 DNS server 写法和 `http_client`（替代已弃用的 `download_detour`），旧客户端会启动失败。提醒用户客户端版本 ≥ 1.12。
- **rule_set 首次下载**：配置里的远程 rule_set 通过 Azure 出口下载，首次启用手机会多花几秒；若用户网络连不上 GitHub 也不影响（走代理出口）。
- **域名清单两处同步**：`sg-phone.json` 的 `dns.rules[0].domain_suffix` 与 `route.rules` 里的 `domain_suffix` 必须保持一致，否则会出现「流量走代理但 DNS 仍是本地污染结果」。改清单时两处都改。

## 不做的事

- 不把 `sg-phone.json`（含节点凭据）提交进 git 仓库
- 不修改服务器 `/etc/sing-box/config.json`（那是服务端，走另一套流程）
- 不替用户在手机上点导入/启用（需要人工操作屏幕）
