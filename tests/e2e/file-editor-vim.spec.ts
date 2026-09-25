import { expect, test, type Page } from '@playwright/test'

// MAI-60: vim mode in the fullscreen file editor (stage 1). Uses the real React app with only
// the backend responses replaced, like app-input.spec.ts.

// The file record the canvas-input fixture creates
const FILE_ID = 'file:input-test'

async function openEditor(page: Page, options: { vim: boolean; body?: string }) {
  await page.goto('/canvas-input-test.html?kind=markdown&sizing=auto')
  await page.waitForFunction(() => Boolean((window as any).canvasInputFixture))
  const records = await page.evaluate(() => [...(window as any).canvasInputFixture.editor.workspace.store.values()])
  const file = { id: FILE_ID, kind: 'markdown', title: 'Input test', path: 'test.md', size: 100, mtime: 0, hash: 'test', missing: false }
  const saved: string[] = []
  await page.route('**/api/records', (route) => route.fulfill({ json: { rootCanvasId: 'canvas:input-test', rev: 0, records } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [file] } }))
  await page.route(`**/api/files/${encodeURIComponent(FILE_ID)}/content`, async (route) => {
    const request = route.request()
    if (request.method() === 'PUT') {
      saved.push(request.postData() ?? '')
      await route.fulfill({ json: { file: { ...file, hash: `saved-${saved.length}` } } })
      return
    }
    await route.fulfill({ body: options.body ?? 'abcd\nefgh\nijkl', headers: { etag: '"test"' } })
  })
  await page.addInitScript((on) => localStorage.setItem('canvcode.fileEditor.vim', on ? '1' : '0'), options.vim)
  await page.goto('/')
  await page.getByRole('button', { name: '☰' }).click()
  await page.locator('.sidebar-title', { hasText: 'Input test' }).click()
  const editor = page.locator('.file-editor')
  await expect(editor.locator('.cm-content')).toBeFocused()
  return { editor, saved }
}

// エディタの本文と、カーソルの位置（本文の先頭からの文字数）。CodeMirror の EditorView.findFromDOM と同じ引き方
async function editorState(page: Page): Promise<{ doc: string; head: number }> {
  return page.evaluate(() => {
    const view = (document.querySelector('.file-editor .cm-content') as any).cmTile.root.view
    return { doc: view.state.doc.toString(), head: view.state.selection.main.head }
  })
}

async function head(page: Page) {
  return (await editorState(page)).head
}

async function doc(page: Page) {
  return (await editorState(page)).doc
}

test('vim mode: t / n / s / h move left, up, down and right', async ({ page }) => {
  const { editor } = await openEditor(page, { vim: true })
  await expect(editor.locator('.file-editor-status')).toHaveText('NORMAL')
  await page.keyboard.press('h')
  expect(await head(page)).toBe(1)
  await page.keyboard.press('s')
  expect(await head(page)).toBe(6)
  await page.keyboard.press('s')
  expect(await head(page)).toBe(11)
  await page.keyboard.press('t')
  expect(await head(page)).toBe(10)
  await page.keyboard.press('n')
  expect(await head(page)).toBe(5)
  // 文字は入らない
  expect(await doc(page)).toBe('abcd\nefgh\nijkl')
})

test('vim mode: Esc does not close the editor, :q does', async ({ page }) => {
  const { editor } = await openEditor(page, { vim: true })
  await page.keyboard.press('i')
  await expect(editor.locator('.file-editor-status')).toHaveText('INSERT')
  await page.keyboard.press('Escape')
  await expect(editor.locator('.file-editor-status')).toHaveText('NORMAL')
  await page.keyboard.press('Escape')
  await expect(editor).toBeVisible()
  await page.keyboard.type(':q')
  await page.keyboard.press('Enter')
  await expect(editor).toBeHidden()
})

test('vim mode: :w saves right away without closing', async ({ page }) => {
  const { editor, saved } = await openEditor(page, { vim: true })
  await page.keyboard.type('Ahello')
  await page.keyboard.press('Escape')
  await page.keyboard.type(':w')
  await page.keyboard.press('Enter')
  // 待ってまとめる保存（数百ミリ秒）より早く保存される
  await expect.poll(() => saved.length, { timeout: 300 }).toBe(1)
  expect(saved[0]).toBe('abcdhello\nefgh\nijkl')
  await expect(editor).toBeVisible()
})

test('vim mode: Space x closes, and Ctrl+Enter closes only in normal mode', async ({ page }) => {
  const { editor } = await openEditor(page, { vim: true })
  await page.keyboard.press('i')
  await page.keyboard.press('Control+Enter')
  await expect(editor).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press(' ')
  await page.keyboard.press('x')
  await expect(editor).toBeHidden()
})

test('without vim mode, Esc closes the editor and the toggle turns vim on', async ({ page }) => {
  const { editor } = await openEditor(page, { vim: false })
  await expect(editor.locator('.file-editor-status')).toHaveCount(0)
  await page.keyboard.type('x')
  await expect(editor.locator('.cm-content')).toContainText('xabcd')
  await editor.locator('.file-editor-vim').click()
  await expect(editor.locator('.file-editor-status')).toHaveText('NORMAL')
  expect(await page.evaluate(() => localStorage.getItem('canvcode.fileEditor.vim'))).toBe('1')
  // 作り直していないので、打った文字は残っている
  await expect(editor.locator('.cm-content')).toContainText('xabcd')
  await editor.locator('.file-editor-vim').click()
  await expect(editor.locator('.file-editor-status')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(editor).toBeHidden()
})

test('vim mode: IME composition in normal mode does not insert text', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'uses the Chrome DevTools Protocol to simulate IME input')
  const { editor } = await openEditor(page, { vim: true })
  const client = await page.context().newCDPSession(page)
  await client.send('Input.imeSetComposition', { text: 'ｓ', selectionStart: 1, selectionEnd: 1 })
  await client.send('Input.insertText', { text: 'ｓ' })
  await expect(editor.locator('.cm-content')).toHaveText(/^abcd/)
  expect(await doc(page)).toBe('abcd\nefgh\nijkl')
  // 挿入モードでは、変換した文字が入る
  await page.keyboard.press('i')
  await client.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 })
  await client.send('Input.insertText', { text: '日本' })
  await expect.poll(() => doc(page)).toBe('日本abcd\nefgh\nijkl')
  await expect(editor.locator('.file-editor-status')).toHaveText('INSERT')
})
