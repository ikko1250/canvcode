import { expect, test, type Page } from '@playwright/test'

// 付箋の Markdown（packages/nodes の richMarkdown.ts）：実際の画面で、編集中に打った **太字** などが書式になり（Undo で打った文字に戻る）、
// 貼り付けた Markdown が書式付きの文字になる。サーバーの応答と WebSocket だけを差し替える（rich-text.spec.ts と同じ）

const CANVAS_ID = 'canvas:note-markdown-test'

const records = [
  { typeName: 'canvas', id: CANVAS_ID, title: 'Markdown', parentCanvasId: null, ownerNodeId: null, createdAt: 0, updatedAt: 0, deletedAt: null, trash: null },
  {
    typeName: 'node', id: 'node:note', type: 'note', parentId: CANVAS_ID, x: 100, y: 100, rotation: 0, index: 'a0', opacity: 1, locked: false, meta: {}, version: 2,
    props: { paragraphs: [{ runs: [{ text: 'memo ' }] }], w: 320, h: 200, color: '#fff3bf', fontSize: 16, fontFamily: 'sans-serif', align: 'left', sizing: 'auto' },
  },
]

async function openApp(page: Page) {
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [] } }))
  await page.routeWebSocket('**/api/sync', (ws) => {
    let rev = 0
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (message.type === 'hello') ws.send(JSON.stringify({ type: 'changes', rev, records: [], deleted: [] }))
      if (message.type === 'push') ws.send(JSON.stringify({ type: 'ack', seq: message.seq, rev: ++rev }))
    })
  })
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
}

// 付箋の文字の終わりで編集を始める
async function editNoteAtEnd(page: Page) {
  const rect = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  await page.mouse.dblclick(rect.x + 130, rect.y + 125)
  const editor = page.locator('.canvcode-text-editor')
  await expect(editor).toBeFocused()
  await page.keyboard.press('End')
  return editor
}

const paragraphsOf = (page: Page) => page.evaluate(() => (window as any).canvcode.editor.getNode('node:note').props.paragraphs)

test('turns typed **bold** and [text]{color=…} into formats, and Ctrl+Z goes back to the typed text', async ({ page }) => {
  await openApp(page)
  await editNoteAtEnd(page)
  await page.keyboard.type('**bold** next')
  await expect.poll(() => paragraphsOf(page)).toEqual([{ runs: [{ text: 'memo ' }, { text: 'bold', format: { fontWeight: 700 } }, { text: ' next' }] }])
  await page.keyboard.type(' [red]{color=#e03131}')
  await expect.poll(() => paragraphsOf(page)).toEqual([
    { runs: [{ text: 'memo ' }, { text: 'bold', format: { fontWeight: 700 } }, { text: ' next ' }, { text: 'red', format: { color: '#e03131' } }] },
  ])
  await page.keyboard.press('Control+z')
  await expect.poll(() => paragraphsOf(page)).toEqual([
    { runs: [{ text: 'memo ' }, { text: 'bold', format: { fontWeight: 700 } }, { text: ' next [red]{color=#e03131}' }] },
  ])
})

test('pastes Markdown as formatted text, and Ctrl+Shift+V pastes it as plain text', async ({ page }) => {
  await openApp(page)
  const editor = await editNoteAtEnd(page)
  // Firefox は、作った ClipboardEvent の clipboardData を空にするので、clipboardData を付けた Event を送る
  const paste = (markdown: string) =>
    editor.evaluate((element, text) => {
      const data = new DataTransfer()
      data.setData('text/plain', text)
      const event = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: data })
      element.dispatchEvent(event)
    }, markdown)
  await paste('**議題**\n- [予算]{color=#e03131} を決める')
  await expect.poll(() => paragraphsOf(page)).toEqual([
    { runs: [{ text: 'memo ' }, { text: '議題', format: { fontWeight: 700 } }] },
    { runs: [{ text: '予算', format: { color: '#e03131' } }, { text: ' を決める' }], list: { type: 'bullet', level: 0 } },
  ])
  await editor.evaluate((element) => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true, bubbles: true })))
  await paste(' **plain**')
  await expect.poll(async () => (await paragraphsOf(page))[1].runs.at(-1)).toEqual({ text: ' を決める **plain**' })
})

test('turns typed "# " into a heading and the next line back into normal text', async ({ page }) => {
  await openApp(page)
  await editNoteAtEnd(page)
  await page.keyboard.press('Enter')
  await page.keyboard.type('# Title')
  await page.keyboard.press('Enter')
  await page.keyboard.type('body')
  // 付箋の文字の大きさ 16 × 1.6 = 25.6 → 26
  await expect.poll(() => paragraphsOf(page)).toEqual([
    { runs: [{ text: 'memo ' }] },
    { runs: [{ text: 'Title', format: { fontWeight: 700, fontSize: 26 } }] },
    { runs: [{ text: 'body' }] },
  ])
})
