import { expect, test, type Page } from '@playwright/test'

// Markdown カードは、表示倍率に合う解像度の画像にして描く。どの倍率の画像でも、文字はカードに対して同じ大きさで描かれること。
// WebKit（Safari）は、SVG の viewBox で拡大すると、foreignObject の中の層を作る要素（本文の position: relative など）を拡大せず、
// ズームすると本文の文字だけが小さくなっていた（rasterize.ts の svgOf）。WebKit で動かすときは --project=webkit

async function openCard(page: Page) {
  await page.goto('/canvas-input-test.html?kind=markdown&sizing=auto&long=0')
  await page.waitForFunction(() => Boolean((window as any).canvasInputFixture))
  const records = await page.evaluate(() => [...(window as any).canvasInputFixture.editor.workspace.store.values()])
  const text = '# 見出し\n\n' + Array.from({ length: 6 }, (_, i) => `段落 ${i + 1}：Markdown の本文。The quick brown fox jumps over the lazy dog.`).join('\n\n')
  const file = { id: 'file:input-test', kind: 'markdown', title: 'Zoom', path: 'test.md', size: text.length, mtime: 0, hash: 'test', missing: false }
  await page.context().route('**/api/records', (route) => route.fulfill({ json: { rootCanvasId: 'canvas:input-test', rev: 0, records } }))
  await page.context().route('**/api/files', (route) => route.fulfill({ json: { files: [file] } }))
  await page.context().route('**/api/files/file%3Ainput-test/content', (route) => route.fulfill({ body: text, headers: { etag: '"test"' } }))
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
  // 高さを中身に合わせたカード（本文を読み込むまでは仮の高さ 280）
  await expect
    .poll(() => page.evaluate(() => {
      const editor = (window as any).canvcode.editor
      const id = editor.index.search({ x: -1e6, y: -1e6, w: 2e6, h: 2e6 })[0]
      return editor.index.get(id).worldBounds.h
    }), { timeout: 15_000 })
    .toBeGreaterThan(400)
  return page.evaluate(() => {
    const editor = (window as any).canvcode.editor
    const id = editor.index.search({ x: -1e6, y: -1e6, w: 2e6, h: 2e6 })[0]
    return editor.index.get(id).worldBounds as { x: number; y: number; w: number; h: number }
  })
}

// カードの左上を画面の左上に置いて zoom 倍で見たとき、暗い画素（文字）の右端（ワールド座標）
async function textExtent(page: Page, card: { x: number; y: number; w: number; h: number }, zoom: number) {
  await page.evaluate(([x, y, zoom]) => (window as any).canvcode.view.setCamera({ x, y, zoom }), [card.x - 10, card.y - 10, zoom])
  await expect.poll(() => page.evaluate(() => (window as any).canvcode.view.images.idle), { timeout: 20_000 }).toBe(true)
  await page.mouse.move(5, 5)
  await page.waitForTimeout(200)
  const rect = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  const width = Math.min(rect.width, (card.w + 20) * zoom)
  const height = Math.min(rect.height, (card.h + 20) * zoom)
  const png = await page.screenshot({ clip: { x: rect.x, y: rect.y, width, height } })
  return page.evaluate(async ([base64, zoom, cssWidth]) => {
    const image = new Image()
    image.src = `data:image/png;base64,${base64}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(image, 0, 0)
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let maxX = 0
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4
        if (data[i] + data[i + 1] + data[i + 2] < 250) {
          maxX = Math.max(maxX, x)
        }
      }
    }
    const px = image.width / cssWidth
    return { right: maxX / px / zoom }
  }, [png.toString('base64'), zoom, width] as const)
}

test('markdown card text keeps its size relative to the card at every zoom level', async ({ page }) => {
  const card = await openCard(page)
  const base = await textExtent(page, card, 1)
  // 本文の右端は、カードの幅の半分より右にある（文字が縮んでいない）
  expect(base.right).toBeGreaterThan(card.w / 2)
  for (const zoom of [1.5, 2, 3]) {
    const extent = await textExtent(page, card, zoom)
    expect(Math.abs(extent.right - base.right), `zoom ${zoom}`).toBeLessThan(4)
  }
})
