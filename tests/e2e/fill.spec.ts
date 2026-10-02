import { expect, test, type Page } from '@playwright/test'

// 図形の塗り（MAI-81）：デザインパネルの塗りの項目とカラーピッカーで、色・不透明度・塗りなしを変えられること。
// 描いた色は、スクリーンショットの画素で確かめる。サーバーの応答だけを差し替える（design-panel.spec.ts と同じ）

const CANVAS_ID = 'canvas:fill-test'

function node(id: string, type: string, x: number, y: number, index: string, props: object) {
  return { typeName: 'node', id, type, parentId: CANVAS_ID, x, y, rotation: 0, index, opacity: 1, locked: false, props, meta: {} }
}

async function openApp(page: Page) {
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: 'Fill', parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  // 版 1（fill が色の文字列）のまま渡す。読み込むときに単色の塗りへ移る
  const records = [
    canvas,
    node('node:back', 'geo', 140, 160, 'a0', { shape: 'rect', w: 40, h: 40, fill: '#1f2328', stroke: '#1f2328', strokeWidth: 0, label: '' }),
    node('node:geoA', 'geo', 100, 120, 'a1', { shape: 'rect', w: 120, h: 120, fill: '#ff0000', stroke: '#3b5bdb', strokeWidth: 2, label: '' }),
    node('node:geoB', 'geo', 300, 120, 'a2', { shape: 'ellipse', w: 120, h: 120, fill: '#ffc9c9', stroke: '#3b5bdb', strokeWidth: 2, label: '' }),
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

// 画面の 1 画素の色（[r, g, b]）
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

function expectColor(actual: number[], expected: number[], tolerance = 6) {
  for (let i = 0; i < 3; i++) expect(Math.abs(actual[i] - expected[i]), `channel ${i}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance)
}

test('changes the fill opacity and removes the fill; a shape without fill is hit only on its outline', async ({ page }) => {
  await openApp(page)
  // 塗りの見えるところ（下の黒い図形と重ならないところ）
  expectColor(await pixel(page, 115, 135), [255, 0, 0])

  await clickWorld(page, 115, 135)
  const fill = page.getByTestId('design-panel').locator('[data-section="fill"]')
  await expect(fill.locator('input.design-hex')).toHaveValue('#ff0000')
  const opacity = fill.getByRole('textbox', { name: '色の不透明度' })
  await expect(opacity).toHaveValue('100')
  await opacity.fill('50')
  await opacity.press('Enter')
  await expect(opacity).toHaveValue('50')
  // 赤が半分になる（下地は白に近い）
  const half = await pixel(page, 115, 135)
  expect(half[0]).toBeGreaterThan(240)
  expect(half[1]).toBeGreaterThan(100)
  expect(half[1]).toBeLessThan(150)

  // 塗りなし：中は下地、枠の線は残る
  await clickWorld(page, 115, 135)
  await fill.getByRole('button', { name: '塗りなしにする' }).click()
  await expect(fill.locator('input.design-hex')).toHaveAttribute('placeholder', 'なし')
  await expect(opacity).toHaveCount(0)
  const empty = await pixel(page, 115, 135)
  expect(Math.min(...empty)).toBeGreaterThan(220)

  // 選んだままなら、中の何もないところを押しても選んだまま
  await clickWorld(page, 115, 135)
  // 図形は見た目と文字のタブに分かれる。開いているのは見た目のタブ
  await expect(page.getByTestId('design-panel').getByRole('tab', { selected: true })).toHaveAccessibleName('図形')
  // 選びを外すと、中を押しても選ばれない。下の図形の上を押すと、下の図形が選ばれる
  await clickWorld(page, 700, 600)
  await clickWorld(page, 115, 135)
  await expect(page.getByTestId('design-panel')).toHaveCount(0)
  await clickWorld(page, 160, 180)
  await expect(fill.locator('input.design-hex')).toHaveValue('#1f2328')
  // 枠の線を押すと選べる。＋で前の塗りに戻る
  await clickWorld(page, 100.5, 135)
  await expect(fill.locator('input.design-hex')).toHaveAttribute('placeholder', 'なし')
  await fill.getByRole('button', { name: '塗りを足す' }).click()
  await expect(fill.locator('input.design-hex')).toHaveValue('#ff0000')
  await expect(opacity).toHaveValue('50')

  // Undo で 1 つずつ戻る
  await page.keyboard.press('Control+z')
  await expect(fill.locator('input.design-hex')).toHaveAttribute('placeholder', 'なし')
  await page.keyboard.press('Control+z')
  await expect(opacity).toHaveValue('50')
  await page.keyboard.press('Control+z')
  await expect(opacity).toHaveValue('100')
})

test('picks colors from the picker: template colors, colors used on this canvas, and the color square', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 115, 135)
  const fill = page.getByTestId('design-panel').locator('[data-section="fill"]')
  await fill.getByRole('button', { name: '色を選ぶ' }).click()
  const picker = fill.getByRole('dialog', { name: '色のカラーピッカー' })
  await expect(picker).toBeVisible()

  // このキャンバスで使った色（使っている数の多い順）
  const used = picker.getByRole('group', { name: 'このキャンバスで使った色' })
  await expect(used.locator('[data-color]')).toHaveCount(4)
  await expect(used.locator('[data-color]').first()).toHaveAttribute('data-color', /#1f2328|#3b5bdb/)
  await used.locator('[data-color="#ffc9c9"]').click()
  await expect(fill.locator('input.design-hex')).toHaveValue('#ffc9c9')

  // テンプレート：スライドのテーマ色
  const slide = picker.getByRole('group', { name: 'テンプレート：スライド' })
  await slide.locator('[data-color="#d9d9d9"]').click()
  await expect(fill.locator('input.design-hex')).toHaveValue('#d9d9d9')
  expectColor(await pixel(page, 115, 135), [217, 217, 217])

  // 四角のドラッグは、離すまでで Undo 1 回
  const square = picker.getByRole('slider', { name: '色の彩度と明度' })
  const box = (await square.boundingBox())!
  await page.mouse.move(box.x + box.width - 2, box.y + 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 })
  await page.mouse.move(box.x + box.width - 1, box.y + 1, { steps: 5 })
  await page.mouse.up()
  const dragged = await fill.locator('input.design-hex').inputValue()
  expect(dragged).not.toBe('#d9d9d9')
  // Esc で閉じて、キャンバスで Undo
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  await clickWorld(page, 115, 135)
  await page.keyboard.press('Control+z')
  await expect(fill.locator('input.design-hex')).toHaveValue('#d9d9d9')
})

// 図形の線（MAI-85）は単色の塗り：同じピッカーで、不透明度も持つ（グラデーション・画像は選べない）
test('uses the same picker for stroke colors (solid only, with opacity)', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 115, 135)
  const stroke = page.getByTestId('design-panel').locator('[data-section="stroke"]')
  await stroke.getByRole('button', { name: '色を選ぶ' }).click()
  const picker = stroke.getByRole('dialog')
  await expect(picker).toBeVisible()
  await expect(picker.getByRole('slider', { name: '色の不透明度のスライダー' })).toHaveCount(1)
  await expect(picker.getByRole('button', { name: '線形のグラデーション' })).toHaveCount(0)
  await picker.getByRole('group', { name: 'テンプレート：キャンバス' }).locator('[data-color="#e03131"]').click()
  await expect(stroke.locator('input.design-hex')).toHaveValue('#e03131')
})
