import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// PDF.js が PDF を読むのに使うファイル（フォントを埋め込んでいない PDF の CMap と標準フォント）を /pdfjs/ から配る。
// 開発時は node_modules から返し、ビルドでは dist/pdfjs/ に出す（本番はサーバーが dist をそのまま配信する）
const PDFJS_DIR = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
const PDFJS_DATA = ['cmaps', 'standard_fonts']

function pdfjsData(): Plugin {
  return {
    name: 'canvcode-pdfjs-data',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const match = /^\/pdfjs\/([a-z_]+)\/([\w.-]+)$/.exec((req.url ?? '').split('?')[0])
        if (!match || !PDFJS_DATA.includes(match[1])) return next()
        try {
          const data = await readFile(join(PDFJS_DIR, match[1], match[2]))
          res.setHeader('content-type', 'application/octet-stream')
          res.end(data)
        } catch {
          next()
        }
      })
    },
    async generateBundle() {
      for (const dir of PDFJS_DATA) {
        for (const name of await readdir(join(PDFJS_DIR, dir))) {
          this.emitFile({ type: 'asset', fileName: `pdfjs/${dir}/${name}`, source: await readFile(join(PDFJS_DIR, dir, name)) })
        }
      }
    },
  }
}

// 開発時は Vite の開発サーバーから API へプロキシする（MAI-4）。
// VPS 上で動かすので、待ち受けは 127.0.0.1 のみ。SSH のポートフォワードで開く。
export default defineConfig({
  // スライドエディタは Preact を使うため、React Fast Refresh の変換対象から外す。
  plugins: [react({ exclude: /src\/slides\// }), pdfjsData()],
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
