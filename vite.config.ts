import { defineConfig } from 'vite'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import contentCollections from '@content-collections/vite'

// 每次构建的版本标识，注入到 worker（见下方 define）。
//
// 为什么必须有：worker 的 HTML 三级缓存（内存 / 边缘 / KV）此前只按
// `html:${pathname}` 建键，而 HTML 外壳里写死了 `assets/index-<hash>.js`。
// 一旦重新构建，hash 变了、旧文件被删，但缓存里的旧外壳还在（TTL 1 小时），
// 于是浏览器去取一个 404 的 chunk，动态 import 失败，整页白屏 ——
// 这正是本地反复出现「所有断言全为 0」的根因，线上部署后同样会中招。
// 把构建版本编进缓存键，旧版本条目自然失效（并靠 TTL 过期回收），无需手动 purge。
//
// ★ 版本号按「源码状态」推导，只在部署时确定一次：
//   过去取「构建时刻 + 随机数」，于是**每跑一次 build 都换一个版本号**——
//   部署时这没问题（正是想要的缓存击穿），但本地反复 build 会每次都击穿
//   KV 与边缘 HTML 缓存，导致反复冷启动、验收变慢且结果飘忽。
//   现在改成 `git HEAD + 工作区状态` 的哈希：同一份源码反复构建**得到同一个值**，
//   源码一改（含 content/ 下同步进来的课程精讲）版本号立刻变，旧缓存自然失效。
//   即「一次部署内只确定一次，且只有内容变了才变」。
//
// 仍可用 BUILD_ID 环境变量显式钉住（CI / 需要复现缓存时）：
//   BUILD_ID=<id> pnpm run build
const sourceVersion = (): string | null => {
  try {
    const git = (args: string[]) =>
      execFileSync('git', args, {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    const head = git(['rev-parse', '--short', 'HEAD'])
    if (!head) return null
    // 含已跟踪改动与未跟踪文件（--porcelain 自动遵守 .gitignore，不扫 dist/node_modules）
    // ⚠ 只取 --porcelain 不够：它只记录「哪些文件变了」，同一个文件再改一次输出不变。
    //   于是「只改 CSS 再部署」会沿用上一次的 BUILD_ID，worker 继续发上一版 HTML ——
    //   而上一版 HTML 里写死的 assets/index-<hash>.css|js 已被新构建删除，整站无样式/白屏。
    //   所以再叠一份工作区补丁内容（已暂存 + 未暂存）：内容一变，版本号立刻变。
    const dirty = git(['status', '--porcelain'])
    const patch = git(['diff', 'HEAD', '--binary', '--no-color'])
    const digest = createHash('sha256').update(`${head}\n${dirty}\n${patch}`).digest('hex').slice(0, 8)
    return `${head}-${digest}`
  } catch {
    // 不是 git 仓库 / 没装 git → 退回旧行为（时间戳+随机），宁可变号也不要报错
    return null
  }
}

const BUILD_ID =
  process.env.BUILD_ID ||
  sourceVersion() ||
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

// Cloudflare Workers 适配（按官方 TanStack Start 指南）：
// cloudflare 必须在 tanstackStart 之前注册，SSR 环境名固定为 "ssr"。
const config = defineConfig({
  define: {
    // worker.ts / SSR 代码里以 __BUILD_ID__ 引用；未替换时 typeof 判定为 undefined
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  plugins: [
    contentCollections(),
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tailwindcss(),
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tanstackStart(),
    viteReact(),
  ],
  server: {
    // 仅本地开发：附件网关的 CORS 只放行生产源，浏览器从 localhost 跨域会被拦。
    // dev 下 attachment-store 把网关地址改写为同源 /__gwproxy/*，由这里服务端
    // 透传到真实网关（CORS 同源化；Range/POST 均支持）。生产构建不含此配置。
    proxy: {
      '/__gwproxy': {
        target: 'https://gw.xn--fpr224a.mom',
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/__gwproxy/, ''),
      },
    },
  },
})

export default config
