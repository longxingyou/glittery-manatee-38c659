/**
 * 服务端同步注册 KaTeX 渲染器。
 *
 * 只在 Worker 入口（worker.ts）导入，因此不会进入客户端构建图。
 * 这样 SSR 与 /api/comments、/egg/* 等纯服务端渲染路径始终能输出完整公式，
 * 客户端则走 markdown-math.ts 的动态 import。
 */
import katex from 'katex'
// mhchem 必须与主 katex 是同一实例：走 package exports 的 import 条件解析到
// dist/contrib/mhchem.mjs（其内部 import '../katex.mjs'）。若直接引
// dist/contrib/mhchem.js（UMD），Vite 打包后会 require 另一个 katex.js 实例，
// \ce 宏注册到未被使用的实例上 → 渲染时 \ce 变成未知命令（红色文本）。
import 'katex/contrib/mhchem'

import { setMathRenderer } from './markdown'

setMathRenderer((tex, displayMode) =>
  katex.renderToString(tex, { displayMode, throwOnError: false, strict: false }))
