import { expect, test, type Page } from '@playwright/test'

// 円グラフ（MAI-88）：扇が値の割合・開始角度・ドーナツの穴のとおりに塗られること、
// デザインパネルの表で値・色を変え、CSV/TSV を貼り付けてデータを置き換え、どれも Undo 1 回で戻ること、
// パイメニューの「図形 › 円グラフ」から初期データで置けること

const CANVAS_ID = 'canvas:chart-test'
const RED = [255, 0, 0]
const BLUE = [0, 0, 255]
// テンプレートの色の並び（nodes の CHART_COLORS）の最初の 3 色：青・オレンジ・緑
const AUTO = [
  [0x19, 0x71, 0xc2],
  [0xf0, 0x8c, 0x00],
  [0x2f, 0x9e, 0x44],
]

function chart(id: string, x: number, y: number, index: string, props: object) {
  return {
    typeName: 'node', id, type: 'chart', parentId: CANVAS_ID, x, y, rotation: 0, index, opacity: 1, locked: false, version: 1,
    props: {
      kind: 'pie', w: 240, h: 240, innerRadius: 0, startAngle: 0, showLabels: false, showPercent: false,
      rows: [{ label: 'A', value: 1, color: '#ff0000' }, { label: 'B', value: 1, color: '#0000ff' }],
      ...props,
    },
    meta: {},
  }
}

async function openApp(page: Page) {
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: 'Chart', parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  const records = [
    canvas,
    // 半分ずつ：12 時から時計回りに A（右半分）、B（左半分）
    chart('node:pie', 100, 100, 'a1', {}),
    // ドーナツ（穴 50 %）を 90° 回したもの：A は下半分、B は上半分
    chart('node:donut', 450, 100, 'a2', { innerRadius: 0.5, startAngle: 90 }),
  ]
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [] } }))
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
}

async function screen(page: Page, x: number, y: number) {
  const rect = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  return { x: rect.x + x, y: rect.y + y }
}

async function clickWorld(page: Page, x: number, y: number) {
  const p = await screen(page, x, y)
  await page.mouse.click(p.x, p.y)
}

// 画面の 1 画素の色（[r, g, b]）。ポインタを外へ動かして、ホバーの枠を消してから測る
async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  const p = await screen(page, x, y)
  await page.mouse.move(5, 5)
  await page.waitForTimeout(100)
  const png = await page.screenshot({ clip: { x: p.x, y: p.y, width: 1, height: 1 } })
  return page.evaluate(async (base64) => {
    const image = new Image()
    image.src = `data:image/png;base64,${base64}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(image, 0, 0)
    return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)]
  }, png.toString('base64'))
}

const near = (a: number[], b: number[], tolerance = 16) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance)

async function expectColor(page: Page, x: number, y: number, expected: number[] | 'background', what: string) {
  const want = expected === 'background' ? await pixel(page, 60, 60) : expected
  await expect.poll(async () => near(await pixel(page, x, y), want), { message: `${what} at ${x},${y}` }).toBe(true)
}

test('draws the slices by value, start angle and hole', async ({ page }) => {
  await openApp(page)
  // 円は x 100〜340、y 100〜340（中心 220, 220）
  await expectColor(page, 300, 200, RED, 'first slice on the right')
  await expectColor(page, 140, 240, BLUE, 'second slice on the left')
  await expectColor(page, 108, 108, 'background', 'box corner outside the circle')
  // ドーナツ（中心 570, 220）：90° 回したので A は下、B は上。穴は背景
  await expectColor(page, 570, 310, RED, 'donut first slice at the bottom')
  await expectColor(page, 570, 130, BLUE, 'donut second slice at the top')
  await expectColor(page, 570, 220, 'background', 'donut hole')
})

test('edits values and colors in the panel table, each undoable', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 300, 200)
  const section = page.getByTestId('design-panel').locator('[data-section="chart"]')
  await expect(section).toBeVisible()
  const table = section.getByRole('table', { name: 'データ' })
  await expect(table.getByRole('row')).toHaveCount(2)
  // B を 3 にすると、A は 12 時〜3 時の 1/4 だけ。右下は B になる
  const value = table.getByRole('textbox', { name: '行 2の値' })
  await value.fill('3')
  await value.press('Enter')
  await expectColor(page, 300, 260, BLUE, 'lower right after B grew')
  await expectColor(page, 260, 160, RED, 'upper right stays A')
  // パネルの入力中のキーはキャンバスに渡らない：ラベルに打った Backspace でグラフは消えない
  const label = table.getByRole('textbox', { name: '行 1のラベル' })
  await label.click()
  await label.press('End')
  await label.press('Backspace')
  await label.press('Escape')
  await expect(section).toBeVisible()
  await page.keyboard.press('Control+z')
  await expectColor(page, 300, 260, RED, 'undo restores A on the right half')

  // 行の色をテンプレートの色に戻す（自動の 1 色目は青）
  await table.getByRole('button', { name: '行 1の色を選ぶ' }).click()
  await section.getByRole('button', { name: '自動に戻す' }).click()
  await expectColor(page, 300, 200, AUTO[0], 'automatic color of row 1')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+z')
  await expectColor(page, 300, 200, RED, 'undo restores the chosen color')
})

test('replaces the data with a pasted table, as one undo step', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 300, 200)
  const section = page.getByTestId('design-panel').locator('[data-section="chart"]')
  const table = section.getByRole('table', { name: 'データ' })
  const label = table.getByRole('textbox', { name: '行 1のラベル' })
  await label.click()
  // 表計算からのコピー（見出しの行つきの TSV）を、表のセルに貼り付ける
  await label.evaluate((input) => {
    const data = new DataTransfer()
    data.setData('text/plain', '品目\t数\nX\t1\nY\t1\nZ\t2\n')
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(table.getByRole('row')).toHaveCount(3)
  await expect(table.getByRole('textbox', { name: '行 3のラベル' })).toHaveValue('Z')
  await expect(table.getByRole('textbox', { name: '行 3の値' })).toHaveValue('2')
  // 色はテンプレートの色を行の順に：X（12〜3 時）青、Y（3〜6 時）オレンジ、Z（左半分）緑
  await expectColor(page, 260, 160, AUTO[0], 'X')
  await expectColor(page, 260, 280, AUTO[1], 'Y')
  await expectColor(page, 160, 220, AUTO[2], 'Z')
  await page.keyboard.press('Escape')
  await page.locator('.canvas-container > div[tabindex]').focus()
  await page.keyboard.press('Control+z')
  await expectColor(page, 160, 220, BLUE, 'undo restores the old data')
  await clickWorld(page, 300, 200)
  await expect(table.getByRole('row')).toHaveCount(2)
})

test('places a pie chart with initial data from the pie menu', async ({ page }) => {
  await openApp(page)
  const at = await screen(page, 700, 520)
  await page.mouse.move(at.x, at.y)
  await page.keyboard.down('a')
  await page.locator('.pie-item', { hasText: '図形' }).click({ force: true })
  await page.locator('.pie-item', { hasText: '円グラフ' }).click({ force: true })
  await page.keyboard.up('a')
  await clickWorld(page, 700, 520)
  const section = page.getByTestId('design-panel').locator('[data-section="chart"]')
  await expect(section.getByRole('table', { name: 'データ' }).getByRole('row')).toHaveCount(3)
  await page.keyboard.press('Escape')
  // 初期データ 50・30・20：右半分が 1 行目（自動の青）。ラベルの文字を避けて測る
  await expectColor(page, 730, 440, AUTO[0], 'first slice of the new chart')
  await expectColor(page, 680, 420, AUTO[2], 'third slice of the new chart')
})
