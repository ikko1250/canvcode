import { expect, test, type Page } from '@playwright/test'

// テキストの文字間（MAI-77）：デザインパネルから % で変える（props には em で入る）。
// 大きさの違う文字が混ざる行・折り返す行・中央揃えでも、編集中の文字（contenteditable の CSS letter-spacing）と Canvas の描画で
// 文字の位置が合うことを、同じ場所のスクリーンショットで、行ごとの「インクのある列」を比べて確かめる。
// Canvas2D の ctx.letterSpacing を消したブラウザ（文字ごとに描くフォールバック）でも確かめる。
// サーバーの応答と WebSocket だけを差し替える（line-height.spec.ts と同じ）

const CANVAS_ID = 'canvas:letter-spacing-test'

const canvas = {
  typeName: 'canvas', id: CANVAS_ID, title: 'LetterSpacing', parentCanvasId: null, ownerNodeId: null,
  createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
}

// 1 段落目は 16px の中に 28px の文字が混ざる（em は run の大きさで換算する）
const paragraphs = [
  { runs: [{ text: 'Hi ' }, { text: 'Big', format: { fontSize: 28 } }, { text: ' text' }] },
  { runs: [{ text: '日本語の文字' }] },
  { runs: [{ text: 'small', format: { fontSize: 11 } }, { text: ' end' }] },
]

function textRecord(extra: object = {}) {
  return {
    typeName: 'node', id: 'node:text', type: 'text', parentId: CANVAS_ID, x: 100, y: 100, rotation: 0, index: 'a0', opacity: 1, locked: false,
    props: { paragraphs, fontSize: 16, color: '#1f2328', fontFamily: 'sans-serif', align: 'left', w: 200, autoWidth: true, ...extra },
    meta: {}, version: 2,
  }
}

async function openApp(page: Page, records: object[], { noCanvasLetterSpacing = false } = {}) {
  const saved = new Map<string, object>()
  await page.addInitScript(() => localStorage.clear())
  if (noCanvasLetterSpacing) {
    // ctx.letterSpacing を持たない古いブラウザのふり
    await page.addInitScript(() => {
      for (const proto of [CanvasRenderingContext2D.prototype, OffscreenCanvasRenderingContext2D.prototype]) delete (proto as { letterSpacing?: string }).letterSpacing
    })
  }
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

interface InkLine {
  rows: [number, number]
  // その行の中で、暗い画素がある列の続き（[左端, 右端]）
  columns: [number, number][]
}

// スクリーンショットの中で、暗い（文字の）画素がある行の続きと、その中の列の続きを返す
async function inkLines(page: Page, png: Buffer): Promise<InkLine[]> {
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
    const ink = (x: number, y: number) => {
      const i = (y * image.width + x) * 4
      return data[i] < 110 && data[i + 1] < 110 && data[i + 2] < 110
    }
    const runs = (length: number, has: (i: number) => boolean) => {
      const result: [number, number][] = []
      let start = -1
      for (let i = 0; i <= length; i++) {
        const on = i < length && has(i)
        if (on && start < 0) start = i
        if (!on && start >= 0) {
          result.push([start, i - 1])
          start = -1
        }
      }
      return result
    }
    const rows = runs(image.height, (y) => {
      for (let x = 0; x < image.width; x++) if (ink(x, y)) return true
      return false
    })
    return rows.map(([top, bottom]) => ({
      rows: [top, bottom] as [number, number],
      columns: runs(image.width, (x) => {
        for (let y = top; y <= bottom; y++) if (ink(x, y)) return true
        return false
      }),
    }))
  }, png.toString('base64'))
}

