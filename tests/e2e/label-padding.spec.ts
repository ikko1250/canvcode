import { expect, test, type Page } from '@playwright/test'

// 図形の文字の余白と縦の揃え（MAI-115）：デザインパネルの「文字」のタブで、縦の揃え（上・上下中央・下）と
// 余白（四方まとめて・辺ごと）を変えると props が変わり、1 回の変更が Undo 1 回で戻ること。
// 複数を選んで値が違えば「混在」と出ること。編集を始めても、文字の位置が Canvas の描画から動かないこと。
// サーバーの応答だけを差し替える（design-panel.spec.ts と同じ）

const CANVAS_ID = 'canvas:label-padding-test'
const WHITE = { type: 'solid', color: '#ffffff', opacity: 1 }
const GRAY = { type: 'solid', color: '#666666', opacity: 1 }

function node(id: string, x: number, y: number, index: string, props: object) {
  return {
    typeName: 'node', id, type: 'geo', parentId: CANVAS_ID, x, y, rotation: 0, index, opacity: 1, locked: false, version: 3,
    props: { shape: 'rect', w: 240, h: 120, fill: WHITE, stroke: GRAY, strokeWidth: 1, label: '', ...props }, meta: {},
  }
}

async function openApp(page: Page) {
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: 'Label', parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  const records = [
    canvas,
    // 余白・縦の揃えを持たない（古いデータ：四方 8・上下の中央）
    node('node:a', 100, 120, 'a1', { label: 'テキスト', labelAlign: 'left' }),
    // DADS の通知バナー（上 24・左右 24・下 32）、上揃え
    node('node:b', 400, 120, 'a2', { label: 'お知らせ', labelAlign: 'left', labelVerticalAlign: 'top', labelPadding: { top: 24, right: 24, bottom: 32, left: 24 } }),
  ]
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [] } }))
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
}

async function screen(page: Page, x: number, y: number) {
  const rect = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  return { x: rect.x + x, y: rect.y + y }
}

// 選ぶ（カメラは最初 (0, 0)・倍率 1）
async function clickWorld(page: Page, x: number, y: number, modifiers: 'Shift'[] = []) {
  const p = await screen(page, x, y)
  for (const key of modifiers) await page.keyboard.down(key)
  await page.mouse.click(p.x, p.y)
  for (const key of modifiers) await page.keyboard.up(key)
}

const propsOf = (page: Page, id: string) =>
  page.evaluate((id) => {
    const props = (window as any).canvcode.editor.getNode(id).props
    return { labelPadding: props.labelPadding, labelVerticalAlign: props.labelVerticalAlign }
  }, id)

const panel = (page: Page) => page.getByTestId('design-panel')
const labelBox = (page: Page) => panel(page).locator('[data-section="label-box"]')

async function openTextTab(page: Page) {
  await panel(page).getByRole('tab', { name: '文字' }).click()
  await expect(labelBox(page)).toBeVisible()
}

test('changes the vertical align of a shape label from the panel, each one undo step', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 220, 180)
  await openTextTab(page)
  const align = labelBox(page).getByRole('group', { name: '縦の揃え' })
  // 持たない図形は上下の中央
  await expect(align.getByRole('button', { name: '上下中央揃え' })).toHaveAttribute('aria-pressed', 'true')

  await align.getByRole('button', { name: '下揃え' }).click()
  await expect(align.getByRole('button', { name: '下揃え' })).toHaveAttribute('aria-pressed', 'true')
  expect((await propsOf(page, 'node:a')).labelVerticalAlign).toBe('bottom')
  await align.getByRole('button', { name: '上揃え' }).click()
  expect((await propsOf(page, 'node:a')).labelVerticalAlign).toBe('top')

  // ボタンはフォーカスを奪わないので、そのまま Ctrl+Z で 1 つずつ戻る
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await propsOf(page, 'node:a')).labelVerticalAlign).toBe('bottom')
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await propsOf(page, 'node:a')).labelVerticalAlign).toBeUndefined()
  await expect(align.getByRole('button', { name: '上下中央揃え' })).toHaveAttribute('aria-pressed', 'true')
})

test('changes the padding of all sides or of each side, each one undo step', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 220, 180)
  await openTextTab(page)
  const padding = labelBox(page).getByRole('textbox', { name: '余白', exact: true })
  await expect(padding).toHaveValue('8')

  // 四方まとめて（DADS の入力欄の上下 12）
  await padding.fill('12')
  await padding.press('Enter')
  await expect(padding).toHaveValue('12')
  expect((await propsOf(page, 'node:a')).labelPadding).toBe(12)

  // 辺ごとに：左右を 16 に
  await labelBox(page).getByRole('button', { name: '辺ごとに変える' }).click()
  const left = labelBox(page).getByRole('textbox', { name: '左', exact: true })
  const right = labelBox(page).getByRole('textbox', { name: '右', exact: true })
  await expect(labelBox(page).getByRole('textbox', { name: '上', exact: true })).toHaveValue('12')
  await left.fill('16')
  await left.press('Enter')
  await right.fill('16')
  await right.press('Enter')
  expect((await propsOf(page, 'node:a')).labelPadding).toEqual({ top: 12, right: 16, bottom: 12, left: 16 })
  // 辺の値が違うので、まとめた入力は「混在」
  await expect(padding).toHaveValue('')
  await expect(padding).toHaveAttribute('placeholder', '混在')

  // Undo 1 回ずつ：右、左、四方の順に戻る
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await propsOf(page, 'node:a')).labelPadding).toEqual({ top: 12, right: 12, bottom: 12, left: 16 })
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await propsOf(page, 'node:a')).labelPadding).toBe(12)
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await propsOf(page, 'node:a')).labelPadding).toBeUndefined()
  await expect(padding).toHaveValue('8')
})

