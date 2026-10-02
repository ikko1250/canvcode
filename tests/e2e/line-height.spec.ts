import { expect, test, type Page } from '@playwright/test'

// テキストの行間（MAI-76）：デザインパネルから倍率と px で変える。
// 行の中に大きさの違う文字が混ざっていても、編集中の文字（contenteditable の CSS line-height）と Canvas の描画で行の位置が合うことを、
// 同じ場所のスクリーンショットの「インクのある行」を比べて確かめる。
// サーバーの応答と WebSocket だけを差し替える（rich-text.spec.ts と同じ）

const CANVAS_ID = 'canvas:line-height-test'

const canvas = {
  typeName: 'canvas', id: CANVAS_ID, title: 'LineHeight', parentCanvasId: null, ownerNodeId: null,
  createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
}

// 1 段落目は 16px の中に 32px の文字が混ざる
const paragraphs = [
  { runs: [{ text: 'Hello ' }, { text: 'Big', format: { fontSize: 32 } }, { text: ' world' }] },
  { runs: [{ text: 'second line' }] },
  { runs: [{ text: 'tiny', format: { fontSize: 10 } }, { text: ' third' }] },
]

function textRecord(extra: object = {}) {
  return {
    typeName: 'node', id: 'node:text', type: 'text', parentId: CANVAS_ID, x: 100, y: 100, rotation: 0, index: 'a0', opacity: 1, locked: false,
    props: { paragraphs, fontSize: 16, color: '#1f2328', fontFamily: 'sans-serif', align: 'left', w: 200, autoWidth: true, ...extra },
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

// スクリーンショットの中で、暗い（文字の）画素がある行の続きを [上端, 下端] で返す
async function inkRows(page: Page, png: Buffer): Promise<[number, number][]> {
  return page.evaluate(async (base64) => {
    const image = new Image()
    image.src = `data:image/png;base64,${base64}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(image, 0, 0)
    const { data } = ctx.getImageData(0, 0, image.width, image.height)
    const runs: [number, number][] = []
    let start = -1
    for (let y = 0; y <= image.height; y++) {
      let ink = false
      for (let x = 0; y < image.height && x < image.width && !ink; x++) {
        const i = (y * image.width + x) * 4
        ink = data[i] < 110 && data[i + 1] < 110 && data[i + 2] < 110
      }
      if (ink && start < 0) start = y
      if (!ink && start >= 0) {
        runs.push([start, y - 1])
        start = -1
      }
    }
    return runs
  }, png.toString('base64'))
}

// Canvas で描いた文字と、編集中の DOM の文字の、行ごとの上下の位置を比べる（スクリーンショットの画素は 1px までのずれを許す）
async function expectEditorMatchesCanvas(page: Page) {
  const empty = await worldToScreen(page, 700, 600)
  await page.mouse.click(empty.x, empty.y)
  const clip = { ...(await worldToScreen(page, 95, 95)), width: 260, height: 200 }
  await page.waitForTimeout(200)
  const drawn = await inkRows(page, await page.screenshot({ clip }))

  const at = await worldToScreen(page, 110, 112)
  await page.mouse.dblclick(at.x, at.y)
  const editor = page.locator('.canvcode-text-editor')
  await expect(editor).toBeFocused()
  // カーソルと選択の色を消して、文字だけを写す
  await editor.evaluate((element) => {
    element.style.caretColor = 'transparent'
    window.getSelection()?.removeAllRanges()
  })
  await page.waitForTimeout(200)
  const editing = await inkRows(page, await page.screenshot({ clip }))
  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)

  expect(drawn.length).toBe(3)
  expect(editing.length).toBe(drawn.length)
  for (const [i, [top, bottom]] of drawn.entries()) {
    expect(Math.abs(editing[i][0] - top)).toBeLessThanOrEqual(1)
    expect(Math.abs(editing[i][1] - bottom)).toBeLessThanOrEqual(1)
  }
  return drawn
}

for (const lineHeight of [undefined, { unit: 'multiplier', value: 2.2 }, { unit: 'px', value: 44 }]) {
  test(`lines of the editing DOM sit where the canvas draws them (${lineHeight ? `${lineHeight.value} ${lineHeight.unit}` : 'default'})`, async ({ page }) => {
    await openApp(page, [canvas, textRecord(lineHeight ? { lineHeight } : {})])
    await expectEditorMatchesCanvas(page)
  })
}

test('changes the line height from the design panel as a multiplier and in pixels', async ({ page }) => {
  // lineHeight を持たない（MAI-76 より前の）テキスト
  const saved = await openApp(page, [canvas, textRecord()])
  const at = await worldToScreen(page, 110, 112)
  await page.mouse.click(at.x, at.y)
  const text = page.getByTestId('design-panel').locator('[data-section="text"]')
  const input = text.getByRole('textbox', { name: '行間' })
  const multiplier = text.getByRole('button', { name: '×' })
  const px = text.getByRole('button', { name: 'px' })
  await expect(input).toHaveValue('1.35')
  await expect(multiplier).toHaveAttribute('aria-pressed', 'true')

  const propsOf = () => (saved.get('node:text') as { props: { lineHeight?: unknown } } | undefined)?.props
  await input.fill('2')
  await input.press('Enter')
  await expect.poll(() => propsOf()?.lineHeight).toEqual({ unit: 'multiplier', value: 2 })

  // 単位を px にすると、見た目を変えずに換算する（16px × 2）
  await px.click()
  await expect(input).toHaveValue('32')
  await expect.poll(() => propsOf()?.lineHeight).toEqual({ unit: 'px', value: 32 })
  // 「150%」は倍率
  await input.fill('150%')
  await input.press('Enter')
  await expect(input).toHaveValue('1.5')
  await expect(multiplier).toHaveAttribute('aria-pressed', 'true')
  await input.fill('40px')
  await input.press('Enter')
  await expect.poll(() => propsOf()?.lineHeight).toEqual({ unit: 'px', value: 40 })

  // 編集中の文字の CSS も合わせる
  await page.mouse.dblclick(at.x, at.y)
  const editor = page.locator('.canvcode-text-editor')
  await expect(editor).toBeFocused()
  await expect(editor).toHaveCSS('line-height', '40px')
  await page.keyboard.press('Escape')
  await expectEditorMatchesCanvas(page)
})

test('a sticky note grows with its line height', async ({ page }) => {
  const note = {
    typeName: 'node', id: 'node:note', type: 'note', parentId: CANVAS_ID, x: 100, y: 100, rotation: 0, index: 'a0', opacity: 1, locked: false,
    props: { paragraphs: [{ runs: [{ text: 'a' }] }, { runs: [{ text: 'b' }] }, { runs: [{ text: 'c' }] }], w: 220, h: 60, color: '#fff3bf', fontSize: 20, align: 'left' },
    meta: {}, version: 2,
  }
  const saved = await openApp(page, [canvas, note])
  const at = await worldToScreen(page, 150, 120)
  await page.mouse.click(at.x, at.y)
  const input = page.getByTestId('design-panel').getByRole('textbox', { name: '行間' })
  await expect(input).toHaveValue('1.4')
  await input.fill('60px')
  await input.press('Enter')
  await expect.poll(() => (saved.get('node:note') as { props: { lineHeight?: unknown } } | undefined)?.props.lineHeight).toEqual({ unit: 'px', value: 60 })
  // 3 行 × 60px + 上下の余白。編集用の箱も同じ高さ
  await page.mouse.dblclick(at.x, at.y)
  const editor = page.locator('.canvcode-text-editor')
  await expect(editor).toBeFocused()
  const height = await editor.evaluate((element) => element.getBoundingClientRect().height)
  expect(height).toBeCloseTo(180, 0)
})
