# SNIBypassGUI C#/.NET 完全重写计划

## 背景与目标

**问题**：SNIBypassGUI 当前是 C++ Win32 原生应用，与 C# 设置面板形成混合技术栈，维护困难、编译工具链复杂（需 MinGW）、开发效率低。

**目标**：完全重写为 C#/.NET 10，统一技术栈，提高可维护性，确保功能完整。

**用户决策**：
- 选择完全重写（方案 B）
- 自建更新通道（新密钥对 + 自建 manifest 端点）
- 强调审计工作和功能完整性

## 核心原则

1. **功能对等**：所有现有功能必须重写，不遗漏
2. **兼容性**：保持与现有配置文件、数据格式、外部工具的兼容
3. **可测试**：每个模块都有对应的单元测试和差分测试
4. **渐进式**：分阶段实施，每阶段可验证
5. **可回滚**：保留旧版本，随时可切回

## 技术栈

- **运行时**：.NET 10（已安装）
- **UI 框架**：WinForms（与现有 SgPanel 一致）
- **架构模式**：MVP（Passive View）
- **发布方式**：自包含单文件（`PublishSingleFile=true`）
- **依赖注入**：手写组合根（不引入 Microsoft.Extensions.DI）

## 项目结构

```
D:\dev\SniBypass\
├─ SniBypass.sln
├─ src/
│  ├─ SniBypass.Core\          # 核心逻辑（UI 无关，可测试）
│  │  ├─ Dns\                  # DNS 解析、规则、重定向、协议
│  │  ├─ Services\             # 服务编排、组件管理
│  │  ├─ Platform\             # 进程、端口、注册表、任务计划
│  │  ├─ App\                  # 设置、路径、日志、国际化
│  │  └─ Update\               # 更新客户端、加密、下载
│  ├─ SniBypass.Tray\          # 托盘 UI（输出 SNIBypassGUI.exe）
│  │  ├─ TrayApplicationContext.cs
│  │  ├─ TrayPresenter.cs
│  │  ├─ MenuBuilder.cs
│  │  └─ Forms\                # EULA、进度窗口等
│  └─ SniBypass.Updater\       # 独立更新器（嵌入主程序）
└─ tests/
   ├─ SniBypass.Core.Tests\    # 单元测试
   └─ SniBypass.IntegrationTests\ # 集成测试（需管理员）
```

## 模块重写对照

### 1. DNS 子系统（关键路径，3-4 周）

| C++ 模块 | C# 实现 | 关键类 |
|---------|---------|--------|
| resolver.cpp | `LocalResolver` | async/await + SocketAsyncEventArgs 替代 select |
| rules.cpp | `RuleSet`/`RuleParser` | 不可变集合 + 原子换引用 |
| redirector.cpp | `Redirector` | 启动序：resolver→策略表→guardian |
| nrpt.cpp | `Nrpt`/`NrptRuleWatch` | 注册表直写 + RegNotifyChangeKeyValue |
| dns_proxy.cpp | `DnsProxy` | 多监听绑定 + 竞速上游池 |
| message.cpp | `DnsMessage` | Span<byte> 操作，UDP 预算算法 |
| plain_client.cpp | `PlainDnsClient` | Socket UDP + TCP 重试 |
| doh_client.cpp | `DohClient` | HttpClient + 证书钉扎 |
| dot_client.cpp | `DotClient` | TcpClient + SslStream |
| dnscrypt_client.cpp | `DnsCryptClient` | NSec.Cryptography（X25519/Ed25519） |

**风险最高**：DNSCrypt 握手移植，需专项 spike 验证 NSec 可行性。

### 2. 服务编排（1.5 周）

| C++ 模块 | C# 实现 | 关键类 |
|---------|---------|--------|
| services.cpp | `ServiceStack` | Task.WhenAny 监督四组件 |
| process.cpp | `ChildProcess` | Process + Job Object（父死子灭） |
| ports.cpp | `Ports`/`PortClaim` | Socket 试绑 + GetExtendedTcpTable |
| autostart.cpp | `AutostartManager` | Microsoft.Win32.TaskScheduler |
| command.cpp | `CommandRunner` | Process + 超时取消 |

### 3. 平台工具（1 周）

