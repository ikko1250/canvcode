import { expect, test, type BrowserContext, type Page } from '@playwright/test'

// MAI-63: 右クリックの「新しいタブで開く」、Portal の Ctrl+クリック・中ボタンのクリック。
// 本物の画面を使い、サーバーの応答だけを差し替える（app-input.spec.ts と同じ）。
// タブの間の同期は本物のサーバーが要るので、ここでは確かめない

interface Setup {
  rootId: string
  childId: string
  fileId: string
}

async function setup(page: Page, context: BrowserContext): Promise<Setup> {
  await page.goto('/canvas-input-test.html?kind=markdown&sizing=fixed&long=0')
  await page.waitForFunction(() => Boolean((window as any).canvasInputFixture))
  // 固定の Markdown カード（ワールド座標の (80, 70) から）の右に、子の Canvas の Portal を置く
  const { records, childId } = await page.evaluate(() => {
    const fixture = (window as any).canvasInputFixture
    const { canvasId } = fixture.editor.createPortal({ x: 700, y: 200 })
    return { records: [...fixture.editor.workspace.store.values()], childId: canvasId as string }
  })
  const rootId = 'canvas:input-test'
  const fileId = 'file:input-test'
  const file = { id: fileId, kind: 'markdown', title: 'Input test', path: 'test.md', size: 8, mtime: 0, hash: 'test', missing: false }
  // 新しいタブも同じ応答を受けるよう、コンテキストに付ける
  await context.route('**/api/records', (route) => route.fulfill({ json: { rootCanvasId: rootId, rev: 0, records } }))
  await context.route('**/api/files', (route) => route.fulfill({ json: { files: [file] } }))
  await context.route('**/api/files/file%3Ainput-test/content', (route) => route.fulfill({ body: 'one line', headers: { etag: '"test"' } }))
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
  return { rootId, childId, fileId }
}

// ワールド座標を、ブラウザの画面の座標にする（最初のカメラは (0, 0)、等倍）
async function screenAt(page: Page, x: number, y: number) {
  const rect = await page.locator('.canvas-container > div[tabindex]').boundingBox()
  expect(rect).not.toBeNull()
  return { x: rect!.x + x, y: rect!.y + y }
}

test('right-click → 新しいタブで開く opens a portal target canvas in a new tab', async ({ page, context }) => {
  const { childId } = await setup(page, context)
  const at = await screenAt(page, 700, 200)
  await page.mouse.click(at.x, at.y, { button: 'right' })
  const opened = context.waitForEvent('page')
  await page.locator('.context-menu button', { hasText: '新しいタブで開く' }).click()
  const tab = await opened
  await tab.waitForLoadState()
  expect(new URL(tab.url()).pathname).toBe(`/c/${encodeURIComponent(childId)}`)
  // 起動時に URL を最上位のキャンバスに書き換えず、その Canvas に入る
  await expect(tab.locator('.breadcrumb-item')).toHaveCount(2)
  await expect.poll(() => tab.evaluate(() => (window as any).canvcode.editor.canvasId)).toBe(childId)
  expect(new URL(tab.url()).pathname).toBe(`/c/${encodeURIComponent(childId)}`)
  // 元のタブは移らない
  expect(new URL(page.url()).pathname).not.toBe(`/c/${encodeURIComponent(childId)}`)
})

test('Ctrl+click and middle-click on a portal open it in a new tab', async ({ page, context }) => {
  const { childId } = await setup(page, context)
  const at = await screenAt(page, 700, 200)
  for (const click of [
    () => page.keyboard.down('Control').then(() => page.mouse.click(at.x, at.y)).then(() => page.keyboard.up('Control')),
    () => page.mouse.click(at.x, at.y, { button: 'middle' }),
  ]) {
    const opened = context.waitForEvent('page')
    await click()
    const tab = await opened
    await expect.poll(() => new URL(tab.url()).pathname).toBe(`/c/${encodeURIComponent(childId)}`)
    await tab.close()
  }
  // 元のタブは移らない
  expect(await page.evaluate(() => (window as any).canvcode.editor.canvasId)).not.toBe(childId)
})

test('a markdown card opens as /f/<id> in a new tab and closing returns to its canvas', async ({ page, context }) => {
  const { rootId, fileId } = await setup(page, context)
  const at = await screenAt(page, 140, 140)
  await page.mouse.click(at.x, at.y, { button: 'right' })
  const opened = context.waitForEvent('page')
  await page.locator('.context-menu button', { hasText: '新しいタブで開く' }).click()
  const tab = await opened
  await expect.poll(() => new URL(tab.url()).pathname).toBe(`/f/${encodeURIComponent(fileId)}`)
  await expect(tab.locator('.file-editor')).toBeVisible()
  await tab.locator('.file-editor-close').click()
  await expect(tab.locator('.file-editor')).toHaveCount(0)
  await expect.poll(() => new URL(tab.url()).pathname).toBe(`/c/${encodeURIComponent(rootId)}`)
})
