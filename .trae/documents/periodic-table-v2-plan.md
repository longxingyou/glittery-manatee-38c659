# 元素周期表 V2 规划（调研结论 + 任务清单）

> 范围：`/periodic-table`（俄语 / 中文双语）页面。
> 本轮只做调研与规划，不改功能代码。后续按 §3 的阶段顺序推进。

---

## 0. 现状盘点

### 已具备

| 能力 | 说明 |
| --- | --- |
| 四种版面 | 标准长表（`.ru-pt-19`）、Janet 左阶梯（`.ru-pt-33`）、俄语短表（`.ru-pt-short`）、螺旋（`layoutSpiral`） |
| 着色 | 类别 / 相态 / 数值场（11 个字段，含对数色标）/ 温度游标相态 |
| 详情抽屉 | 简介、物理图、热力学、化学、原子半径、电离能、电子结构、同位素、丰度、晶体结构、维基链接 |
| 其它 | RU/CN 切换、俄语 TTS、列表视图、手机横屏全屏、SSR 直出 + 骨架屏 |
| 数据 | `src/lib/elements.json`（值数组 + `FIELDS` 解码），118 条，字段含 `eConf`/`isoKnown`/`abCrust`/`bohrImgUrl`/`spectralImgUrl` 等 |
| 图片 | 118 条 `appearanceImgUrl`：92 条维基原图、26 条 images-of-elements；均为外链，弱网/跨境会失败 |

### 主要缺口（本规划的输入）

1. 图片不是同一图源、不自托管，部分网络下加载不出 → 详情面板缺图或等待久。
2. 螺旋版面不科学：按 z 均匀绕 4.5 圈，未体现周期长度 `2/8/8/18/18/32/32`，同族不对齐。
3. 缺原子结构可视化（电子层 / 轨道）、元素对比、检索、性质趋势图、发现时间轴、测验等学习向功能。
4. 无元素级深链（无法分享 `/periodic-table?el=Fe`）。
5. `bohrImgUrl` / `spectralImgUrl` 字段有数据但页面未使用。

---

## 1. 调研结论

### 1.1 参考项目（8 个链接的核实结果）

