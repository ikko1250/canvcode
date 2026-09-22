import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 開発時は Vite の開発サーバーから API へプロキシする（MAI-4）。
// VPS 上で動かすので、待ち受けは 127.0.0.1 のみ。SSH のポートフォワードで開く。
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
  preview: {
    host: '127.0.0.1',
  },
})
