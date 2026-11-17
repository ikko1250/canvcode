import { expect, test, type Page } from '@playwright/test'

// DADS のプリセット（MAI-114）：カラーピッカーに DADS の色の見本が出て、押すとその色が入ること。
// デザインパネルの「文字」のテキストスタイルを選ぶと、大きさ・太さ・行間・字間の 4 つがまとめて入り、Undo 1 回で戻ること。
// 値が違えば「カスタム」、選んだノードの間で違えば「混在」と出ること。編集中に選んだ範囲には、大きさ・太さだけが当たること。
// サーバーの応答だけを差し替える（design-panel.spec.ts と同じ）。値はキーを打って入れる（firefox では fill のあとの Enter で入らないことがある）

const CANVAS_ID = 'canvas:dads-presets-test'
const WHITE = { type: 'solid', color: '#ffffff', opacity: 1 }
const GRAY = { type: 'solid', color: '#666666', opacity: 1 }

function node(id: string, type: string, x: number, y: number, index: string, props: object) {
  return { typeName: 'node', id, type, parentId: CANVAS_ID, x, y, rotation: 0, index, opacity: 1, locked: false, props, meta: {}, version: type === 'geo' ? 3 : 2 }
}

async function openApp(page: Page) {
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: 'DADS', parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  const records = [
    canvas,
    node('node:geo', 'geo', 100, 120, 'a0', { shape: 'rect', w: 200, h: 80, fill: WHITE, stroke: GRAY, strokeWidth: 1, label: 'ボタン' }),
    node('node:text', 'text', 100, 300, 'a1', {
      paragraphs: [{ runs: [{ text: 'hello world' }] }], fontSize: 16, color: '#1f2328', fontFamily: 'sans-serif', align: 'left', w: 200, autoWidth: true,
    }),
  ]
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [] } }))
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
}

// 選ぶ（カメラは最初 (0, 0)・倍率 1）
async function clickWorld(page: Page, x: number, y: number, modifiers: 'Shift'[] = []) {
  const rect = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  for (const key of modifiers) await page.keyboard.down(key)
  await page.mouse.click(rect.x + x, rect.y + y)
  for (const key of modifiers) await page.keyboard.up(key)
}

const propsOf = (page: Page, id: string) => page.evaluate((id) => (window as any).canvcode.editor.getNode(id).props as Record<string, any>, id)

const panel = (page: Page) => page.getByTestId('design-panel')
const textSection = (page: Page) => panel(page).locator('[data-section="text"]')
const styleSelect = (page: Page) => textSection(page).getByRole('combobox', { name: 'テキストスタイル（DADS）' })
// 選んでいる（見えている）選択肢の名前
const shownStyle = (page: Page) => styleSelect(page).locator('option:checked')

// 数字の欄にキーを打って Enter で確定する
async function typeInto(page: Page, name: string, value: string) {
  await textSection(page).getByRole('textbox', { name, exact: true }).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type(value)
  await page.keyboard.press('Enter')
}

// 大きさ・太さ・行間・字間の欄の値
async function expectMetrics(page: Page, size: string, weight: string, lineHeight: string, spacing: string) {
  const text = textSection(page)
  await expect(text.getByRole('textbox', { name: '大きさ', exact: true })).toHaveValue(size)
  await expect(text.getByRole('combobox', { name: '太さ', exact: true })).toHaveValue(weight)
  await expect(text.getByRole('textbox', { name: '行間', exact: true })).toHaveValue(lineHeight)
  await expect(text.getByRole('textbox', { name: '文字間', exact: true })).toHaveValue(spacing)
}

test('the color picker has the DADS key, neutral and semantic colors, and picking one sets the color', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 200, 140)
  const fill = panel(page).locator('[data-section="fill"]')
  await fill.getByRole('button', { name: '色を選ぶ' }).click()
  const picker = fill.getByRole('dialog', { name: '色のカラーピッカー' })
  const key = picker.getByRole('group', { name: 'テンプレート：DADS キーカラー' })
  const neutral = picker.getByRole('group', { name: 'テンプレート：DADS ニュートラル' })
  const semantic = picker.getByRole('group', { name: 'テンプレート：DADS セマンティック' })
  await expect(key.locator('[data-color]')).toHaveCount(6)
  await expect(neutral.locator('[data-color]')).toHaveCount(8)
  await expect(semantic.locator('[data-color]')).toHaveCount(8)
  // ツールチップは DADS の名前と HEX
  await expect(key.locator('[data-color="#0017c1"]')).toHaveAttribute('title', 'Blue-900（#0017c1）')
  await expect(semantic.locator('[data-color="#ec0000"]')).toHaveAttribute('title', 'Error-1（#ec0000）')

  await key.getByRole('button', { name: 'Blue-50 #e8f1fe' }).click()
  await expect(fill.locator('input.design-hex')).toHaveValue('#e8f1fe')
  await expect.poll(async () => (await propsOf(page, 'node:geo')).fill).toEqual({ type: 'solid', color: '#e8f1fe', opacity: 1 })
  await expect(key.locator('[data-color="#e8f1fe"]')).toHaveClass(/selected/)
  await semantic.getByRole('button', { name: 'Success-1 #259d63' }).click()
  await expect(fill.locator('input.design-hex')).toHaveValue('#259d63')

  // 見本を押すのは 1 回の変更。Esc で閉じて Undo 1 回で 1 つ前の色に戻る
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  await page.keyboard.press('Control+z')
  await expect(fill.locator('input.design-hex')).toHaveValue('#e8f1fe')

  // 文字の色も同じピッカー
  await panel(page).getByRole('tab', { name: '文字' }).click()
  const color = textSection(page).locator('.design-color-field')
  await color.getByRole('button', { name: '色を選ぶ' }).click()
  await color.getByRole('group', { name: 'テンプレート：DADS ニュートラル' }).getByRole('button', { name: 'Solid Gray-800 #333333' }).click()
  await expect(color.locator('input.design-hex')).toHaveValue('#333333')
  await expect.poll(async () => (await propsOf(page, 'node:geo')).labelColor).toBe('#333333')
})