| 项目 | 可借鉴亮点 | 价值 | 落地方式 |
| --- | --- | --- | --- |
| [BaotLake/periodic-table-pro](https://github.com/BaotLake/periodic-table-pro) | 详情按「概述/物理/原子/其他/发现/丰度」分区；每元素独立链接；数据按属性拆 JSON | 高 | 详情分区（已接近）+ 元素深链 |
| [SeanWong17/Future-Style-Periodic-Table](https://github.com/SeanWong17/Future-Style-Periodic-Table) | 7 种属性热力图 + 图例筛选；按符号/中英文名/序数搜索高亮；CSS 3D 电子层 | 高 | 搜索、热力图（已有雏形） |
| [Enco-shark/element_web](https://github.com/Enco-shark/element_web) | Three.js 做的 Bohr + s/p/d/f 轨道模型，可拖拽缩放 | 高 | 用 SVG/CSS 复刻，不引入 WebGL |
| [SeokSikcheon/chem-workbench](https://github.com/SeokSikcheon/chem-workbench) | Z 滑块联动电子排布 / 电子云 / 能层；768/480 断点 | 高 | Z 滑块 + 电子层联动 |
| [Zhilips/Zperiod](https://github.com/Zhilips/Zperiod) | 离子库、电荷计算、键盘 ←/→ 翻页；`ru.js` 俄文名/用途/发现年 | 高 | 俄语文案校对、键盘导航 |
| 88lin/Periodic-table-web | 上游 fork，仅 SEO/Docker 改动 | 低 | 不采纳 |
| a937750307/Future-Style-Periodic-Table | 与 #2 同源的转载 | 低 | 不采纳 |
| enco-shark 博客 | #4 的自述，无新增功能 | 低 | 不采纳 |

**汇总值得实现的功能（按优先级）**：Bohr / 轨道模型切换、Z 滑块联动、属性热力图 + 图例筛选、三语搜索高亮、元素对比、性质趋势图、同位素表、发现时间轴、温度相态演示（已有）、元素深链、键盘无障碍导航、测验模式。

### 1.2 图源：images-of-elements.com

已确认：

- URL 规律：元素页 `/<name>.php`；展示图 `/s/<name>.jpg`（400×400，30–125 KB，均值约 57 KB）；缩略图 `/t/<name>.png`；大图 `/<name>.jpg`（1000–1400 px）。
- **覆盖 1–104 号**，每元素 1 张；105–118 只有占位图 `transactinoid.png`。
- 命名不统一：91 个是 `/s/<英文小写名>.jpg`（注意 aluminium / caesium / sulfur / tungsten 拼写），13 个带后缀（如 `titanium-crystal`、`dysprosium-2`、`hydrargyrum`、`tungsten-rod`、`radium-paint`、`actinium-225`、`curium-glow`、`berkelium-ornl`、`californium-disc`、`einsteinium-253`）→ **需要 104 条显式映射表，不能靠规则拼 URL**。
- 授权：站方声明 CC BY 3.0（署名方式为链接元素页），但页面注明例外——**Ac、Pa、Cm、Rf 四张图版权保留，不可使用**；Pu/Cf/Es/Fm/Np 等注明 DOE/ORNL/LANL 公有领域。
- 无禁止热链条款；带外部 Referer 实测 200。

方案（推荐 **自托管**）：

| 项 | 做法 |
| --- | --- |
| 1–104 | 按映射表下载 `/s/*.jpg`；Ac/Pa/Cm/Rf 4 张改用 Wikimedia Commons 的 CC0/公有领域图 |
| 105–118 | 无实物照片，使用统一「示意图占位卡」（不显示空框、不请求网络） |
| 存储 | `public/elements/<z>.webp`（400×400，质量 80；可选 `@2x` 800px）。总量约 2–3 MB，Workers 静态资源限制为单文件 25 MiB、免费版 2 万文件，余量充足 |
| 数据层 | `appearanceImgUrl` 改为本地绝对路径；新增 `imageCredit`（作者 / 许可 / 源页），详情面板渲染许可链接 |
| 加载 | `loading="lazy"`、`width/height` 固定 1:1 防抖动、失败时整卡隐藏（沿用现有 `AppearanceImage`） |

### 1.3 螺旋版面：改为 Janet 32 列极坐标螺旋

现实现的缺陷：z 均匀分布 → 周期长度、族对齐全部丢失。

推荐规则（可实现、可验证）：

- 8 行（周期），行长度 `L = [2, 2, 8, 8, 18, 18, 32, 32]`；
- 行内第 i 个元素占据 32 列中的第 `c = 32 − L + i` 列（s 区靠右，再向左依次 p / d / f）；
- 极坐标：`θ = −90° + 360° × (c + 0.5) / 32`，`ρ = ρ0 + (r − 1) × Δρ`；
- 每行只绘制 `c ∈ [32 − L, 31]` 的弧段，行末到下一行首画一段外扩连接线（Benfey 式「蜗牛」观感，但角度规则严格）；
- 同族自动共线（列号相同 → 角度相同），族号可反推：`c ≥ 30 → 1–2 族`，`14 ≤ c ≤ 29 → 3–18 族`，`c < 14 → f 区`；
- 校验点：第 7 行 La(57)…Ra(88)，第 8 行 Ac(89)…Og(118)；Lu / Lr 落在 3 族列；He 位于 Be 上方（2 族列，需在说明里注明争议）。

备选（不推荐）：Benfey 1964 主环每圈 8 个元素 + d/f 半岛；Chemical Galaxy 椭圆连续螺旋（官方角度未公开，难以精确复刻）；Stowe 三维晶格（2D 无法忠实表达）。

### 1.4 数据源评估

| 字段 | 推荐来源 | 可离线打包 |
| --- | --- | --- |
| 基础数值（现用） | Bowserinator JSON + PubChem 校验 | 是 |
| 电子排布（含例外） | mendeleev `econf`（MIT） | 是（构建期导出） |
| 同位素（质量/丰度/半衰期） | mendeleev `isotopes`，抽样对照 NUBASE2020 | 是 |
| 氧化态 / 发现者 / 年份 / 丰度 / 晶格 | mendeleev 同名字段 | 是 |
| 宇宙丰度 | Asplund 2021 手工录入 | 是 |
| 光谱线 | NIST ASD CSV 快照（只取持久线前 N 条） | 是（快照，不做运行时请求） |
| 多语言名称 | Wikidata labels + 中俄维基校对 | 是 |
| 读音 | Wiktionary IPA / Forvo（无结构化源） | 半自动 |

结论：**构建期用 mendeleev 生成静态 JSON**，运行时零外部依赖（符合 Workers 架构与配额约束）。

---

## 2. 阶段规划

### P0-A 全部元素配图（自托管）

- 新增 `scripts/fetch-element-images.mjs`：
  1. 内置 104 条 `z → slug` 映射（含 13 个后缀变体）；
  2. 下载 `/s/<slug>.jpg`，校验 200 且为 JPEG；
  3. Ac/Pa/Cm/Rf 从 Commons 取公有领域图（脚本中写死直链 + 许可）；
  4. 转 WebP（优先 `sharp`；若不想加依赖，先直接落地 400px JPEG，总量约 6 MB 也可接受）；
  5. 生成 `src/lib/element-images.json`：`{ z: { src, credit, license, sourceUrl } }`。
- 数据层：`elements.ts` 合并该表覆盖 `appearanceImgUrl` / 新增署名；105–118 标记 `placeholder: true`。
- 详情面板：占位卡显示元素符号 + 「暂无实物照片」；有图时显示来源与许可链接。
- 验收：
  - 118 个元素详情**零外链请求**（DevTools 无 `upload.wikimedia.org` / `images-of-elements.com`）；
  - 断网模拟下不出现空框；
  - `public/elements/` 增量 < 3 MB（JPEG 方案 < 7 MB）；
  - 首次打开详情图片 < 300 ms（同一 CDN）。

### P0-B 螺旋版面重做（Janet 32 列）

- 用 `layoutSpiralJanet()` 替换 `layoutSpiral()`，返回 `{z, θ, ρ, row, col}`。
- SVG 渲染：每行一段圆弧（`path` 弧线）+ 行间连接线；节点仍用现有 `<button class="ru-el spiral">`，保留点击/着色/高亮。
- 叠加：族号（1–18）沿外圈标注、周期号沿辐条标注；hover 时同族整列高亮。
- 说明文字：注明「Janet 左阶梯螺旋（1928）」，并解释 He / La-Lu 的归类差异。
- 验收：8 行长度与周期一致；同族角度完全一致；La(57) 与 Ac(89) 位置正确；点击与着色不回归。

### P1-A 原子结构可视化

- **Bohr 模型**（SVG）：按 `shells` 解析每层电子数，核 + 轨道圆环 + 电子点，CSS 关键帧缓慢旋转；支持「暂停/播放」。
- **轨道模型**（SVG/CSS 3D）：s 球、p 哑铃、d 四叶、f 复杂形示意；用 CSS `transform-style: preserve-3d` 拖拽旋转，不引入 Three.js（避免 +600 KB chunk）。
- 电子排布文本与「能级方块图」（`1s²2s²…` 拆成小格）并列展示。
- 验收：118 个元素均可渲染；低端机关闭动画（`prefers-reduced-motion`）；单元素切换 < 16 ms。

### P1-B 检索 / 对比 / 深链

- 搜索框：符号、序号、中文、俄文、英文子串匹配；匹配项高亮、其余降透明度；`Ctrl/⌘+K` 聚焦；`Esc` 清除。
- 元素对比：详情面板加「加入对比」，最多 4 个，底部对比条 → 对比视图（属性表 + 归一化柱状图）。
- 深链：`/periodic-table?el=Fe`（读写 URL，SSR 打开时直接选中）；每元素 `<title>` / meta 同步；「复制链接」按钮。
- 验收：刷新后仍选中同一元素；搜索 0 延迟（纯前端）；URL 可分享。

### P2-A 图表与时间轴

- 性质趋势图：横轴周期或族，纵轴所选字段（沿用现有 11 个数值字段），SVG 折线 + 点，点击跳到元素。
- 发现时间轴：1550–2010 横向时间轴，按年份排布，按类别着色，点击打开详情。
- 同位素表：从 mendeleev 构建期导出（质量数、丰度、半衰期、衰变方式），表格可排序。
- 光谱线（可选）：NIST ASD 快照，画可见光波段竖线；无数据则不显示。

### P2-B 学习工具（可选）

- 测验模式：符号 ↔ 名称（俄/中）、电子排布填空、周期/族判断；计分与错题回顾。
- 键盘导航：网格内方向键移动焦点，`Enter` 打开详情（参考 Zperiod）。
- 温度演示增强：拖到相变点显示融化/沸腾提示（现有温度游标升级）。

### P3 数据与内容完善

- 构建期脚本 `scripts/build-elements-data.mjs`：mendeleev → 静态 JSON（电子排布例外、氧化态、同位素、丰度、晶格）。
- 三语文案校对：元素名、类别名、属性名、说明句（俄语用 Zperiod `ru.js` 与俄维基交叉核对）。
- 无障碍：`aria-label` 全覆盖、焦点环、对比度检查、`prefers-reduced-motion`。
- 性能：周期表 chunk 预算 ≤ 80 KB（brotli）；图片不进首屏；图表按需加载。

---

## 3. 实施顺序与依赖

1. P0-A 图片管线（独立，先做，收益最直接）
2. P0-B 螺旋重做（独立，纯函数 + SVG）
3. P1-B 搜索 + 深链（为后续功能提供入口）
4. P1-A 原子结构可视化（依赖详情面板）
5. P2-A 趋势图 / 时间轴 / 同位素（依赖 P3 的 mendeleev 数据）
6. P3 数据补全与文案校对（可与 5 并行）
7. P2-B 学习工具（最后）

## 4. 全局验收

- `npm run typecheck` 通过；`npm run build` 产物无新增 > 100 KB 的同步 chunk。
- 375 / 414 / 768 / 1440 四档无横向溢出；俄语长名仍单行。
- 详情面板零外链图片；弱网（拦截第三方域）下功能完整。
- 不新增运行时外部 API 依赖（图片、数据均自托管/静态）。

## 5. 已确认决策（2026-11-17）

| # | 决策 | 结论 |
| --- | --- | --- |
| 1 | 图片自托管 vs 继续热链 | **自托管**（`public/elements/<z>.<ext>`，同 CDN、可缓存、零外链） |
| 2 | 105–118 无实物图 | **中性占位卡**（符号 + 序号 + 说明），不请求网络 |
| 3 | 螺旋形态 | **Janet 32 列左阶梯螺旋**（已落地于 `src/lib/spiral.ts`） |
| 4 | 3D 原子模型 | **SVG/CSS 为默认**；另提供 Three.js 增强开关（默认关闭，需明确交互提示与降级） |
| 5 | 学习工具（测验/离子） | 先做测验，离子/溶解性工具另立需求 |

### P0 完成记录（2026-11-17）

- `scripts/fetch-element-images.mjs`：按元素页抓首图，1–104 全部自托管；Ac/Pa/Cm 换 Commons 图（含许可与作者）；Rf 与 105–118 标记占位。
- `public/elements/`：103 张（JPEG/PNG，约 8.1 MiB）；`src/lib/element-images.json` 记录 title / credit / license / sourceUrl。
- `worker.ts`：静态资源白名单补 `/elements/`（否则请求落到 SSR 404）。
- 详情面板：图片卡显示署名与许可链接；无图元素显示设计占位卡；修复 `loading="lazy"` 导致隐藏容器内图片永不加载的问题（改为骨架 + 立即加载）。
- 螺旋：`layoutSpiralJanet()` + SVG 周期弧线、行间连接线、族号（1–18）、周期号、中心 Janet 1928 标记；实测 604px 容器下圆心最小距 23.7px > 节点直径 20px。

### P1 完成记录（2026-11-17）

**P1-B 检索 / 对比 / 深链**

- 深链：`/periodic-table?el=Fe`（也接受 `?el=26`）。`router.tsx` 增加 `validateSearch`；`PeriodicTable` 用 `useSearch` 在 SSR 首帧初始化选中项，选中/关闭时 `history.replaceState` 同步 `?el=`；进入时把选中格滚到可视区；`document.title` 同步元素名。
- 修复缓存串味：`worker.ts` 的 HTML 三级缓存键只含 pathname，`?el=Fe` 的 HTML 曾命中给 `?el=Cu`，触发 React 水合不一致（实测）。现深链请求绕过预渲染快照与三级缓存，并返回 `Cache-Control: private, no-store`。
- 检索：符号 / 序号（子串）/ 中俄英名称，匹配项加描边、其余 `.dimmed`；显示命中数 `n/118`；~~Ctrl/⌘+K 聚焦~~ → P3 改为 `/` 聚焦（Ctrl/⌘K 固定归站点全局搜索），Esc 清空、Enter 选中首个命中。
- 对比：详情面板「加入对比」，最多 4 个；吸底对比条（移除/查看/清空）；对比视图为 2–4 列属性表（类别、周期/族、原子量、熔点、沸点、密度、电负性、电子亲合能、价电子、共价半径、导热、发现年份），数值附带相对条形图；Esc/遮罩/✕ 关闭。
- 详情面板新增「复制链接」按钮（Clipboard API，失败回退 `execCommand`）。

**P1-A 原子结构可视化**

- 详情面板新增「原子模型」：Bohr（`shells` 解析为核 + 环 + 电子点，CSS 旋转，可暂停）、轨道形状（s 球 / p 哑铃 / d 四叶 / f 六叶，CSS `preserve-3d` + 拖拽旋转）、能级方块图（解析 `eConf`，按洪特规则画 ↑ / ↑↓）。
- Three.js 增强：默认不加载；点击「启动 3D 模型」才 `import('three')`，渲染核 + 倾斜电子环 + 电子点，支持暂停/元素切换重建/卸载释放；加载失败可重试并提示退回 SVG 视图。构建产物中 three 为独立懒加载 chunk（约 1.6 MB，未进入首屏）。
- 动画遵循 `prefers-reduced-motion`（全局规则已将动画时长压到 0.01ms）。

**验证**

- `npm run typecheck`、`npm run build` 通过。
- Playwright（Edge）：深链 SSR 与水合零报错；搜索 1 命中/117 降透明；对比表 12 行；Bohr 4 环 26 电子；能级 7 格；3D canvas 正常创建；375px 下文档与表格横向溢出均为 0。


### P2 完成记录（2026-11-17）

**P2-A 趋势图 / 时间轴 / 同位素概要**

- 性质趋势图（控制栏「📈 趋势」）：11 个数值字段下拉、三种横轴（按 Z / 按族 / 按周期）、可切换对数轴；SVG 折线按空缺自动断段，点按类别着色，点击或 Enter 打开详情；按族模式只取 La/Ac 以免 14 个 f 区元素重叠，并附 P1–P7 图例。
- 发现时间轴（「⏳ 时间轴」）：公元前–1500 的「古代」桶单列展示，1500–2010 按十年分桶向上堆叠；年份刻度到 1950 + 2010；圆点按类别着色，点击打开详情；窄屏容器可横向滚动，并默认滚到 19 世纪发现密集区。
- 同位素概要：详情面板改为「已知数 / 稳定数 / 稳定核素列表 / 半衰期（最稳定，年→天/时/分自动换算）/ 天然丰度」+ 稳定占比条；移除原先直接在基础信息区显示英文 `Stable` 的重复行。逐核素质量数、丰度、衰变方式仍留待 P3 的 mendeleev 构建期导出，本轮不伪造表格。光谱线因无本地数据未做，保持「无数据则不显示」。

**P2-B 学习工具**

- 键盘导航：标准 / 短表 / 左阶梯三种网格支持方向键按坐标移动焦点（同向最近、优先直线），Enter/Space 原生打开详情；短表 f 区条带可向下进入；螺旋版面保留 Tab 顺序。
- 温度相变提示：温度游标 ±5 K 内命中熔点/沸点时，图例区列出元素与「熔化 / 沸腾」快捷按钮。
- 测验（「🎯 测验」）：每次 10 题，符号→名称、名称→符号、周期/族三类轮换（随 RU/CN 语言）；四选一即时判定、进度条、计分、错题回顾可点开对应元素；Esc/遮罩关闭。

**实现位置**

- 组件与逻辑均在 `src/components/periodic-table.tsx`（`TrendChart`、`DiscoveryTimeline`、`QuizModal`、`buildQuiz`、`fmtHalfLife`、`isotopeSummary`）；样式追加在 `src/styles.css` 周期表段落末尾（`.ru-trend*`、`.ru-tl*`、`.ru-iso-bar`、`.ru-el-phase-hint`、`.ru-quiz-*`）。
- 新增状态默认关闭，首帧不读 `window`/`localStorage`，SSR 与水合保持一致；无新增运行时外链。

**验证**

- `npm run typecheck`、`npm run build` 通过；主 chunk 76.6 KB gzip。
- Playwright（Edge，localhost）：趋势图 100 个电负性点、按族 7 条线、按周期 ≥10 条线；时间轴 118 点；点击图表/时间轴进入详情并写入 `?el=`；方向键 Fe→Co→Rh、Enter 打开详情；温度 1538 °C 出现 Fe 熔化提示；测验 10 题完成并关闭；`?el=Fe` 深链 SSR 正常且标题含 Fe；375 px 文档与表格横向溢出均为 0，桌面/移动端控制台与 React 水合零报错。

### P2.1 反馈修复（2026-11-17）

**问题与根因**

- 俄语窄屏下 RU/CN 切换键点不到：标题行 `.ru-el-head` 不换行，俄语标题「Периодическая таблица」把标题行 min-content 撑到 305–317 px；面板是隐式单列 grid，自动列宽被顶开后整块内容溢出圆角边框，320 px 下 CN 按钮右边界到 350 px，被 `.workbench { overflow: clip }` 裁掉。
- 俄语工具箱标签栏右侧显示不全：`.ru-tabs` 用 `margin: 4px -16px 0` 出血，但该栏有时直接挂在无内边距容器下，320 px 下整条扩大到 352 px（左 −16 / 右 336），被裁切。
- 周期表偶发加载慢且全程不可交互：React.lazy 的独立 chunk 请求失败后只重试两次便永久停在 fallback；部署窗口内浏览器旧 HTML（`max-age=120`）引用已删除的旧 hash chunk 时必然复现。

**修复**

- `.panel` 增加 `min-width: 0`，并新增 `.panel > * { min-width: 0 }`，防止任一不换行子项把面板网格列顶开（全局生效，覆盖用户反馈的其他页面同类问题）。
- `.ru-el-head` 允许换行（`flex-wrap` + 行间距），`h2` 允许在长词内断行；≤520 px 时标题独占一行，并给周期表面板加 `ru-pt-panel` 类收窄内边距。
- `.ru-tabs` 取消负外边距出血，保留 16 px 内边距与横向滚动。
- 周期表 lazy 加载在两次重试后整页刷新一次（`sessionStorage` 记录时间戳，60 秒内不重复），用于从「旧 HTML + 已删除 chunk」的死局自愈。

**验证**

- 320 / 360 / 375 / 414 px：`document.scrollWidth` 与 `.editor-area.scrollWidth` 均等于视口宽；`.ru-el-head`、`.panel` 无自身溢出；RU/CN 按钮右边界在视口内，点击可正常在中俄界面间切换。
- 趋势图 / 时间轴 / 测验在 320 px 下无越界；`/russian`、`/lessons`、`/share`、`/xdnmb`、`/c233`、文章页在 320 px 下均无横向溢出。
- `pnpm typecheck`、`pnpm build` 通过；本地水合与交互零控制台报错。

## 6. 风险



- **版权**：images-of-elements 有 4 张例外图；Commons 图片需逐张记录许可与作者，脚本需生成可审计的 credits 文件。
- **抓取稳定性**：站点无 API，需一次性下载后入库，避免构建期依赖网络（脚本只在手动执行时联网）。
- **图片体积**：不转 WebP 时约 6 MB；若后续要 800px @2x，需评估仓库与部署时长。
- **螺旋可读性**：32 列螺旋内圈文字密集，需在窄屏降级为「仅符号 + 序号」，详情仍需点击查看。

### P3 完成记录（2026-11-18）

**语言分层（解决与全站语言切换的语义冲突）**

- 周期表界面文案改为跟随全站 `useLang()`（中/英/俄），元素名称、分类名、属性名改由表内「名称语言」控件控制：`跟随 / 中 / EN / RU`，覆盖值存 `sg-pt-el-lang`，默认跟随界面。两者独立，俄语界面也能把元素名显示成中文或英文。
- 移除旧的二元 `RU/CN` 状态与 `sg-ru-pt-ver` 键（挂载时清理）；偏好直接写入 localStorage，避开 React StrictMode 挂载 effect 把恢复值覆盖回默认的问题。
- 全量英文：按钮、图例、属性、趋势图、时间轴、测验、详情、3D、搜索、空状态全部补齐 en；晶系名称（14 种）本地化；维基英文摘要只在该元素语言为英文时显示，中/俄文用本地化事实句替代，避免语言错位。

**快捷键（与站点搜索解耦）**

- 周期表：`/` 聚焦表内元素搜索，`Ctrl/⌘+K` 不再拦截，固定打开全站搜索；搜索框 `<kbd>` 提示改为 `/`；Enter 打开首个命中，Shift+Enter 朗读；Esc 清空查询。
- 匿名版（`xdnmb-browser.tsx`）同样把 `Ctrl/⌘+K` 改为 `/`，全站搜索快捷键在所有页面语义一致。

**无障碍与交互**

- 颜色模式、区块、版面、列表视图、趋势/时间轴开关补 `aria-pressed`；命中数 `aria-live="polite"`。
- Esc 分级收起：测验 → 对比视图 → 详情抽屉；Home / End 跳到 H / Og；元素名与详情标题带 `lang` 属性，避免跨语言朗读错误。
- 详情面板补「常见氧化态」行（源数据 `ox`，此前未展示）。

**窄屏俄语**

- `.ru-el-head` 窄屏下名称语言控件独占一行，按钮等分宽度；`styles.css` 追加全站安全网：文本叶子节点 `overflow-wrap: anywhere`，面板/编辑器/卡片子容器 `min-width: 0`，窄屏按钮/元信息行允许换行（不作用于 `code/pre`）。
- Playwright 375 px 俄语界面 `html/body scrollWidth = 375`，无横向溢出。

**验证**

- `pnpm exec tsc --noEmit`、`pnpm run build` 通过。
- Playwright（Edge，localhost）17/17：英文界面标题/Hydrogen、切 RU 后 `Водород` 且界面仍英文、刷新后偏好保留、`Ctrl+K` 打开全站搜索、`/` 聚焦元素搜索、俄语查询命中、Esc 清空/关闭详情、375 px 俄语无溢出、控制台零报错。

**未完成**

- ~~逐核素质量数 / 丰度 / 衰变方式仍需 mendeleev 构建期导出~~ → 已由 `src/lib/isotopes.json` + 详情面板逐核素表补齐（2026-11-20 复核）。
- 周期表 chunk 原始体积约 359 KB（内含 118 元素全量数据），brotli 后仍在预算附近；如需进一步压缩，可把同位素/晶格等冷字段拆成按需 JSON。

---

## 7. 外部产品调研与二次吸收（2026-11-20）

### 7.1 参考对象与取舍

| 产品 | 值得吸收的点 | 本轮处置 |
| --- | --- | --- |
| [Ptable](https://ptable.com/about/) | 选中属性替换格子里的原子量；悬停即时读数；`>1000` / `400-800` 数值检索；发现年份“时间机器”；同位素扇形卡组；温度/相态滑杆 | 已落地前四项；同位素表此前已在 P3 完成 |
| [Claude 交互可视化](https://claude.com/it/resources/articles/claude-builds-visuals) | 内联、可点击、可继续调整的周期表；把“变量”交给用户 | 阈值滑杆 + 时间机器 |
| [ChatGPT 动态科学解释](https://www.subvolts.com/openai/official/blog/new-ways-to-learn-math-and-science-in-chatgpt-88306b/) | 调变量后图形立即变化 | 同上，强调即时反馈 |
| [Gemini Notebook](https://workspaceupdates.googleblog.com/2026/11/transform-your-notes-and-research-into-dynamic-tools-with-Gemini-Notebook.html?m=1) | 一句话生成可交互周期表/时间轴站点 | 沿用现有四版面 + 多视图，不引入生成式 UI |
| [Talbica](https://competition.adesignaward.com/147631) | 60+ 属性信息图、动画原子模型、半径/晶体示意、热力图、实物图 | 已有 Bohr/轨道/能级/3D/实物图；补格内数值条 |
| [PubChem](https://pubchem.ncbi.nlm.nih.gov/docs/periodic-table-element-pages) | 表格 / 列表 / 游戏三视图；Z、符号、名称深链 | 已有 |
| [RSC](https://www.rsc.org/about-us/explore-our-websites) | 稀缺度、发现史、播客视频、趋势 | 仅加权威外链；稀缺度无数据，不伪造 |
| [Theodore Gray](https://theodoregray.com/PeriodicTable/index6A.html) | 360° 样品、视频、声音、拼元素游戏、配平反应 | 资产与数据不足，暂不做 |
| [Wolfram GPT](https://www.wolfram.com/wolfram-plugin-chatgpt/) | 计算型问答 + 权威数据 | 不做运行时 LLM；数值检索本地化 |

### 7.2 本轮新增

- **格内数值 + 数据条**：数值字段模式下可把当前属性值写进每个格子，底部 2px 数据条按字段归一化（对数模式按 log10）；偏好存 `sg-pt-cell-value`。
- **数值表达式检索**：`>1000`、`<=300`、`400-800`、`~200`、`=3`，作用于当前数值字段；纯数字仍按序号/名称搜索，不抢原有行为。提示条显示字段名、单位与 118 命中数，并可一键切到数值字段模式。
- **桌面悬停速览**：≥1240px 时鼠标移入/键盘聚焦在右侧空栏显示符号、类别、原子量、熔点、沸点、密度、电负性、发现年份、电子构型；不朗读、不打断点击详情。
- **时间机器**：嵌入现有“时间轴”面板，1500–2015 滑杆 + 时间轴游标；未到年份的元素变淡，古代元素保留，按钮显示当前年份。
- **属性阈值滑杆**：数值字段模式下按当前字段设下限，低于阈值变淡；离开数值字段模式自动清除，避免隐藏过滤。
- **权威外链**：详情页新增 RSC / PubChem / WebElements 元素页。
- **打印模式**：A4 横向命名页 `ru-pt`，只输出周期表本身，保留图例与色阶；控件、搜索、详情、趋势/时间轴全部隐藏。

### 7.3 仍未做

- 化合物混合 / 3D 分子：缺化合物数据集与授权模型。
- 元素视频、播客、360° 可旋转样品：缺授权资产。
- 稀缺度 SRI：缺权威指数，不用地壳丰度代替。
- PWA 离线：与当前 Worker/Postgres 架构关系不大，暂缓。

### 7.4 验证记录

- `npm run typecheck`、`npm run build` 通过。
- Playwright 1440×900：悬停 Fe 出现速览；打印媒体下侧栏/控件隐藏、118 格完整；PDF MediaBox `842×595`（A4 横向）。
- Playwright 390×844：`scrollWidth = innerWidth`，无横向溢出；点击 Fe 打开详情抽屉。
- 浏览器代理：格内数值、`>2` 数值检索（30/118）、时间机器 1800（33/118）、阈值 ≥2 均通过，控制台无新增错误。
