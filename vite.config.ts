import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import contentCollections from '@content-collections/vite'

// Cloudflare Workers 适配（按官方 TanStack Start 指南）：
// cloudflare 必须在 tanstackStart 之前注册，SSR 环境名固定为 "ssr"。
const config = defineConfig({
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
