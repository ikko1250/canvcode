import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

// スキャンした PDF（CCITT Fax で圧縮した 1bit の画像）が描けること。PDF.js は CCITT / JBIG2 / JPEG2000 を
// wasm（/pdfjs/wasm/）でデコードするので、wasmUrl を渡し忘れると画像が捨てられ、ページが白紙になる。
// フィクスチャは 200×200pt の白地の中央（50〜150pt）に黒い四角が 1 つ（ImageMagick の -compress Group4 で作った）

test('renders a CCITT Fax (G4) scanned page', async ({ page }) => {
  const data = [...(await readFile(new URL('./fixtures/ccitt-g4.pdf', import.meta.url)))]
  await page.goto('/canvas-input-test.html')
  const pixel = await page.evaluate(async (bytes) => {
    // 開発サーバー（Vite）が配る、画面の PDF.js の読み込み口（apps/web/src/pdf.ts）
    const path = '/src/pdf.ts'
    const { pdfService } = (await import(path)) as typeof import('../../apps/web/src/pdf.ts')
    const doc = await pdfService.open({ data: new Uint8Array(bytes).buffer })
    const bitmap = await doc.render(0, 1)
    await doc.destroy()
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    return [...ctx.getImageData(100, 100, 1, 1).data]
  }, data)
  // 四角の中央は黒（白紙なら 255 になる）
  expect(pixel[0]).toBeLessThan(64)
  expect(pixel[3]).toBe(255)
})
