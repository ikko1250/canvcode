import { expect, test, type CDPSession } from '@playwright/test'

// 日本語入力が ON のまま打ったときに、文字が二重に入らないこと。
// Chromium の DevTools Protocol で、macOS の IME と同じ順にイベントを送る：
// keyCode 229・key に打った文字の keydown → 変換中の文字（imeSetComposition）→ 確定（insertText）

test.skip(({ browserName }) => browserName !== 'chromium', 'IME を送れるのは Chromium だけ')

const CANVAS_ID = 'canvas:ime-test'
const FILE_ID = 'file:input-test'

// IME を通ったキー（keyCode 229）。key は macOS と同じく、打った文字のまま
async function imeKey(cdp: CDPSession, key: string, code: string) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 })
}

async function compose(cdp: CDPSession, text: string) {
  await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
}

test('design panel: confirming the IME with Enter neither doubles the number nor types it into the text', async ({ page }) => {
  const node = {
    typeName: 'node', id: 'node:text', type: 'text', parentId: CANVAS_ID, x: 100, y: 100, rotation: 0, index: 'a0', opacity: 1, locked: false,
    props: { text: 'hello', fontSize: 16, color: '#1f2328', align: 'left', w: 200, autoWidth: true }, meta: {},
  }
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: 'IME', parentCanvasId: null, ownerNodeId: null, createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records: [canvas, node] } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [] } }))
  await page.goto('/')
  const surface = page.locator('.canvas-container > div[tabindex]')
  await expect(surface).toBeVisible()
  const rect = (await surface.boundingBox())!
  // 文字を編集しているところから、デザインパネルの「大きさ」に移る
  await page.mouse.dblclick(rect.x + 120, rect.y + 112)
  const textEditor = page.locator('.canvcode-text-editor')
  await expect(textEditor).toBeFocused()
  const size = page.getByTestId('design-panel').locator('[data-section="text"]').getByRole('textbox', { name: '大きさ', exact: true })
  await size.click()
  await expect(size).toBeFocused()

  const cdp = await page.context().newCDPSession(page)
  await imeKey(cdp, '1', 'Digit1')
  await compose(cdp, '1')
  await imeKey(cdp, '8', 'Digit8')
  await compose(cdp, '18')
  // 確定の Enter は IME のもの。まだ値は変えず、フォーカスも動かさない
  await imeKey(cdp, 'Enter', 'Enter')
  await cdp.send('Input.insertText', { text: '18' })
  await expect(size).toBeFocused()
  await expect(size).toHaveValue('18')
  // もう一度 Enter で確定する（確定の直後の Enter は IME のものとみなすので、少し間を空ける。imeGuard.ts）
  await page.waitForTimeout(150)
  await size.press('Enter')
  await expect(textEditor).toBeFocused()
  await expect(size).toHaveValue('18')
  await expect(textEditor).toHaveText('hello')
})

test('vim: with the IME on, I enters insert mode without typing い, and dd deletes a line', async ({ page }) => {
  const file = { id: FILE_ID, kind: 'markdown', title: 'Input test', path: 'test.md', size: 100, mtime: 0, hash: 'test', missing: false }
  await page.goto('/canvas-input-test.html?kind=markdown&sizing=auto')
  await page.waitForFunction(() => Boolean((window as any).canvasInputFixture))
  const records = await page.evaluate(() => [...(window as any).canvasInputFixture.editor.workspace.store.values()])
  await page.route('**/api/records', (route) => route.fulfill({ json: { rootCanvasId: 'canvas:input-test', rev: 0, records } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [file] } }))
  await page.route(`**/api/files/${encodeURIComponent(FILE_ID)}/content`, (route) => route.fulfill({ body: 'abcd\nefgh\nijkl', headers: { etag: '"test"' } }))
  await page.addInitScript(() => localStorage.setItem('canvcode.fileEditor.vim', '1'))
  await page.goto('/')
  await page.getByRole('button', { name: '☰' }).click()
  await page.locator('.sidebar-title', { hasText: 'Input test' }).click()
  const editor = page.locator('.file-editor')
  await expect(editor.locator('.cm-content')).toBeFocused()
  await expect(editor.locator('.file-editor-status')).toHaveText('NORMAL')
  const doc = () => page.evaluate(() => (document.querySelector('.file-editor .cm-content') as any).cmTile.root.view.state.doc.toString())

  const cdp = await page.context().newCDPSession(page)
  await imeKey(cdp, 'd', 'KeyD')
  await compose(cdp, 'd')
  await imeKey(cdp, 'd', 'KeyD')
  await compose(cdp, 'd')
  await expect.poll(doc).toBe('efgh\nijkl')

  await imeKey(cdp, 'I', 'KeyI')
  await compose(cdp, 'い')
  await expect(editor.locator('.file-editor-status')).toHaveText('INSERT')
  await page.waitForTimeout(100)
  expect(await doc()).toBe('efgh\nijkl')
  // 挿入モードでは、日本語がそのまま入る
  await compose(cdp, 'あ')
  await cdp.send('Input.insertText', { text: 'あ' })
  await expect.poll(doc).toBe('あefgh\nijkl')
})
