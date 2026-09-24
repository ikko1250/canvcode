import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

// 開発時は Vite の開発サーバーから API へプロキシする（MAI-4）。
// VPS 上で動かすので、待ち受けは 127.0.0.1 のみ。SSH のポートフォワードで開く。
export default defineConfig({
  // スライドエディタは Preact を使うため、React Fast Refresh の変換対象から外す。
  plugins: [react({ exclude: /src\/slides\// })],
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        slideEditor: fileURLToPath(new URL('./slide-editor.html', import.meta.url)),
        slidesPreview: fileURLToPath(new URL('./slides-preview.html', import.meta.url)),
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      // /api/events は WebSocket（MAI-30）
      '/api': { target: 'http://127.0.0.1:8787', ws: true },
    },
  },
  preview: {
    host: '127.0.0.1',
  },
})