| C++ 模块 | C# 实现 | 关键类 |
|---------|---------|--------|
| filesystem.cpp | `PathResolver` | 系统路径解析 |
| ini.cpp | `IniReader` | 读自研 + 写 P/Invoke |
| logging.cpp | `AppLog` | 自研 ≤150 行日志 |
| settings.cpp | `Settings` | INI 读写，键名兼容 |
| i18n.cpp | `I18n` | Dictionary<string,(en,zh)> |
| shortcut.cpp | `ShortcutManager` | IShellLinkW COM interop |

### 4. 更新子系统（2 周）

| C++ 模块 | C# 实现 | 关键类 |
|---------|---------|--------|
| client.cpp | `UpdateClient` | HttpClient + 分块下载 + SHA256 |
| crypto.cpp | `ManifestVerifier` | ECDsa P-256 验签（BCL 自带） |
| http.cpp | `HttpDownloader` | HttpClient + ResponseHeadersRead |
| updater/ | `SniBypass.Updater` | 独立 EXE，嵌入主程序资源 |

**更新通道**：新密钥对 + 自建 manifest 端点（用户已确认）。

### 5. 托盘 UI（1.5 周）

| C++ 模块 | C# 实现 | 关键类 |
|---------|---------|--------|
| tray.cpp | `TrayApplicationContext` | NotifyIcon + ContextMenuStrip |
| controller.cpp | `AppController`/`ITrayPresenter` | MVP 模式，八回调接口 |
| progress_window.cpp | `ProgressForm` | ProgressBar + 取消按钮 |
| eula.cpp | `EulaForm` | 双语嵌入文本，SHA256 判定 |
| supported_sites.cpp | `SupportedSitesMenuBuilder` | 解析 supported_sites.dat |

**菜单对等**：状态区（4 项）、启动/停止、自启动、支持网站、更新、语言、杂项（日志/hosts/缓存/卸载）、关于、退出。

## 依赖管理

| 依赖 | 选择 | 用途 |
|------|------|------|
| NSec.Cryptography | NuGet | DNSCrypt 加密（X25519/XSalsa20-Poly1305/Ed25519） |
| Microsoft.Win32.TaskScheduler | NuGet | 自启动任务管理 |
| System.ServiceProcess.ServiceController | NuGet | Windows 服务查询 |
| System.Text.Json | BCL | JSON 解析（源生成） |
| xUnit + FluentAssertions | NuGet | 单元测试 |

**不引入**：Microsoft.Extensions.Hosting/DI、Serilog、CommunityToolkit.Mvvm（控制体积和复杂度）。

## 迁移策略（分阶段）

### P0 基线冻结（0.5 周）
- 录制黄金样本：dns_hosts.txt 解析结果、DNS 响应字节、meta.ini 解析结果等
- 写成差分测试夹具

### P1 地基（1 周）
- IniReader/Paths/Settings/AppLog/I18n/AppVersion
- 单元测试（含 INI 读写一致性测试）

### P2 DNS 子系统（3-4 周，关键路径）
- DnsMessage+RuleSet（纯逻辑先行）
- LocalResolver
- Nrpt+Redirector+guardian
- Plain/DoH/DoT
- **DNSCrypt spike**（验证 NSec，失败则切 BouncyCastle）
- DnsProxy

### P3 编排与平台（1.5 周）
- ChildProcess/Job、Ports、ServiceStack
- Autostart、Uninstall、CleanCache
- SingleInstance、Elevation

### P4 更新与 UI（2 周）
- Crypto/HttpDownloader/Manifest/UpdateClient
- SniBypass.Updater
- 托盘全家桶、EULA/进度窗

