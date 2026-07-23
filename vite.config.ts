import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import type { ProxyOptions } from 'vite'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

const CLIENT_PORT = Number(process.env.ARECO_CLIENT_PORT || process.env.AGENT_REMOTE_CLIENT_PORT || 8791)
const SERVER_PORT = Number(process.env.ARECO_SERVER_PORT || process.env.AGENT_REMOTE_SERVER_PORT || 8790)
const BACKEND = `http://127.0.0.1:${SERVER_PORT}`

// dev 代理剥掉 origin/referer：服务端 Origin 校验对"无 Origin"回退 cookie 校验，
// 与生产同源访问行为一致
function createProxyConfig(): ProxyOptions {
  return {
    target: BACKEND,
    changeOrigin: true,
    ws: true,
    configure: (proxy) => {
      proxy.on('proxyReq', (proxyReq) => {
        proxyReq.removeHeader('origin')
        proxyReq.removeHeader('referer')
      })
      proxy.on('proxyReqWs', (proxyReq) => {
        proxyReq.removeHeader('origin')
        proxyReq.removeHeader('referer')
      })
    },
  }
}

export default defineConfig({
  root: 'packages/client',
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    minify: 'esbuild',
    sourcemap: false,
    target: 'es2020',
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/@xterm')) return 'xterm'
          if (id.includes('node_modules/highlight.js')) return 'hljs'
          if (id.includes('node_modules')) {
            if (id.includes('naive-ui') || id.includes('vueuc') || id.includes('css-render')) return 'ui-vendor'
            if (id.includes('vue') || id.includes('pinia')) return 'vue-vendor'
            return 'vendor'
          }
        },
        chunkFileNames: 'assets/js/[name]-[hash].js',
        entryFileNames: 'assets/js/[name]-[hash].js',
        assetFileNames: 'assets/[ext]/[name]-[hash].[ext]',
      },
    },
  },
  server: {
    port: CLIENT_PORT,
    strictPort: true,
    host: true,
    proxy: {
      '/api': createProxyConfig(),
      '/ws': createProxyConfig(),
      '/login': createProxyConfig(),
      '/logout': createProxyConfig(),
      '/healthz': createProxyConfig(),
    },
  },
})
