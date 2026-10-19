import { expect, test } from '@playwright/test'

// 長い Markdown カードは、全体の画像では解像度が抑えられるので（1 辺 8192 画素まで）、見えている部分をタイルで描く。
// 本物の画面を使い、サーバーの応答だけを差し替える（new-tab.spec.ts と同じ）

test('a long markdown card draws the visible part as tiles at the requested resolution', async ({ page, context }) => {
  // 差し替える応答のレコードは、テスト用のページで作る（幅 907 の、高さを中身に合わせる Markdown カード）
  await page.goto('/canvas-input-test.html?kind=markdown&sizing=auto&long=0')
  await page.waitForFunction(() => Boolean((window as any).canvasInputFixture))
  const records = await page.evaluate(() => {
    const fixture = (window as any).canvasInputFixture
    const node = fixture.editor.getNode(fixture.cardId)
    fixture.editor.transact('widen', (tx: any) => tx.put({ ...node, props: { ...node.props, w: 907, sizing: 'auto' } }))
    return [...fixture.editor.workspace.store.values()]
  })
  const text = Array.from({ length: 500 }, (_, i) => `段落 ${i + 1}：長い Markdown の本文。The quick brown fox jumps over the lazy dog.`).join('\n\n')
  const file = { id: 'file:input-test', kind: 'markdown', title: 'Long', path: 'test.md', size: text.length, mtime: 0, hash: 'test', missing: false }
  await context.route('**/api/records', (route) => route.fulfill({ json: { rootCanvasId: 'canvas:input-test', rev: 0, records } }))
  await context.route('**/api/files', (route) => route.fulfill({ json: { files: [file] } }))
  await context.route('**/api/files/file%3Ainput-test/content', (route) => route.fulfill({ body: text, headers: { etag: '"test"' } }))
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()

  const cardBounds = () =>
    page.evaluate(() => {
      const editor = (window as any).canvcode.editor
      const id = editor.index.search({ x: -1e6, y: -1e6, w: 2e6, h: 2e6 })[0]
      return { id: id as string, ...editor.index.get(id).worldBounds }
    })
  await expect.poll(async () => (await cardBounds()).h, { timeout: 15_000 }).toBeGreaterThan(8192)
  const card = await cardBounds()

  // カードの真ん中あたりを、等倍で見る（devicePixelRatio 1 なので、頼む解像度は 1）
  await page.evaluate((y) => (window as any).canvcode.view.setCamera({ x: 60, y, zoom: 1 }), card.y + card.h / 2)
  await expect
    .poll(() => page.evaluate(() => {
      const images = (window as any).canvcode.view.images
      return images.stats.produced > 0 && images.idle
    }), { timeout: 20_000 })
    .toBe(true)
  const levels = await page.evaluate((id) => {
    const entries: Array<[string, any]> = [...(window as any).canvcode.view.images.images.entries()]
    return Object.fromEntries(entries.filter(([key]) => key.startsWith(id)).map(([key, entry]) => [key.slice(id.length), [...entry.levels.keys()]]))
  }, card.id)
  // 全体の画像は、抑えられない段階（0.25）で作る
  expect(levels['']).toEqual([0.25])
  // 見えている部分（ローカルの y が真ん中あたり）のタイルは、頼んだ解像度で作る
  const middleRow = Math.floor(card.h / 2 / 512)
  expect(levels[`#tile:0,${middleRow}`]).toEqual([1])
  expect(levels[`#tile:1,${middleRow}`]).toEqual([1])
  // 見えていないタイル（下の端）は作らない
  expect(levels[`#tile:0,${Math.floor((card.h - 1) / 512)}`]).toBeUndefined()
})
