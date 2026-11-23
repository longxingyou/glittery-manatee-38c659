# 桌面端元素面板可见性 + 首屏加载优化

## Context

用户反馈两件事：电脑上点元素"没反应"，手机上正常；电脑和手机首次加载都慢。

已取证：

- **"没反应"不是事件失效**。点击后 `.ru-el` 已加上 `sel` 类、`.ru-el-detail-panel` 已渲染、无 console 报错。但桌面端该面板是普通文档流（`margin-top: 12px`），排在表格下方约 500px 处，完全在视口之外；只有 `@media (max-width: 720px)` 才改成 `position: fixed` 底部抽屉，因此手机正常。
- **首屏约 1.82MB**：入口 JS 931KB、周期表 chunk 298KB、KaTeX JS 256KB、CSS 278KB。周期表页完全不用 KaTeX，却仍被加载。`src/lib/elements.json` 318KB 是周期表 chunk 的主体（对象字面量，键名重复 118 次）。

已确认的决策：桌面端采用**右侧常驻吸附侧栏**；性能侧做**已验证的安全项 + 压缩元素数据集**。

## 1. 桌面端：详情面板改为右侧常驻侧栏

文件：`src/components/periodic-table.tsx`、`src/styles.css`

### JSX（`periodic-table.tsx` 约 928–949 行）

把"网格/螺旋/列表"与"选中面板"包进统一的 `.ru-pt-main` 容器；未选中时在宽屏放一个占位块，避免选中/取消时表格宽度跳动：

```tsx
<div className="ru-pt-main">
  <div className="ru-pt-main-body">
    {listView ? <ListView /> : layoutMode === 'spiral' ? (/* 现有 */) : (/* 现有 ru-pt-wrap */)}
  </div>
  {sel ? (
    <DetailPanel e={sel} />
  ) : (
    <aside className="ru-el-detail-placeholder">
      {ver === 'cn' ? '点击任意元素查看详细属性' : 'Нажмите на элемент, чтобы увидеть свойства'}
    </aside>
  )}
</div>
```

`gridWrapRef`、`DetailPanel` 内部结构、`say()` 逻辑都不动。

### CSS（`styles.css`）

```css
.ru-pt-main { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; align-items: start; }
.ru-el-detail-placeholder { display: none; }

@media (min-width: 1240px) {
  .ru-pt-main { grid-template-columns: minmax(0, 1fr) 320px; }
  .ru-el-detail-placeholder {
    display: block; padding: 16px; border: 1px dashed var(--line); border-radius: 10px;
    color: var(--muted); font-size: 12px; line-height: 1.5;
  }
  .ru-el-detail-panel {
    margin-top: 0; position: sticky; top: 8px;
    max-height: calc(100vh - 56px); overflow-y: auto;
  }
}
```

- 把现有底部抽屉断点由 `max-width: 720px` 放宽到 `max-width: 1239px`（仅针对 `.ru-el-detail-panel`，其余移动端规则保持 720px）。这样 721–1239px 也不会再出现"面板在视口外"。
- 1240px 断点理由：容器 padding 28px + 侧栏 320px + 间距 12px，1440/1280 宽屏下标准表仍有约 880–1060px 可用，不会触发横向滚动。
- `.ru-el:hover` 的 `transform` 与 `z-index` 不动；sticky 只作用于 `.ru-el-detail-panel`。

### 断点回归风险

若 1240px 下标准表出现横向滚动条，回退方案：侧栏宽度改 288px，或把 `.ru-pt-19` 最小列宽下调 4px。验证时以浏览器实测 `scrollWidth <= clientWidth` 为准。

## 2. 性能：把 KaTeX / Markdown 移出全站首屏

文件：`src/routes/__root.tsx`、`src/lib/markdown-math.ts`、`src/lib/markdown.ts`、`src/router.tsx`

先取证再改，不盲改：

