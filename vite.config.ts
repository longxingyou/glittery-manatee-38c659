import { defineConfig } from 'vite'
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
// 可用 BUILD_ID 环境变量固定（便于复现/缓存复用），否则取构建时刻。
const BUILD_ID =
  process.env.BUILD_ID || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

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
