import { expect, test, type Page } from '@playwright/test'

// デザインパネル（MAI-73）：実際の React の画面で、選んだ図形・テキストのプロパティをパネルから変えられること、
// 1 回の変更（スライダーのドラッグを含む）が Undo 1 回で戻ること、パネルの中のキーがキャンバスに渡らないことを確かめる。
// サーバーの応答だけを差し替える（app-input.spec.ts と同じ）

const CANVAS_ID = 'canvas:design-test'

function node(id: string, type: string, x: number, y: number, index: string, props: object) {
  return { typeName: 'node', id, type, parentId: CANVAS_ID, x, y, rotation: 0, index, opacity: 1, locked: false, props, meta: {} }
}

async function openApp(page: Page) {
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: 'Design', parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  const records = [
    canvas,
    node('node:geoA', 'geo', 100, 120, 'a0', { shape: 'rect', w: 120, h: 120, fill: '#e8eefc', stroke: '#3b5bdb', strokeWidth: 2, label: '' }),
    node('node:geoB', 'geo', 300, 120, 'a1', { shape: 'ellipse', w: 120, h: 120, fill: '#ffc9c9', stroke: '#3b5bdb', strokeWidth: 2, label: '' }),
    node('node:text', 'text', 500, 320, 'a2', { text: 'hello', fontSize: 16, color: '#1f2328', align: 'left', w: 200, autoWidth: true }),
  ]
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [] } }))
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
}

// 選ぶ（ノードの真ん中をクリック）。カメラは最初 (0, 0)・倍率 1
async function clickWorld(page: Page, x: number, y: number, modifiers: ('Shift')[] = []) {
  const rect = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  for (const key of modifiers) await page.keyboard.down(key)
  await page.mouse.click(rect.x + x, rect.y + y)
  for (const key of modifiers) await page.keyboard.up(key)
}

test('changes geo fill / stroke / stroke width from the panel, each undoable', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 160, 180)
  const panel = page.getByTestId('design-panel')
  await expect(panel).toBeVisible()
  await expect(panel.locator('[data-section="fill"]')).toBeVisible()
  await expect(panel.locator('[data-section="text"]')).toHaveCount(0)

  const fill = panel.locator('[data-section="fill"] input.design-hex')
  await expect(fill).toHaveValue('#e8eefc')
  await fill.fill('#ff8800')
  await fill.press('Enter')
  await expect(fill).toHaveValue('#ff8800')

  const strokeWidth = panel.locator('[data-section="stroke"] .design-number input')
  await strokeWidth.fill('6')
  await strokeWidth.press('Enter')
  await expect(strokeWidth).toHaveValue('6')

  // Enter のあとはキャンバスにフォーカスが戻り、Ctrl+Z で 1 つずつ戻る
  await page.keyboard.press('Control+z')
  await expect(strokeWidth).toHaveValue('2')
  await expect(fill).toHaveValue('#ff8800')
  await page.keyboard.press('Control+z')
  await expect(fill).toHaveValue('#e8eefc')
  await page.keyboard.press('Control+Shift+z')
  await expect(fill).toHaveValue('#ff8800')
})

test('a slider drag is one undo step', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 160, 180)
  const panel = page.getByTestId('design-panel')
  const slider = panel.locator('[data-section="stroke"] input.design-slider')
  const strokeWidth = panel.locator('[data-section="stroke"] .design-number input')
  const box = (await slider.boundingBox())!
  await page.mouse.move(box.x + 4, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 10 })
  await page.mouse.up()
  const dragged = Number(await strokeWidth.inputValue())
  expect(dragged).toBeGreaterThan(10)
  // フォーカスをキャンバスに戻して Undo 1 回で、ドラッグ前の値に戻る
  await clickWorld(page, 160, 180)
  await page.keyboard.press('Control+z')
  await expect(strokeWidth).toHaveValue('2')
})

test('shows mixed values and only common fields for a multi selection', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 160, 180)
  await clickWorld(page, 360, 180, ['Shift'])
  const panel = page.getByTestId('design-panel')
  await expect(panel.locator('.design-panel-count')).toHaveText('2 個')
  const fill = panel.locator('[data-section="fill"] input.design-hex')
  await expect(fill).toHaveValue('')
  await expect(fill).toHaveAttribute('placeholder', '混在')
  // 1 回で両方が変わり、Undo 1 回で両方戻る
  await fill.fill('#00aa00')
  await fill.press('Enter')
  await expect(fill).toHaveValue('#00aa00')
  await page.keyboard.press('Control+z')
  await expect(fill).toHaveAttribute('placeholder', '混在')

  // 図形とテキスト：共通なのは不透明度だけ
  await clickWorld(page, 515, 330, ['Shift'])
  await expect(panel.locator('.design-panel-count')).toHaveText('3 個')
  await expect(panel.locator('.design-section')).toHaveCount(1)
  await expect(panel.locator('[data-section="layer"]')).toBeVisible()
})

test('changes text font size / color / align, and keys in the panel do not reach the canvas', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 515, 330)
  const panel = page.getByTestId('design-panel')
  const text = panel.locator('[data-section="text"]')
  await expect(text).toBeVisible()

  const size = text.getByRole('textbox', { name: '大きさ', exact: true })
  await size.fill('32')
  // パネルの中の Backspace・矢印キー・a（パイメニュー）は、ノードを消したり動かしたりしない
  await size.press('Backspace')
  await size.press('a')
  await size.fill('32')
  await size.press('Enter')
  await expect(size).toHaveValue('32')

  const color = text.locator('input.design-hex')
  await color.fill('#e03131')
  await color.press('Enter')
  await expect(color).toHaveValue('#e03131')

  await text.getByTitle('中央揃え').click()
  await expect(text.getByTitle('中央揃え')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.pie-menu')).toHaveCount(0)

  // テキストは消えていない（Backspace がキャンバスに渡っていない）。Undo 3 回で元に戻る
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z')
  await expect(size).toHaveValue('16')
  await expect(color).toHaveValue('#1f2328')
  await expect(text.getByTitle('左揃え')).toHaveAttribute('aria-pressed', 'true')
})

test('the panel can be closed and reopened', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 160, 180)
  const panel = page.getByTestId('design-panel')
  await panel.getByTitle('閉じる').click()
  await expect(panel).toHaveCount(0)
  await page.getByTitle('デザインパネルを開く').click()
  await expect(page.getByTestId('design-panel')).toBeVisible()
  // 何も選んでいなければ出さない
  await clickWorld(page, 700, 600)
  await expect(page.getByTestId('design-panel')).toHaveCount(0)
})