test('a padding slider drag is one undo step', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 220, 180)
  await openTextTab(page)
  const slider = labelBox(page).locator('input.design-slider')
  const box = (await slider.boundingBox())!
  await page.mouse.move(box.x + 4, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 10 })
  await page.mouse.up()
  const dragged = (await propsOf(page, 'node:a')).labelPadding as number
  expect(dragged).toBeGreaterThan(16)
  await clickWorld(page, 220, 180)
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await propsOf(page, 'node:a')).labelPadding).toBeUndefined()
})

test('shows mixed values for shapes with different padding and vertical align, and changes both at once', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 220, 180)
  await clickWorld(page, 520, 180, ['Shift'])
  await openTextTab(page)
  const align = labelBox(page).getByRole('group', { name: '縦の揃え' })
  for (const name of ['上揃え', '上下中央揃え', '下揃え']) await expect(align.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false')
  const padding = labelBox(page).getByRole('textbox', { name: '余白', exact: true })
  await expect(padding).toHaveAttribute('placeholder', '混在')
  // 辺の値が違う図形を選んでいるので、はじめから辺ごとに出す（上は 8 と 24 で「混在」）
  await expect(labelBox(page).getByRole('textbox', { name: '上', exact: true })).toHaveAttribute('placeholder', '混在')

  await align.getByRole('button', { name: '下揃え' }).click()
  expect((await propsOf(page, 'node:a')).labelVerticalAlign).toBe('bottom')
  expect((await propsOf(page, 'node:b')).labelVerticalAlign).toBe('bottom')
  await padding.fill('16')
  await padding.press('Enter')
  expect((await propsOf(page, 'node:a')).labelPadding).toBe(16)
  expect((await propsOf(page, 'node:b')).labelPadding).toBe(16)
  await expect(padding).toHaveValue('16')

  // 1 回の Undo で両方戻る
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await propsOf(page, 'node:b')).labelPadding).toEqual({ top: 24, right: 24, bottom: 32, left: 24 })
  expect((await propsOf(page, 'node:a')).labelPadding).toBeUndefined()
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await propsOf(page, 'node:b')).labelVerticalAlign).toBe('top')
  expect((await propsOf(page, 'node:a')).labelVerticalAlign).toBeUndefined()
})

// 図形の中の濃い画素（文字）を囲む箱（画面の CSS ピクセル）。線（#666）・選択枠（青）は数えない
async function inkBox(page: Page, world: { x: number; y: number; w: number; h: number }) {
  const p = await screen(page, world.x, world.y)
  const png = await page.screenshot({ clip: { x: p.x, y: p.y, width: world.w, height: world.h } })
  return page.evaluate(async (base64) => {
    const image = new Image()
    image.src = `data:image/png;base64,${base64}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(image, 0, 0)
    const data = ctx.getImageData(0, 0, image.width, image.height).data
    let top = Infinity
    let bottom = -Infinity
    let left = Infinity
    let right = -Infinity
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const i = (y * image.width + x) * 4
        if (data[i] < 90 && data[i + 1] < 90 && data[i + 2] < 90) {
          top = Math.min(top, y)
          bottom = Math.max(bottom, y)
          left = Math.min(left, x)
          right = Math.max(right, x)
        }
      }
    }
    return { top, bottom, left, right }
  }, png.toString('base64'))
}

test('keeps the text where the canvas drew it when editing starts, for each vertical align', async ({ page }) => {
  await openApp(page)
  // 点滅するキャレットを数えない
  await page.addStyleTag({ content: '[contenteditable] { caret-color: transparent !important; }' })
  await clickWorld(page, 220, 180)
  await openTextTab(page)
  const align = labelBox(page).getByRole('group', { name: '縦の揃え' })
  // 線と選択枠を除いた、図形の内側
  const inside = { x: 104, y: 124, w: 232, h: 112 }
  const tops: number[] = []
  for (const name of ['上揃え', '上下中央揃え', '下揃え']) {
    await align.getByRole('button', { name }).click()
    await page.mouse.move(5, 5)
    await page.waitForTimeout(100)
    const drawn = await inkBox(page, inside)
    // Enter で編集を始めると文字全体を選ぶので、→ で選択を外して（文字の色に戻して）から測る
    await page.keyboard.press('Enter')
    await expect(page.locator('[contenteditable]')).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(100)
    const editing = await inkBox(page, inside)
    await page.keyboard.press('Escape')
    await expect(page.locator('[contenteditable]')).toHaveCount(0)
    for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
      expect(Math.abs(editing[edge] - drawn[edge]), `${name} ${edge}: ${editing[edge]} vs ${drawn[edge]}`).toBeLessThanOrEqual(1.5)
    }
    tops.push(drawn.top)
  }
  // 上・中央・下の順に下がる
  expect(tops[0]).toBeLessThan(tops[1])
  expect(tops[1]).toBeLessThan(tops[2])
})
