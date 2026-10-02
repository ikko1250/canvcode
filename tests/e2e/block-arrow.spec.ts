import { expect, test, type Page } from '@playwright/test'

// ブロック矢印（MAI-87）：右向き・両向き・曲がった矢印・シェブロンが多角形として塗られ（形の外は背景の色）、
// 線（外側）・影が長方形と同じように付くこと。形のハンドルとパネルで軸の太さなどを変えられ、Undo 1 回で戻ること。
// パネルで矩形をブロック矢印に切り替えられること

const CANVAS_ID = 'canvas:block-arrow-test'
const BLUE = { type: 'solid', color: '#1971c2', opacity: 1 }
const RED = { type: 'solid', color: '#e03131', opacity: 1 }
const BLUE_RGB = [0x19, 0x71, 0xc2]
const RED_RGB = [0xe0, 0x31, 0x31]
const GREEN_RGB = [0x2f, 0x9e, 0x44]

function geo(id: string, x: number, y: number, index: string, props: object) {
  return {
    typeName: 'node', id, type: 'geo', parentId: CANVAS_ID, x, y, rotation: 0, index, opacity: 1, locked: false, version: 3,
    props: { shape: 'blockArrow', w: 200, h: 100, fill: BLUE, stroke: null, strokeWidth: 0, label: '', ...props }, meta: {},
  }
}

async function openApp(page: Page) {
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: 'Block arrows', parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  const records = [
    canvas,
    // 右向き（軸は y 125〜175、矢じりは x 250〜300）
    geo('node:right', 100, 100, 'a1', {}),
    // 両向き（矢じりは左右 50）
    geo('node:both', 400, 100, 'a2', { shape: 'blockArrowBoth' }),
    // 曲がった矢印（200 × 120。基準は短い辺 120：軸 36、矢じりの幅 72・長さ 36）
    geo('node:bent', 100, 300, 'a3', { shape: 'blockArrowBent', h: 120 }),
    // シェブロン（切り込みの深さ 50）
    geo('node:chevron', 400, 300, 'a4', { shape: 'chevron' }),
    // 外側の赤い線（6px）と、右下へずらした緑の影
    geo('node:styled', 100, 520, 'a5', {
      stroke: RED,
      strokeWidth: 6,
      strokeAlign: 'outside',
      shadows: [{ type: 'drop', x: 0, y: 30, blur: 0, spread: 0, color: '#2f9e44', opacity: 1 }],
    }),
    // 矩形（パネルで形を切り替える）
    geo('node:rect', 700, 300, 'a6', { shape: 'rect', w: 200, h: 100 }),
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

async function dragWorld(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const a = await screen(page, from.x, from.y)
  const b = await screen(page, to.x, to.y)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 })
  await page.mouse.move(b.x, b.y, { steps: 4 })
  await page.mouse.up()
}

// 画面の 1 画素の色（[r, g, b]）。ポインタを外へ動かして、ホバーの枠を消してから測る
async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  const p = await screen(page, x, y)
  await page.mouse.move(5, 5)
  await page.waitForTimeout(50)
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

const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 12)

async function expectColor(page: Page, x: number, y: number, expected: number[] | 'background', what: string) {
  const color = expected === 'background' ? await pixel(page, 60, 60) : expected
  const actual = await pixel(page, x, y)
  expect(near(actual, color), `${what} at ${x},${y}: ${actual} vs ${color}`).toBe(true)
}

const panel = (page: Page) => page.getByTestId('design-panel')
const shapeSection = (page: Page) => panel(page).locator('[data-section="shape"]')

test('fills each block arrow shape as a polygon', async ({ page }) => {
  await openApp(page)
  // 右向き：軸の中・矢じりの中は青、軸の上下（矢じりの手前）と矢じりの先の角の外は背景
  await expectColor(page, 150, 150, BLUE_RGB, 'right shaft')
  await expectColor(page, 150, 110, 'background', 'above the right shaft')
  await expectColor(page, 260, 118, BLUE_RGB, 'right head')
  await expectColor(page, 295, 110, 'background', 'beside the right tip')
  // 両向き：左右に矢じり
  await expectColor(page, 410, 150, BLUE_RGB, 'left head')
  await expectColor(page, 405, 110, 'background', 'beside the left tip')
  await expectColor(page, 500, 110, 'background', 'above the double shaft')
  await expectColor(page, 590, 150, BLUE_RGB, 'right head of the double arrow')
  // 曲がった矢印：左下の縦の軸と右上の矢じり。右下は空
  await expectColor(page, 115, 410, BLUE_RGB, 'bent vertical shaft')
  await expectColor(page, 200, 410, 'background', 'inside the bend')
  await expectColor(page, 200, 336, BLUE_RGB, 'bent horizontal shaft')
  await expectColor(page, 290, 336, BLUE_RGB, 'bent head')
  // シェブロン：左の切り込みは背景、真ん中は青
  await expectColor(page, 420, 350, 'background', 'chevron notch')
  await expectColor(page, 500, 350, BLUE_RGB, 'chevron body')
  await expectColor(page, 595, 310, 'background', 'beside the chevron tip')
  // 形の外を押しても選ばれない。中を押せば選ばれる
  await clickWorld(page, 150, 108)
  await expect(panel(page)).toHaveCount(0)
  await clickWorld(page, 150, 150)
  await expect(shapeSection(page).getByRole('combobox', { name: '形' })).toHaveValue('blockArrow')
})

