# 把旧版「功能齐全设置面板」整合进重构版 SNIBypassGUI

## Context（为什么做）

重构版（`D:\dev\SniBypass`，C#/.NET 10）目前只有 4 页的精简设置面板（常规/服务/更新/关于），
用户原先在 `D:\SNIBypassGUI-v5.2.1\hardening\` 下的完整面板（站点管理、策略中心、诊断与修复、
备份与恢复、支持的站点、高级优化、外部引擎）以及 Guard / Audit / Cleanup 等安全脚本入口都找不到了。

本次目标：把 `hardening\SgPanel.cs`（6696 行、已验证可用的 WinForms 面板）**原生并入**重构版主程序，
让它从托盘和设置面板一键打开；同时修掉旧版依赖 C++ 托盘窗口 `PostMessage` 的脆弱实现，
改用主程序的服务控制委托，并把「安全脚本状态/操作」保留在高级优化页，做到功能不缩水、稳定性更好。

已确认的事实（调研结论）：

- `SgPanel.cs` 完全自包含，只依赖 BCL + WinForms，不引用任何 `SniBypass.*` 命名空间。
- 唯一的硬阻塞：`using System.Web.Script.Serialization;` 与 9 处 `JavaScriptSerializer`
  （行 601/1600/1674/1904/1919/1951/2616/3580/3860/3866），.NET 10 已移除该程序集。
- `SgPaths` 假定 exe 位于 `hardening\` 下（`Path.GetDirectoryName(Application.ExecutablePath)`）。
- 旧版启动/停止/重启服务靠 `PostMessage` 给窗口类 `SNIBypassGUI_TrayWnd` 发 2005/2006；
  新版托盘是 WinForms `NotifyIcon`，没有该窗口类 → 必须改为宿主注入委托。
- 新版主程序启动即提权（`Program.Main` → `Elevation.RelaunchElevated`），面板无需再自行提权。
- `AppController.Start/Stop` 是后台线程执行（不阻塞 UI）；`ServiceStack.Stop()` 会同步等待子进程退出。
- 主程序 exe 名为 `SNIBypassGUI.exe`，因此旧面板按进程名做的「程序是否运行」判断仍然成立。

## 方案（推荐并采用）

新增独立类库 `SniBypass.SecurityPanel`（`Nullable=disable`、不启用警告即错误）承载旧面板代码，
避免 6696 行遗留代码污染 `SniBypass.Tray` 的严格编译设置；托盘项目引用它并注入服务控制委托。

### 1. 新建项目 `src\SniBypass.SecurityPanel\SniBypass.SecurityPanel.csproj`

- `net10.0-windows`、`UseWindowsForms=true`、`OutputType=Library`、`Nullable=disable`、
  `ImplicitUsings=disable`、`RootNamespace=SgPanel`、`AssemblyName=SniBypass.SecurityPanel`。
- `NoWarn` 容纳遗留代码的过时 API 警告（SYSLIB0014 等），不设 `TreatWarningsAsErrors`。
- 加入 `SniBypass.sln`：新 GUID `{12345678-1234-1234-1234-123456789017}`，
  Project 块与 `ProjectConfigurationPlatforms` 按现有 5 个项目的格式各补 4 行。

### 2. 复制并适配 `SgPanel.cs` → `src\SniBypass.SecurityPanel\SgPanel.cs`

保留 `namespace SgPanel`（与主程序无命名冲突），只做以下最小改动：

1. **JSON 兼容层**：删除 `using System.Web.Script.Serialization;`，在命名空间内新增
   `internal sealed class JavaScriptSerializer`（`Deserialize<T>` / `Serialize`），
   基于 `System.Text.Json` 实现；数值优先 `long`/`decimal`、其余 `double`，
   容器转换 `JsonElement → Dictionary<string,object>` / `object[]`，
   序列化用 `JavaScriptEncoder.UnsafeRelaxedJsonEscaping` 保留中文原文。
   这样 9 处调用点完全不用改，浏览器 Preferences 往返读写也不会破坏原文件语义。
2. **路径解析**：`SgPaths` 改为
   `SgRoot = AppContext.BaseDirectory`（若其下无 `data` 则回退到父目录，兼容独立运行），
   `Hardening = SgRoot\hardening`（不存在则回退到 exe 目录）。
   其余 `DataDir/SniToml/DnsHosts/Supported/SitesDir/Nginx/BackupRoot/StateFile/GuardLog/PayloadBaseline/CleanupScript/EnginesDir` 保持不变。
3. **删除 `Program` 类（含 `Main`）**，避免与主程序入口冲突/重复提权。
4. **新增宿主集成点**（同文件内，命名空间可见）：
   ```csharp
   public static class SecurityPanelHost
   {
       public static Action? StartServices { get; set; }
       public static Action? StopServices { get; set; }
       public static Action? ShowTrayMenu { get; set; }
       public static bool IsHosted => StartServices != null;
       public static void Show(IWin32Window? owner);   // 单实例，已开则激活
   }
   ```
5. **替换 PostMessage 路径**（仅在 `IsHosted` 时走委托，保留独立运行回退）：
   - `RestartServices`：`StopServices()` → 轮询 `CountServiceProcesses()` → `StartServices()`；
     失败回滚 toml 逻辑保持原样。
   - `SendServiceCommand`（启动/停止按钮）：改为调用 `StartServices/StopServices`。
   - `ShowTrayMenu`（弹出托盘菜单按钮）：改为 `ShowTrayMenu()`。
   - `EnsureAppRunning`：`IsHosted` 直接返回 true；`GetTrayHwnd`：`IsHosted` 返回 `IntPtr.Zero`。
6. **协议入口改进**：`RegisterProtocol` 的 `snibpanel://` 由「`schtasks /run /tn "SNIBypassGUI Panel"`」
   改为直接启动 `"<SgRoot>\SNIBypassGUI.exe" --security-panel`，删除对可能不存在的计划任务的依赖。

