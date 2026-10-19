import { expect, test, type BrowserContext, type Page } from '@playwright/test'

// Markdown カードのリンクの上にポインタを置くと、行き先と開き方の札を出し、Ctrl を押している間は指のカーソルにする。
// Ctrl+クリックで新しいタブに開く（MAI-21）。本物の画面を使い、サーバーの応答だけを差し替える（markdown-tiles.spec.ts と同じ）

const URL_TO_OPEN = 'https://example.com/'

async function setup(page: Page, context: BrowserContext) {
  await page.goto('/canvas-input-test.html?kind=markdown&sizing=auto&long=0')
  await page.waitForFunction(() => Boolean((window as any).canvasInputFixture))
  const records = await page.evaluate(() => [...(window as any).canvasInputFixture.editor.workspace.store.values()])
  const text = `[example](${URL_TO_OPEN}) へのリンク\n\nリンクのない段落。リンクのない段落。リンクのない段落。`
  const file = { id: 'file:input-test', kind: 'markdown', title: 'Links', path: 'test.md', size: text.length, mtime: 0, hash: 'test', missing: false }
  await context.route('**/api/records', (route) => route.fulfill({ json: { rootCanvasId: 'canvas:input-test', rev: 0, records } }))
  await context.route('**/api/files', (route) => route.fulfill({ json: { files: [file] } }))
  await context.route('**/api/files/file%3Ainput-test/content', (route) => route.fulfill({ body: text, headers: { etag: '"test"' } }))
  // 外のページへは出ないようにする（開いたタブの URL だけを見る）
  await context.route('https://example.com/**', (route) => route.fulfill({ body: 'example' }))
  await page.goto('/')
  const root = page.locator('.canvas-container > div[tabindex]')
  await expect(root).toBeVisible()

  // カードの左上が画面の (100, 100) に来るように、等倍で見る
  await expect.poll(() => page.evaluate(() => (window as any).canvcode.editor.index.allIds().length), { timeout: 15_000 }).toBeGreaterThan(0)
  const card = await page.evaluate(() => {
    const editor = (window as any).canvcode.editor
    const id = editor.index.allIds()[0]
    const bounds = editor.index.get(id).worldBounds
    ;(window as any).canvcode.view.setCamera({ x: bounds.x - 100, y: bounds.y - 100, zoom: 1 })
    return bounds
  })
  // 本文の 1 行目のリンクのある点を探す（ヘッダー 36・本文の上の余白 18・左の余白 22 の先）
  const findLink = () =>
    page.evaluate((card) => {
      const view = (window as any).canvcode.view
      for (let y = 40; y < 110; y += 2) {
        if (view.linkUnder({ x: card.x + 40, y: card.y + y })) return { x: 40, y }
      }
      return null
    }, card)
  await expect.poll(findLink, { timeout: 15_000 }).not.toBeNull()
  const local = (await findLink())!
  const rect = (await root.boundingBox())!
  return {
    root,
    link: { x: rect.x + 100 + local.x, y: rect.y + 100 + local.y },
    // 2 つ目の段落（リンクがない）
    plain: { x: rect.x + 100 + 40, y: rect.y + 100 + local.y + 60 },
  }
}

test('hovering a link in a markdown card shows where it goes and how to open it', async ({ page, context }) => {
  const { root, link, plain } = await setup(page, context)
  const hint = page.getByTestId('canvas-link-hint')
  await page.mouse.move(link.x, link.y)
  await expect(hint).toBeVisible()
  await expect(hint).toContainText(URL_TO_OPEN)
  await expect(hint).toContainText('+クリックで開く')
  // Ctrl を押している間だけ、指のカーソル
  expect(await root.evaluate((el) => el.style.cursor)).not.toBe('pointer')
  await page.keyboard.down('Control')
  await expect.poll(() => root.evaluate((el) => el.style.cursor)).toBe('pointer')
  await page.keyboard.up('Control')
  await expect.poll(() => root.evaluate((el) => el.style.cursor)).not.toBe('pointer')
  // リンクのないところでは消える
  await page.mouse.move(plain.x, plain.y)
  await expect(hint).toBeHidden()
})

test('Ctrl+click on a link in a markdown card opens it in a new tab', async ({ page, context }) => {
  const { link } = await setup(page, context)
  await page.mouse.move(link.x, link.y)
  const opened = context.waitForEvent('page')
  await page.keyboard.down('Control')
  await page.mouse.click(link.x, link.y)
  await page.keyboard.up('Control')
  const tab = await opened
  await expect.poll(() => tab.url()).toBe(URL_TO_OPEN)
  await tab.close()
})
