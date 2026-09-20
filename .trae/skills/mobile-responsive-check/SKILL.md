---
name: mobile-responsive-check
description: Verify mobile/responsive behavior with real-device Playwright emulation including overflow, layout geometry, font loading, and persistence checks. Use when the user asks to check 移动端/手机端表现, responsive layout, or mobile font switching. Do not use for desktop-only checks.
---

# 移动端真机模拟检查

用 Playwright 做**真实设备模拟**检查，不允许用 `browser_evaluate` 注入样式来"假装"移动端——那种方式 innerWidth 不变、媒体查询不触发，结论不可信。

## 执行步骤

1. 在临时目录准备运行环境（**不要把 playwright 装进项目依赖**）：
   - Windows PowerShell：
     ```powershell
     New-Item -ItemType Directory -Force -Path "$env:TEMP\sg-mobile-check" | Out-Null
     cd "$env:TEMP\sg-mobile-check"; npm init -y | Out-Null; npm i playwright-core
     ```
   - Chromium 自动取 `%LOCALAPPDATA%\ms-playwright\chromium-*`（本机已有）；不存在则设置
     `$env:PLAYWRIGHT_EXECUTABLE_PATH` 指向任意 chrome.exe，或运行 `npx playwright install chromium`。
2. 按本次检查目标编写配置 JSON（参照 [assets/config.example.json](assets/config.example.json)），
   另存到临时目录。默认测三档宽度 390（iPhone）/ 360（安卓主流）/ 320（小屏），可按需覆盖。
3. 从临时目录运行脚本（脚本通过 cwd 解析 playwright-core）：
   ```powershell
   node <workspace>\.trae\skills\mobile-responsive-check\scripts\mobile-check.mjs --config ./check.json
   ```
4. 结果 JSON 输出到 stdout，退出码 0 = 全部通过，1 = 有断言失败。截图存入配置的 `outDir`。
5. **必须实际打开截图查看视觉细节**（用 Read 读图），几何断言发现不了的问题包括：
   标签挤位、左缘错位、留白、字号过小、按钮拥挤。
6. 发现问题 → 修改项目代码 → 重新部署/构建 → 重跑同一配置复验，直到退出码 0 且截图正常。

## 配置说明

- `entry`：打开被测 UI 的按钮选择器；`modal`：弹窗选择器（可选，等待其出现）。
- `targets`：需要检查内部横向溢出的容器选择器列表。
- `steps[]` 支持：`click`（Playwright 选择器，可用 `:has-text()` 与 `>> nth=N`）、
  `reload`、`wait`(ms)、`scroll`、`shot`(文件名)、`overflow`(断言当前无溢出)、
  `expect` 断言（可组合）：
  - `dataFont`：`<html data-font>` 期望值（如 `null` 表示无该属性）
  - `fontReady`：字体族名，用 `document.fonts.check('16px "名字"')` 确认真实加载
  - `storage`：`[localStorage key, 期望值]`，验证偏好持久化
  - `attr`：`[selector, 属性名, 期望值]`；`text`：`[selector, 期望文本]`

## 固定检查项（每次都要覆盖）

- 首页与被测 UI 的 `scrollWidth - innerWidth === 0`（横向溢出，三档宽度都测）
- 控制台无 `[error]`、无 pageerror（第三方 beacon 报错可忽略）
- 卡片/栅格：列数符合预期、同宽、无重叠；弹窗完整落在视口内
- 字体功能：切换后 `data-font` 即时变化 + `fontReady` 为 true；恢复默认后属性移除；
  刷新后 localStorage 偏好保持
- 移动端专属审视：触控主按钮建议 ≥40px 高；≤480px 单列布局；标签类元素不得横挤卡片
