import { expect, test, type Page } from '@playwright/test'

// 箇条書き・番号付きリスト（MAI-78）：記号・番号とぶら下げインデントが、編集中の文字（contenteditable の ::before と左の余白）と
// Canvas の描画で同じ位置に来ることを、同じ場所のスクリーンショットで、行ごとの「インクのある列」を比べて確かめる（letter-spacing.spec.ts と同じ）。
// キー操作（「- 」の変換・Tab・Enter）とデザインパネルの記号の選択も確かめる。サーバーの応答と WebSocket だけを差し替える

const CANVAS_ID = 'canvas:list-test'

const canvas = {
  typeName: 'canvas', id: CANVAS_ID, title: 'Lists', parentCanvasId: null, ownerNodeId: null,
  createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
}

// 番号付き（大きい文字で始まる項目）、入れ子の箇条書き、折り返す項目、リストでない段落、丸数字
const paragraphs = [
  { runs: [{ text: 'First item' }], list: { type: 'ordered', level: 0 } },
  { runs: [{ text: 'Big', format: { fontSize: 24, color: '#1f2328' } }, { text: ' second' }], list: { type: 'ordered', level: 0 } },
  { runs: [{ text: 'nested bullet' }], list: { type: 'bullet', level: 1 } },
  { runs: [{ text: 'deeper' }], list: { type: 'bullet', level: 2, style: 'dash' } },
  { runs: [{ text: 'plain paragraph' }] },
  { runs: [{ text: '丸数字の項目' }], list: { type: 'ordered', level: 0, style: 'circled' } },
]

function textRecord(extra: object = {}, list: object[] = paragraphs) {
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
    // 1px の隙間は、文字の小数点以下の位置による描き方の違い（アンチエイリアス）で出たり消えたりするので、つなげて数える
    const merged = (columns: [number, number][]) =>
      columns.reduce<[number, number][]>((out, column) => {
        const last = out.at(-1)
        if (last && column[0] - last[1] <= 2) last[1] = column[1]
        else out.push([...column])
        return out
      }, [])
    return rows.map(([top, bottom]) => ({
      rows: [top, bottom] as [number, number],
      columns: merged(
        runs(image.width, (x) => {
          for (let y = top; y <= bottom; y++) if (ink(x, y)) return true
          return false
        }),
      ),
    }))
  }, png.toString('base64'))
}

// Canvas で描いた文字と、編集中の DOM の文字の位置（行の上下、行の中の文字・記号の左右）を比べる（画素は 1px までのずれを許す）
// width は写す幅（右揃えでは、編集中の選択枠が行末の文字に重なるので、枠の手前までにする）
async function expectEditorMatchesCanvas(page: Page, width = 420) {
  const empty = await worldToScreen(page, 700, 600)
  await page.mouse.click(empty.x, empty.y)
  const clip = { ...(await worldToScreen(page, 60, 95)), width, height: 300 }
  await page.waitForTimeout(200)
  const drawn = await inkLines(page, await page.screenshot({ clip }))

  const at = await worldToScreen(page, 140, 108)
  await page.mouse.dblclick(at.x, at.y)
  const editor = page.locator('.canvcode-text-editor')
  await expect(editor).toBeFocused()
  await editor.evaluate((element) => {
    element.style.caretColor = 'transparent'
    window.getSelection()?.removeAllRanges()
  })
  await page.waitForTimeout(200)
  const editing = await inkLines(page, await page.screenshot({ clip }))
  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)

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

test('markers and hanging indents of the editing DOM sit where the canvas draws them', async ({ page }) => {
  await openApp(page, [canvas, textRecord()])
  const lines = await expectEditorMatchesCanvas(page)
  expect(lines.length).toBe(6)
  // 記号・番号は文字の左（1 行目は「1.」から、入れ子は右へずれる）
  expect(lines[2].columns[0][0]).toBeGreaterThan(lines[0].columns[0][0])
  expect(lines[4].columns[0][0]).toBeLessThan(lines[0].columns[0][0])
})

test('wrapped lines hang under the text', async ({ page }) => {
  await openApp(page, [canvas, textRecord({ autoWidth: false, w: 150 })])
  const lines = await expectEditorMatchesCanvas(page)
  expect(lines.length).toBeGreaterThan(6)
  await page.close()
})

for (const align of ['center', 'right']) {
  test(`${align}-aligned lists match too`, async ({ page }) => {
    await openApp(page, [canvas, textRecord({ autoWidth: false, w: 220, align })])
    // 文字の箱の右端（ワールドの x = 320）の手前まで
    await expectEditorMatchesCanvas(page, align === 'right' ? 257 : 420)
  })
}

test('types "- ", Tab and Enter to build a list, and picks a marker style in the design panel', async ({ page }) => {
  const saved = await openApp(page, [canvas, textRecord({}, [{ runs: [{ text: 'title' }] }])])
  const propsOf = () => (saved.get('node:text') as { props: { paragraphs: { runs: { text: string }[]; list?: object }[] } } | undefined)?.props
  const at = await worldToScreen(page, 110, 108)
  await page.mouse.dblclick(at.x, at.y)
  const editor = page.locator('.canvcode-text-editor')
  await expect(editor).toBeFocused()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('- one')
  await page.keyboard.press('Enter')
  await page.keyboard.type('two')
  await page.keyboard.press('Tab')
  // Tab で編集は終わらず、フォーカスも移らない
  await expect(editor).toBeFocused()
  await expect(editor.locator('div[data-list-marker]')).toHaveCount(2)
  await expect(editor.locator('div[data-list-marker]').nth(1)).toHaveAttribute('data-list-marker', '◦')
  await expect(editor).toHaveText('titleonetwo')
  // 空の項目で Enter → 階層を上げる → リストを抜ける
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await expect(editor.locator('div').nth(3)).toHaveAttribute('data-list-marker', '•')
  await page.keyboard.press('Enter')
  await expect(editor.locator('div').nth(3)).not.toHaveAttribute('data-list-marker')
  await page.keyboard.type('end')

  // デザインパネル：「one」から「two」までを選んで番号付き（丸数字）にする。丸数字は一番浅い「one」に当たり、
  // 入れ子の「two」は番号付きの既定（a.）になる
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+End')
  const select = page.getByTestId('design-panel').locator('[data-section="text"]').getByRole('combobox', { name: '記号' })
  await expect(select).toHaveValue('disc')
  await select.selectOption('circled')
  await expect(editor).toBeFocused()
  await expect(editor.locator('div').nth(1)).toHaveAttribute('data-list-marker', '①')
  await expect(editor.locator('div').nth(2)).toHaveAttribute('data-list-marker', 'a.')
  await page.keyboard.press('Escape')
  await expect.poll(() => propsOf()?.paragraphs.map((p) => p.list ?? null)).toEqual([
    null,
    { type: 'ordered', level: 0, style: 'circled' },
    { type: 'ordered', level: 1 },
    null,
  ])
  await expectEditorMatchesCanvas(page)
})