test('a DADS text style sets the size, weight, line height and letter spacing at once, and one undo restores them', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 130, 310)
  await expect(styleSelect(page)).toBeVisible()
  // 16px・400・1.35 倍・0 % はどのスタイルでもない
  await expect(shownStyle(page)).toHaveText('カスタム')
  await expectMetrics(page, '16', '400', '1.35', '0')

  await styleSelect(page).selectOption('Std-24B-150')
  await expect(shownStyle(page)).toHaveText('Std-24B-150')
  await expectMetrics(page, '24', '700', '1.5', '2')
  await expect.poll(() => propsOf(page, 'node:text')).toMatchObject({ fontSize: 24, fontWeight: 700, lineHeight: { unit: 'multiplier', value: 1.5 }, letterSpacing: 0.02 })

  // 選んだあとはキャンバスにフォーカスが戻り、Undo 1 回で 4 つとも戻る。やり直しも 1 回
  await page.keyboard.press('Control+z')
  await expectMetrics(page, '16', '400', '1.35', '0')
  await expect(shownStyle(page)).toHaveText('カスタム')
  await page.keyboard.press('Control+Shift+z')
  await expect(shownStyle(page)).toHaveText('Std-24B-150')

  // 1 つの値を変えると「カスタム」。値をスタイルにそろえると、その名前に戻る
  await typeInto(page, '文字間', '3')
  await expect(shownStyle(page)).toHaveText('カスタム')
  await typeInto(page, '文字間', '2')
  await expect(shownStyle(page)).toHaveText('Std-24B-150')

  // Mono はフォントも等幅にする
  await styleSelect(page).selectOption('Mono-16N-150')
  await expect(panel(page).getByRole('button', { name: 'フォント' })).toHaveText(/等幅/)
  await expectMetrics(page, '16', '400', '1.5', '0')
})

test('shows mixed for nodes with different values, and applies a style to a shape and a text at once', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 130, 310)
  await styleSelect(page).selectOption('Std-17N-170')
  await clickWorld(page, 200, 140, ['Shift'])
  await expect(panel(page).locator('.design-panel-title')).toHaveText('2 個')
  await expect(shownStyle(page)).toHaveText('混在')

  await styleSelect(page).selectOption('Dns-16B-130')
  await expect(shownStyle(page)).toHaveText('Dns-16B-130')
  await expect.poll(() => propsOf(page, 'node:geo')).toMatchObject({ labelFontSize: 16, labelFontWeight: 700, labelLineHeight: { unit: 'multiplier', value: 1.3 }, labelLetterSpacing: 0 })
  await expect.poll(() => propsOf(page, 'node:text')).toMatchObject({ fontSize: 16, fontWeight: 700, lineHeight: { unit: 'multiplier', value: 1.3 }, letterSpacing: 0 })
  // Undo 1 回で両方戻る
  await page.keyboard.press('Control+z')
  await expect(shownStyle(page)).toHaveText('混在')
  await expect.poll(async () => (await propsOf(page, 'node:geo')).labelFontSize).toBeUndefined()
  expect((await propsOf(page, 'node:text')).fontSize).toBe(17)
})

test('while editing, the size and weight go to the selected characters and the line height to the node', async ({ page }) => {
  await openApp(page)
  const rect = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  await page.mouse.dblclick(rect.x + 130, rect.y + 310)
  const editor = page.locator('.canvcode-text-editor')
  await expect(editor).toBeFocused()
  await page.keyboard.press('Home')
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight')
  await styleSelect(page).selectOption('Std-28B-150')
  // 編集は続き、選んだ範囲の値を見せる
  await expect(editor).toBeFocused()
  await expect(shownStyle(page)).toHaveText('Std-28B-150')
  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)
  const props = await propsOf(page, 'node:text')
  expect(props.paragraphs).toEqual([{ runs: [{ text: 'hello', format: { fontSize: 28, fontWeight: 700 } }, { text: ' world' }] }])
  expect(props).toMatchObject({ fontSize: 16, lineHeight: { unit: 'multiplier', value: 1.5 }, letterSpacing: 0.01 })
  // ノード全体では、大きさが違うので「混在」
  await expect(shownStyle(page)).toHaveText('混在')
})
