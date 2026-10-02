import { expect, test, type Page } from '@playwright/test'

// 太字・斜体・下線・取り消し線（MAI-79）。
// - 太字・斜体の文字（大きさ・フォントの違う run が混ざる行、折り返す行、文字間、リスト、同梱の M PLUS 1p の 700、
//   太字・斜体の書体を持たず合成になるフォント）でも、Canvas の描画と編集中の DOM で文字と下線・取り消し線の位置が合うことを、
//   同じ場所のスクリーンショットの「インクのある行・列」で比べて確かめる（letter-spacing.spec.ts と同じやり方）
// - 編集中の Ctrl+B / I / U、Ctrl+Shift+X と、編集中のツールバーのボタン（フォーカスを奪わない）
// サーバーの応答と WebSocket だけを差し替える（line-height.spec.ts と同じ）

const CANVAS_ID = 'canvas:text-styles-test'

const canvas = {
  typeName: 'canvas', id: CANVAS_ID, title: 'TextStyles', parentCanvasId: null, ownerNodeId: null,
  createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
}

// 1 段落目は 16px の中に 28px の太字・下線が混ざる。2 段落目は日本語の斜体と取り消し線。3 段落目は小さい文字の下線と取り消し線
const paragraphs = [
  { runs: [{ text: 'Hi ' }, { text: 'Big', format: { fontSize: 28, bold: true, underline: true } }, { text: ' text', format: { italic: true } }] },
  { runs: [{ text: '日本語の', format: { strikethrough: true } }, { text: '文字', format: { bold: true, italic: true, strikethrough: true, color: '#c0392b' } }] },
  { runs: [{ text: 'small', format: { fontSize: 11, underline: true, strikethrough: true } }, { text: ' end', format: { bold: true } }] },
]

function textRecord(extra: object = {}, list = paragraphs) {
  return {
    typeName: 'node', id: 'node:text', type: 'text', parentId: CANVAS_ID, x: 100, y: 100, rotation: 0, index: 'a0', opacity: 1, locked: false,
    props: { paragraphs: list, fontSize: 16, color: '#1f2328', fontFamily: 'sans-serif', align: 'left', w: 200, autoWidth: true, ...extra },
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

// Canvas で描いた文字と、編集中の DOM の文字の位置（行の上下、行の中の文字の左右）を比べる（画素は 1px までのずれを許す）。
// 下線は文字との間が空くので、別の「行」として数える（両方で同じ数になることを確かめる）
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


test('bold, italic and the lines sit where the canvas draws them', async ({ page }) => {
  await openApp(page, [canvas, textRecord()])
  await expectEditorMatchesCanvas(page)
})

test('wrapped, centered lines with letter spacing draw the lines per line', async ({ page }) => {
  // 折り返した行ごとに線を引く。行末の文字間の空きには引かない
  await openApp(page, [canvas, textRecord({ letterSpacing: 0.2, autoWidth: false, w: 130, align: 'center' })])
  const lines = await expectEditorMatchesCanvas(page)
  expect(lines.length).toBeGreaterThan(3)
})

test('list items with lines (the markers have no lines)', async ({ page }) => {
  const list = paragraphs.map((p, i) => ({ ...p, list: { type: i === 1 ? 'ordered' : 'bullet', level: i === 2 ? 1 : 0 } }))
  await openApp(page, [canvas, textRecord({}, list)])
  await expectEditorMatchesCanvas(page)
})

test('the bundled M PLUS 1p matches (its 700 face, and the italic the browser synthesizes)', async ({ page }) => {
  await openApp(page, [canvas, textRecord({ fontFamily: 'M PLUS 1p' })])
  await expect.poll(() => page.evaluate(() => document.fonts.check('700 28px "M PLUS 1p"', 'Big'))).toBe(true)
  await page.waitForTimeout(300)
  await expectEditorMatchesCanvas(page)
})

test('the serif and monospace fonts match too (bold / italic may be synthesized for the Japanese glyphs)', async ({ page }) => {
  await openApp(page, [canvas, textRecord({ fontFamily: 'serif' })])
  await expectEditorMatchesCanvas(page)
  await openApp(page, [canvas, textRecord({ fontFamily: 'monospace' })])
  await expectEditorMatchesCanvas(page)
})

test('toggles with Ctrl+B / I / U and Ctrl+Shift+X while editing, and from the toolbar without losing the focus', async ({ page }) => {
  const plain = [{ runs: [{ text: 'hello world' }] }]
  const saved = await openApp(page, [canvas, textRecord({}, plain)])
  const runsOf = () => (saved.get('node:text') as { props: { paragraphs: { runs: object[] }[] } } | undefined)?.props.paragraphs[0].runs
  const at = await worldToScreen(page, 110, 108)
  // 編集していないときの Ctrl+B などは、キャンバスでは何もしない（選んだノードは変わらない）
  await page.mouse.click(at.x, at.y)
  await page.keyboard.press('Control+b')
  await page.keyboard.press('Control+Shift+x')
  await expect(page.getByTestId('text-format-toolbar')).toHaveCount(0)

  await page.mouse.dblclick(at.x, at.y)
  const editor = page.locator('.canvcode-text-editor')
  await expect(editor).toBeFocused()
  const toolbar = page.getByTestId('text-format-toolbar')
  await expect(toolbar).toBeVisible()
  // 「hello」を選ぶ
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Control+b')
  await page.keyboard.press('Control+i')
  await page.keyboard.press('Control+u')
  await page.keyboard.press('Control+Shift+x')
  await expect(editor).toBeFocused()
  await expect(editor.locator('span').first()).toHaveCSS('font-weight', '700')
  await expect(editor.locator('span').first()).toHaveCSS('font-style', 'italic')
  await expect(page.locator('.canvcode-text-decorations [data-decoration]')).toHaveCount(2)
  await expect(toolbar.getByRole('button', { name: '太字' })).toHaveAttribute('aria-pressed', 'true')
  // ツールバーのボタン：押してもフォーカスは編集中の文字のまま。選んでいる範囲もそのまま
  await toolbar.getByRole('button', { name: '太字' }).click()
  await expect(editor).toBeFocused()
  await expect(toolbar.getByRole('button', { name: '太字' })).toHaveAttribute('aria-pressed', 'false')
  // 「hello w」に広げると、斜体は混在
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await expect(toolbar.getByRole('button', { name: '斜体' })).toHaveAttribute('aria-pressed', 'mixed')
  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)
  await expect.poll(runsOf).toEqual([{ text: 'hello', format: { italic: true, underline: true, strikethrough: true } }, { text: ' world' }])

  // カーソルだけで Ctrl+B を押すと、次に打つ文字が太字になる
  await page.mouse.dblclick(at.x, at.y)
  await expect(editor).toBeFocused()
  await page.keyboard.press('End')
  await page.keyboard.press('Control+b')
  await expect(toolbar.getByRole('button', { name: '太字' })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.type('!!')
  await page.keyboard.press('Escape')
  await expect.poll(runsOf).toEqual([
    { text: 'hello', format: { italic: true, underline: true, strikethrough: true } },
    { text: ' world' },
    { text: '!!', format: { bold: true } },
  ])
})