// Canvas で描いた文字と、編集中の DOM の文字の位置（行の上下、行の中の文字の左右）を比べる（画素は 1px までのずれを許す）
async function expectEditorMatchesCanvas(page: Page, lineCount?: number) {
  const empty = await worldToScreen(page, 700, 600)
  await page.mouse.click(empty.x, empty.y)
  const clip = { ...(await worldToScreen(page, 60, 95)), width: 420, height: 200 }
  await page.waitForTimeout(200)
  const drawn = await inkLines(page, await page.screenshot({ clip }))

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
  const editing = await inkLines(page, await page.screenshot({ clip }))
  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)

  if (lineCount !== undefined) expect(drawn.length).toBe(lineCount)
  expect(editing.length).toBe(drawn.length)
  for (const [i, line] of drawn.entries()) {
    expect(Math.abs(editing[i].rows[0] - line.rows[0])).toBeLessThanOrEqual(1)
    expect(Math.abs(editing[i].rows[1] - line.rows[1])).toBeLessThanOrEqual(1)
    expect(editing[i].columns.length).toBe(line.columns.length)
    for (const [k, [left, right]] of line.columns.entries()) {
      expect(Math.abs(editing[i].columns[k][0] - left)).toBeLessThanOrEqual(1)
      expect(Math.abs(editing[i].columns[k][1] - right)).toBeLessThanOrEqual(1)
    }
  }
  return drawn
}

for (const noCanvasLetterSpacing of [false, true]) {
  const how = noCanvasLetterSpacing ? 'without ctx.letterSpacing' : 'with ctx.letterSpacing'
  test(`characters of the editing DOM sit where the canvas draws them (${how})`, async ({ page }) => {
    await openApp(page, [canvas, textRecord({ letterSpacing: 0.3 })], { noCanvasLetterSpacing })
    await expectEditorMatchesCanvas(page, 3)
  })

  test(`wraps and centers lines with the spacing counted (${how})`, async ({ page }) => {
    // 文字間なしなら 2 行目（日本語 6 文字 × 16px = 96px）は 120px に収まるが、0.3em（4.8px × 6）を足すと折り返す
    await openApp(page, [canvas, textRecord({ letterSpacing: 0.3, autoWidth: false, w: 120, align: 'center' })], { noCanvasLetterSpacing })
    const lines = await expectEditorMatchesCanvas(page)
    expect(lines.length).toBeGreaterThan(3)
  })
}

test('negative spacing also matches', async ({ page }) => {
  await openApp(page, [canvas, textRecord({ letterSpacing: -0.05, align: 'right', autoWidth: false, w: 260 })])
  await expectEditorMatchesCanvas(page, 3)
})

test('changes the letter spacing from the design panel in % of the font size', async ({ page }) => {
  // letterSpacing を持たない（MAI-77 より前の）テキスト
  const saved = await openApp(page, [canvas, textRecord()])
  const at = await worldToScreen(page, 110, 112)
  await page.mouse.click(at.x, at.y)
  const input = page.getByTestId('design-panel').locator('[data-section="text"]').getByRole('textbox', { name: '文字間' })
  await expect(input).toHaveValue('0')

  const propsOf = () => (saved.get('node:text') as { props: { letterSpacing?: unknown } } | undefined)?.props
  await input.fill('20%')
  await input.press('Enter')
  await expect.poll(() => propsOf()?.letterSpacing).toBe(0.2)
  await input.press('ArrowDown')
  await expect(input).toHaveValue('19.5')
  await expect.poll(() => propsOf()?.letterSpacing).toBe(0.195)

  // 編集中の文字の CSS も合わせる（em は要素ごとの大きさで換算する）
  await page.mouse.dblclick(at.x, at.y)
  const editor = page.locator('.canvcode-text-editor')
  await expect(editor).toBeFocused()
  await expect(editor).toHaveCSS('letter-spacing', `${0.195 * 16}px`)
  await expect(editor.locator('span', { hasText: 'Big' })).toHaveCSS('letter-spacing', `${0.195 * 28}px`)
  await page.keyboard.press('Escape')
  await expectEditorMatchesCanvas(page, 3)
})
