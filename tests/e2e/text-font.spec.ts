import { expect, test, type Page } from '@playwright/test'

// テキストのフォント（MAI-75）：デザインパネルから、ノード全体と、選んだ範囲のフォントを変える。
// 同梱の Web フォント（M PLUS 1p）を読み込み終えたら、そのフォントで測り直したレイアウトになることも確かめる（読み込む前に開いたテキスト）。
// サーバーの応答と WebSocket だけを差し替える（rich-text.spec.ts と同じ）

const CANVAS_ID = 'canvas:font-test'

const canvas = {
  typeName: 'canvas', id: CANVAS_ID, title: 'Fonts', parentCanvasId: null, ownerNodeId: null,
  createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
}

function textRecord(text: string, extra: object = {}) {
  return {
    typeName: 'node', id: 'node:text', type: 'text', parentId: CANVAS_ID, x: 100, y: 100, rotation: 0, index: 'a0', opacity: 1, locked: false,
    props: { paragraphs: [{ runs: [{ text }] }], fontSize: 32, color: '#1f2328', align: 'left', w: 200, autoWidth: true, ...extra },
    meta: {}, version: 2,
  }
}

async function openApp(page: Page, records: object[]) {
  const saved = new Map<string, object>()
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [] } }))
  await page.routeWebSocket('**/api/sync', (ws) => {
    let rev = 0
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (message.type === 'hello') ws.send(JSON.stringify({ type: 'changes', rev, records: [], deleted: [] }))
      if (message.type === 'push') {
        for (const record of message.puts) saved.set(record.id, record)
        ws.send(JSON.stringify({ type: 'ack', seq: message.seq, rev: ++rev }))
      }
    })
  })
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
  return saved
}

async function worldToScreen(page: Page, x: number, y: number) {
  const rect = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  return { x: rect.x + x, y: rect.y + y }
}

async function chooseFont(page: Page, label: string) {
  const text = page.getByTestId('design-panel').locator('[data-section="text"]')
  await text.getByRole('button', { name: 'フォント' }).click()
  await text.getByRole('option', { name: label, exact: true }).click()
}

test('changes the font of a whole text and of a range from the design panel', async ({ page }) => {
  // fontFamily を持たない（MAI-75 より前の）テキスト
  const saved = await openApp(page, [canvas, textRecord('hello world')])
  const at = await worldToScreen(page, 120, 115)
  await page.mouse.click(at.x, at.y)
  const fontButton = page.getByTestId('design-panel').getByRole('button', { name: 'フォント' })
  // 古いテキストは既定のフォント
  await expect(fontButton).toHaveText(/ゴシック（標準）/)

  // ノード全体を同梱のフォントにする
  await chooseFont(page, 'M PLUS 1p')
  await expect(fontButton).toHaveText(/M PLUS 1p/)
  await expect.poll(() => (saved.get('node:text') as { props: { fontFamily?: string } } | undefined)?.props.fontFamily).toBe('M PLUS 1p')

  await page.mouse.dblclick(at.x, at.y)
  const editor = page.locator('.canvcode-text-editor')
  await expect(editor).toBeFocused()
  await expect(editor).toHaveCSS('font-family', /M PLUS 1p/)

  // 「world」だけを明朝にする。カーソルだけなら「混在」
  await page.keyboard.press('End')
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft')
  await chooseFont(page, '明朝')
  await expect(editor).toBeFocused()
  await expect(editor.locator('span', { hasText: 'world' })).toHaveCSS('font-family', /serif/)
  await page.keyboard.press('Home')
  await expect(fontButton).toHaveText(/混在/)
  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)
  const propsOf = () => (saved.get('node:text') as { props: { fontFamily: string; paragraphs: unknown } }).props
  await expect.poll(() => propsOf().paragraphs).toEqual([{ runs: [{ text: 'hello ' }, { text: 'world', format: { fontFamily: 'serif' } }] }])
  expect(propsOf().fontFamily).toBe('M PLUS 1p')
})

test('lays out a text in a web font again once the font is loaded', async ({ page }) => {
  // 開いたときは、まだ M PLUS 1p の日本語の字を読み込んでいない（代わりのフォントで測る）
  await openApp(page, [canvas, textRecord('あいうえお日本語', { fontFamily: 'M PLUS 1p' })])
  await expect.poll(() => page.evaluate(() => document.fonts.check('32px "M PLUS 1p"', 'あいうえお日本語'))).toBe(true)

  // 編集用の要素の幅（Canvas で測ったレイアウトの幅 + 余白 0.6em）が、DOM で描いた文字の幅と合う
  // （読み込む前の代わりのフォントの幅のままなら、ずれる）
  const at = await worldToScreen(page, 120, 115)
  await page.mouse.dblclick(at.x, at.y)
  const editor = page.locator('.canvcode-text-editor')
  await expect(editor).toBeFocused()
  const widths = await editor.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element.querySelector('span')!)
    return { text: range.getBoundingClientRect().width, box: element.getBoundingClientRect().width }
  })
  expect(Math.abs(widths.box - 32 * 0.6 - widths.text)).toBeLessThan(1)
})