### P5 硬化与切替（1 周）
- 真机 side-by-side 测试（`D:\SNIBypassGUI-vNext\` 与旧版并存）
- 差分验证全绿
- 备份旧目录
- 切换快捷方式/计划任务
- SgPanel 功能迁入（淘汰 PowerShell 版）

## 测试计划

### 单元测试（CI 可跑）
- 规则解析矩阵
- DNS 报文编解码边界（压缩指针环、超长标签、截断 OPT）
- ApplyUdpBudget 三态
- INI 读写一致性
- dnsstamp 解析
- RepairBudget 窗口语义
- 端口 claim 语法
- glob 匹配器
- 版本比较
- ECDSA 验签向量

### 集成测试（需管理员）
- NRPT 装/删/自愈/预算耗尽
- Dnscache 四态
- CanBindAll 矛盾检测
- HTTP.sys 占用释放
- Job Object 父崩溃子进程全灭
- 卸载 glob 精确删除

### 差分测试
- P0 黄金样本回放，C++ 与 C# 输出一致

### E2E 测试
- 启动栈→域名解析到 127.11.45.14→站点可访问
- 热改 hosts
- 杀 nginx 全栈倒下
- 端口冲突提示
- 清理缓存
- 卸载残留为零

## 风险与缓解

| 风险 | 等级 | 缓解措施 |
|------|------|---------|
| DNSCrypt 握手移植错误 | 高 | 专项 spike 先行；黄金向量差分测试；备选 BouncyCastle |
| 更新签名私钥不可得 | 高 | **已解决**：自建更新通道（用户确认） |
| 线程/等待模型差异 | 中 | 专属 guardian 线程复刻顺序；集成测试覆盖 |
| Job Object 与 .NET Process 交互 | 中 | ChildProcess 封装 + 父进程崩溃测试 |
| 端口审计误杀进程 | 中 | 审计分类测试矩阵；IsSystemCritical 兜底 |
| WinForms 单文件体积/启动回归 | 低 | 压缩单文件 + ReadyToRun；性能验收门槛 |
| EDR/杀软无信誉标记 | 中 | 行为透明；不追求规避 |
| 放弃 Win7 支持 | 低 | 用户实机 Win11，接受 |

## 验证与回滚

**验证方法**：
1. 差分测试（C++ vs C# 输出一致）
2. 集成测试（管理员 Trait）
3. 真机 E2E 清单

**回滚方案**：
- 旧目录整树压缩留档
- 计划任务/快捷方式指向 exe 路径，切回即还原
- C# 版更新通道独立，失败不影响旧通道

## 成功标准

1. **功能完整**：所有现有功能正常工作，无遗漏
2. **性能达标**：DNS 查询延迟 +20% 以内，内存 <80MB，启动 <1.5s
3. **测试通过**：单元测试、集成测试、差分测试全绿
4. **可维护**：代码结构清晰，文档完整，易于后续开发

## 关键文件

### 审计依据（C++ 源码）
- `D:\SNIBypassGUI-full\SNIBypassGUI-main\src\dns\` - DNS 子系统
- `D:\SNIBypassGUI-full\SNIBypassGUI-main\src\app\services.cpp` - 服务编排
- `D:\SNIBypassGUI-full\SNIBypassGUI-main\src\ui\tray.cpp` - 托盘 UI
- `D:\SNIBypassGUI-full\SNIBypassGUI-main\resources\payload\meta.ini` - 配置格式

### 线上黄金配置（差分测试基准）
- `D:\SNIBypassGUI-v5.2.1\meta.ini`
- `D:\SNIBypassGUI-v5.2.1\data\dns_proxy.ini`
- `D:\SNIBypassGUI-v5.2.1\data\dns_hosts.txt`
- `D:\SNIBypassGUI-v5.2.1\config.ini`

### 将创建的核心文件
- `D:\dev\SniBypass\src\SniBypass.Core\Dns\LocalResolver.cs` - DNS 解析器
- `D:\dev\SniBypass\src\SniBypass.Core\Dns\Redirector.cs` - 重定向器
- `D:\dev\SniBypass\src\SniBypass.Core\Services\ServiceStack.cs` - 服务编排
- `D:\dev\SniBypass\src\SniBypass.Tray\TrayApplicationContext.cs` - 托盘应用

## 时间估算

总计：**9-10 周**（按阶段顺序执行，关键路径为 DNS 子系统）

- P0 基线冻结：0.5 周
- P1 地基：1 周
- P2 DNS 子系统：3-4 周（关键路径）
- P3 编排与平台：1.5 周
- P4 更新与 UI：2 周
- P5 硬化与切替：1 周

## 下一步行动

1. 创建解决方案骨架（`dotnet new sln` + 项目文件）
2. 开始 P0 基线冻结（录制黄金样本）
3. 按阶段顺序实施
4. 每阶段完成后验证，确保功能完整
