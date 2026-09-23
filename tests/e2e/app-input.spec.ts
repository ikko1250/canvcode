import { expect, test } from '@playwright/test'

// Use the actual React app and CSS, with only the backend responses replaced.
// The isolated CanvasView fixture does not cover app-level overlays or styles.
for (const kind of ['code', 'markdown'] as const) test(`inline ${kind} editor in the real app pans on wheel over its card`, async ({ page }) => {
  await page.goto(`/canvas-input-test.html?kind=${kind}&sizing=auto`)
  await page.waitForFunction(() => Boolean((window as any).canvasInputFixture))
  const records = await page.evaluate(() => {
    const fixture = (window as any).canvasInputFixture
    return [...fixture.editor.workspace.store.values()]
  })
  const file = { id: 'file:input-test', kind, title: 'Input test', path: kind === 'code' ? 'test.py' : 'test.md', size: 100, mtime: 0, hash: 'test', missing: false }
  await page.route('**/api/records', (route) => route.fulfill({ json: { rootCanvasId: 'canvas:input-test', rev: 0, records } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [file] } }))
  await page.route('**/api/files/file%3Ainput-test/content', (route) => route.fulfill({ body: Array.from({ length: 90 }, (_, i) => `line ${i}`).join('\n'), headers: { etag: '"test"' } }))
  await page.goto('/')
  const root = page.locator('.canvas-container > div[tabindex]')
  await expect(root).toBeVisible()
  // The card is at world position (80, 70); the sidebar changes the viewport's origin.
  const rect = await root.boundingBox()
  expect(rect).not.toBeNull()
  await page.mouse.dblclick(rect!.x + 140, rect!.y + 140)
  await expect(page.locator('.canvcode-document-editor .cm-scroller')).toBeVisible()
  const content = page.locator('.canvcode-document-editor .cm-content')
  const before = await content.boundingBox()
  expect(before).not.toBeNull()
  await page.mouse.move(before!.x + 100, before!.y + 40)
  await page.mouse.wheel(0, 90)
  await expect.poll(async () => (await content.boundingBox())?.y).toBeLessThan(before!.y)
})
