import { expect, test, type Page } from '@playwright/test'

// 範囲ごとに書式を持てるテキスト（MAI-74）：実際の画面で、テキストの一部の文字を選んで、デザインパネルから色・大きさを変える。
// 保存したレコード（/api/sync に送ったもの）で開き直し、同じに見えることを確かめる。
// サーバーの応答と WebSocket だけを差し替える（design-panel.spec.ts と同じ）

const CANVAS_ID = 'canvas:rich-text-test'

const canvas = {
  typeName: 'canvas', id: CANVAS_ID, title: 'Rich', parentCanvasId: null, ownerNodeId: null,
  createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
}

function node(id: string, type: string, x: number, y: number, index: string, props: object, version?: number) {
  return { typeName: 'node', id, type, parentId: CANVAS_ID, x, y, rotation: 0, index, opacity: 1, locked: false, props, meta: {}, ...(version ? { version } : {}) }
}

// 版 1（プレーンテキスト）のテキストと付箋。読み込むときに版 2 へ移る
const legacyRecords = [
  canvas,
  node('node:text', 'text', 100, 100, 'a0', { text: 'hello world', fontSize: 16, color: '#1f2328', align: 'left', w: 200, autoWidth: true }),
  node('node:note', 'note', 100, 300, 'a1', { text: 'memo', w: 220, h: 160, color: '#fff3bf', fontSize: 16, align: 'left' }),
]

// サーバーの代わり。送られてきたレコードを覚える
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

test('formats part of a text from the design panel and looks the same after reopening', async ({ page, browser }) => {
  const saved = await openApp(page, legacyRecords)
  const at = await worldToScreen(page, 120, 110)
  await page.mouse.dblclick(at.x, at.y)
  const editor = page.locator('.canvcode-text-editor')
  await expect(editor).toBeFocused()
  await expect(editor).toHaveText('hello world')

  // 「world」を選ぶ
  await page.keyboard.press('End')
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft')
  const panel = page.getByTestId('design-panel')
  const text = panel.locator('[data-section="text"]')
  const color = text.locator('input.design-hex')
  const size = text.locator('.design-number input')
  await expect(color).toHaveValue('#1f2328')

  // パネルに入れても編集は続き、選んだ範囲だけが変わる。Enter のあとは文字にフォーカスが戻る
  await color.fill('#e03131')
  await color.press('Enter')
  await expect(editor).toBeFocused()
  await size.fill('32')
  await size.press('Enter')
  await expect(editor).toBeFocused()
  await expect(color).toHaveValue('#e03131')
  await expect(size).toHaveValue('32')
  const world = editor.locator('span', { hasText: 'world' })
  await expect(world).toHaveCSS('color', 'rgb(224, 49, 49)')
  await expect(world).toHaveCSS('font-size', '32px')

  // 選んでいない文字は元のまま。カーソルだけなら、ノード全体の値（違えば「混在」）
  await page.keyboard.press('Home')
  await expect(color).toHaveValue('')
  await expect(color).toHaveAttribute('placeholder', '混在')

  // 続けて打った文字は、直前の文字の書式
  await page.keyboard.press('End')
  await page.keyboard.type('!')
  await expect(editor.locator('span', { hasText: 'world!' })).toHaveCSS('color', 'rgb(224, 49, 49)')

  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)
  await expect.poll(() => (saved.get('node:text') as { version?: number } | undefined)?.version).toBe(2)
  const record = saved.get('node:text') as { props: { paragraphs: unknown } }
  expect(record.props.paragraphs).toEqual([
    { runs: [{ text: 'hello ' }, { text: 'world!', format: { color: '#e03131', fontSize: 32 } }] },
  ])

  // 保存したレコードで開き直すと、同じに見える（選択の枠を外してから比べる）
  const empty = await worldToScreen(page, 700, 600)
  await page.mouse.click(empty.x, empty.y)
  const clip = { ...(await worldToScreen(page, 90, 90)), width: 260, height: 70 }
  await page.waitForTimeout(300)
  const before = await page.screenshot({ clip })
  const reopened = await browser.newPage({ viewport: page.viewportSize()! })
  await openApp(reopened, [canvas, record, legacyRecords[2]])
  await reopened.waitForTimeout(300)
  const after = await reopened.screenshot({ clip })
  await test.info().attach('before', { body: before, contentType: 'image/png' })
  await test.info().attach('after', { body: after, contentType: 'image/png' })
  expect(after.equals(before)).toBe(true)
  await reopened.close()
})

test('types Japanese with an IME into a sticky note and keeps the format of the range', async ({ page }) => {
  await openApp(page, legacyRecords)
  const at = await worldToScreen(page, 200, 360)
  await page.mouse.dblclick(at.x, at.y)
  const editor = page.locator('.canvcode-text-editor')
  await expect(editor).toBeFocused()
  await page.keyboard.press('End')

  const client = await page.context().newCDPSession(page)
  await client.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 })
  await expect(editor).toHaveText('memoにほん')
  await client.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 })
  await client.send('Input.insertText', { text: '日本' })
  await expect(editor).toHaveText('memo日本')
  // 確定したあとで改行して、続けて打つ
  await page.keyboard.press('Enter')
  await page.keyboard.type('next')
  await expect(editor.locator('div')).toHaveCount(2)

  // 付箋の文字も、範囲を選んで色を変えられる
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft')
  const color = page.getByTestId('design-panel').locator('[data-section="text"] input.design-hex')
  await color.fill('#1971c2')
  await color.press('Enter')
  await expect(editor.locator('span', { hasText: 'next' })).toHaveCSS('color', 'rgb(25, 113, 194)')
  await expect(editor.locator('span', { hasText: 'memo日本' })).toHaveCSS('color', 'rgb(43, 41, 48)')

  // 編集中の Undo（Ctrl+Z）は、文字の編集だけを戻す
  await page.keyboard.press('Control+z')
  await expect(editor.locator('span', { hasText: 'next' })).toHaveCSS('color', 'rgb(43, 41, 48)')
  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)
})