### 3. 主程序接线（`src\SniBypass.Tray`）

- `SniBypass.Tray.csproj` 增加 `<ProjectReference Include="..\SniBypass.SecurityPanel\SniBypass.SecurityPanel.csproj" />`。
- `TrayApplicationContext`：
  - 构造时注入 `SecurityPanelHost.StartServices = _controller.Start;`
    `StopServices = _controller.Stop;`
    `ShowTrayMenu = () => PostToUi(...RebuildMenu + ContextMenuStrip.Show(Cursor.Position))`。
  - 新增 `public void OpenSecurityPanel()` → `SecurityPanelHost.Show(this)`（UI 线程）。
  - 托盘菜单在「设置…」下方新增一项「安全与站点面板…」，点击打开完整面板。
- `SettingsForm`：新增第 5 个 Tab「安全与加固」，内含
  - 说明标签（站点管理/策略中心/诊断修复/备份恢复/高级优化/外部引擎、Guard 与 Audit 状态）；
  - 按钮「打开安全与站点面板…」→ 调用外部打开（由 `TrayApplicationContext` 提供静态入口或传入委托）；
  - 按钮「打开 hardening 目录」→ `explorer.exe` 定位日志与脚本。
  - `I18n.cs` 增补对应中英文键（沿用现有 `settings.*` 命名）。
- `Program.cs`：识别 `--security-panel` 参数，在托盘上下文创建后立即打开完整面板
  （供 `snibpanel://` 与「支持的网站 → 设置面板」菜单项复用）。

### 4. 部署与文档

- Release 构建 → 复制 `SNIBypassGUI.exe` 到 `D:\SNIBypassGUI-v5.2.1\`（保留 `data\`、`hardening\`、配置与计划任务）。
- `docs\重构最终报告.md` 新增「第十一节 设置面板整合」，说明架构、迁移点、验证结果。

## 验证

1. `dotnet build D:\dev\SniBypass\SniBypass.sln -c Release`：0 错误 0 警告（Tray/Core 仍保持严格）。
2. `dotnet test`：既有 191 项全部通过（本次不改 Core 逻辑，仅新增 UI 类库）。
3. 实机启动（用 `Invoke-CimMethod Win32_Process Create` 脱离进程树）：
   - 托盘右键出现「安全与站点面板…」，打开后 7 个 Tab 均可切换、无异常；
   - 面板点「启动服务/停止服务/重启」后，`nginx`、`sni-gate` 进程数与状态栏随之变化；
   - 高级优化页能看到 Guard / Audit 计划任务状态、配置基线（payload-baseline）、CA 指纹；
   - `snibpanel://` 可拉起主程序并直接打开面板。
4. 确认 `hardening\guard.log`、`alerts.log`、`custom-state.json` 读写位置正确，未影响原有脚本。

## 风险与对策

- 6696 行遗留代码在 .NET 10 可能有个别编译错误：先独立类库编译，按错误逐条最小修复（不改业务逻辑）。
- 面板首次打开会做网络探测（DoH/ECH），无网络时只会显示「失败」不影响使用；
  所有写操作沿用旧版「先备份再写入」的既有实现。
- 整合后不再需要 `hardening\SgPanel.exe`，但本次不删除，保留回退能力；确认稳定后可再清理。