1. `npm run build` 后检查构建产物里 `/periodic-table` 页面 HTML 的 `modulepreload` 列表与 `assets/*.js` 体积，确认 `katex-*.js`（256KB）到底由哪个模块拉入。
2. 重点检查 `src/lib/markdown-math.ts`：若 `katex` 是**静态** `import`，改成 `loadMarkdownMath()` 内部动态 `import('katex')`（保持现有函数签名与 `router.tsx` 里 `.katex` 检测 → `await loadMarkdownMath()` 的时序不变）。
3. 检查 `src/lib/markdown.ts` 是否静态 import 了体积大的依赖；若 `comment-section.tsx` 的静态 import 导致其进入入口图，改为在文章路由内按需加载。
4. `katex/dist/katex.min.css` 若在 `__root.tsx` 静态引入，评估移到含公式路由（`src/routes/posts.$slug.tsx`、课程详情路由）或在 `loadMarkdownMath()` 中动态引入；含公式页面需保持首屏样式不闪（SSR HTML 已有 `.katex` 节点，CSS 必须随首屏到达，不能延后到 JS 之后）。
5. 检查 `src/lib/elements.ts` 是否被 `site-shell` 等首屏组件引用。若有，把 `CAT_LABELS`、`GROUP_LABELS_*`、`PROP_DEFS` 等常量抽到轻量模块，让 318KB 数据只进周期表 chunk。

只实施构建产物能证明有效的项；每项改完记录体积变化。

## 3. 性能：压缩元素数据集（目标 −25% ~ −40%）

文件：`src/lib/elements.json`、`src/lib/elements.ts`

- 把"对象数组"改为"值数组 + 字段顺序表"：每个元素编码成 `[z, sym, en, ru, zh, ...]`，键名只写一次。缺失值统一 `null`，嵌套字段（如 `ie: number[]`）保持数组。
- 在 `elements.ts` 中定义 `FIELDS` 常量顺序表 + `decodeRow(row)`，导出 `ELEMENTS: Element[]` 类型不变，所有调用方无需改动。
- 用一次性 Node 脚本完成转换（脚本放在仓库外临时目录，不提交）：
  1. 读取原 JSON，按字段顺序编码写入 `elements.json`；
  2. 用新 decoder 解码，与 `git show HEAD:src/lib/elements.json` 的原始对象做逐字段深比较，必须 118/118 完全相等；
  3. 删除临时脚本，只提交压缩后的 `elements.json` 与 `elements.ts` 的 decoder。
- 验收：`npm run build` 后周期表 chunk 由 298KB 降至 ≤225KB；浏览器打开周期表，抽查 Fe/H/La/Og 的详情面板字段与改前一致（含单位换算、同位素括号、俄语名、语音按钮）。

## 4. 小项

- `src/components/site-shell.tsx` 中 `/periodic-table` 的 `Link` 加 `preload="intent"`（悬停预取，缩短点击到可用的等待）。
- 复核 `/assets/*` 响应头是否为长缓存 `immutable`（Cloudflare Workers 静态资源默认如此）；仅记录，不改配置。

## 验证与发布

1. `npm run typecheck`
2. `npm run build` → 记录入口/chunk/CSS 体积，确认 KaTeX 不在周期表页的预载列表中
3. `node scripts/snapshot-pages.mjs` → `npx wrangler deploy`
4. 线上浏览器验证：
   - 1440×900：点击 Fe，右侧面板**无需滚动**即可见；连续点 H、La、Og，面板内容随之更新且位置稳定；切换标准/短表/左阶梯/螺旋四种版面，面板始终在右；页面无横向滚动条。
   - 1024×768：点击元素出现底部抽屉（不再有"无反应"）。
   - 375×812：行为与现在一致。
   - 含公式的文章页：首屏公式样式正常，水合后无闪动、无 React #418。
   - 刷新周期表页：Network 中不再出现 `katex-*.js`；首屏传输总量较 1.82MB 明显下降。