test('applies the outside stroke and the drop shadow along the arrow outline', async ({ page }) => {
  await openApp(page)
  // 軸（y 545〜595）の上の縁の外側 6px は赤、軸の中は青
  await expectColor(page, 150, 542, RED_RGB, 'outside stroke above the shaft')
  await expectColor(page, 150, 560, BLUE_RGB, 'fill of the styled shaft')
  await expectColor(page, 150, 532, 'background', 'beyond the stroke')
  // 矢じりの斜めの縁の外も赤（矢じりの先 (300, 570) の右）
  await expectColor(page, 303, 570, RED_RGB, 'outside stroke at the tip')
  // 影は下へ 30：軸の下の縁の線（595〜601）の下、625 までは緑
  await expectColor(page, 150, 612, GREEN_RGB, 'drop shadow below the shaft')
  await expectColor(page, 150, 632, 'background', 'beyond the shadow')
})

test('drags the shape handles to change the shaft and the head, each drag one undo step', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 150, 150)
  const shaft = shapeSection(page).getByRole('textbox', { name: '軸の太さ' })
  const length = shapeSection(page).getByRole('textbox', { name: '先の長さ' })
  const width = shapeSection(page).getByRole('textbox', { name: '先の幅' })
  await expect(shaft).toHaveValue('50')
  // 軸のハンドル（軸の上の縁の真ん中：(175, 125)）を上へ 10 → 軸は 20 太く
  await dragWorld(page, { x: 175, y: 125 }, { x: 175, y: 115 })
  await expect(shaft).toHaveValue('70')
  // 矢じりのハンドル（根もとの角。箱の縁から 10px 内側：(250, 110)）を左へ 20、下へ 5 → 長さ 70、幅 90
  await dragWorld(page, { x: 250, y: 110 }, { x: 230, y: 115 })
  await expect(length).toHaveValue('70')
  await expect(width).toHaveValue('90')
  // 図形は動かない。描いた形も変わる（軸が太くなり、矢じりが左へ伸びる）
  await clickWorld(page, 900, 700)
  await expectColor(page, 150, 118, BLUE_RGB, 'wider shaft')
  await expectColor(page, 235, 150, BLUE_RGB, 'longer head')
  await expectColor(page, 150, 101, 'background', 'above the wider shaft')
  // Undo 1 回ずつ戻る
  await clickWorld(page, 150, 150)
  await page.keyboard.press('Control+z')
  await expect(length).toHaveValue('50')
  await expect(width).toHaveValue('100')
  await page.keyboard.press('Control+z')
  await expect(shaft).toHaveValue('50')
})

test('switches a rectangle to a block arrow with the panel and edits its parameters', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 800, 350)
  const shape = shapeSection(page).getByRole('combobox', { name: '形' })
  await expect(shape).toHaveValue('rect')
  await expect(shapeSection(page).getByRole('textbox', { name: '軸の太さ' })).toHaveCount(0)
  await shape.selectOption('chevron')
  const depth = shapeSection(page).getByRole('textbox', { name: '切り込み' })
  await expect(depth).toHaveValue('50')
  await clickWorld(page, 600, 750)
  await expectColor(page, 735, 350, 'background', 'notch of the switched chevron')
  await expectColor(page, 800, 350, BLUE_RGB, 'body of the switched chevron')
  // 切り込みを 20 % に
  await clickWorld(page, 800, 350)
  await depth.fill('20')
  await depth.press('Enter')
  await clickWorld(page, 600, 750)
  await expectColor(page, 735, 350, BLUE_RGB, 'shallower notch')
  // Undo で切り込み、もう一度で矩形に戻る
  await clickWorld(page, 800, 350)
  await page.keyboard.press('Control+z')
  await expect(depth).toHaveValue('50')
  await page.keyboard.press('Control+z')
  await expect(shape).toHaveValue('rect')
})
