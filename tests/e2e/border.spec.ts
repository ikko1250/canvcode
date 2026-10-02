import { expect, test, type Page } from '@playwright/test'

// 図形のボーダー（MAI-85）：線の位置（内側・中央・外側）、破線・点線、線の不透明度・線なしが、画素のとおりに描かれること。
// デザインパネルの線の項目（色は PaintField、位置・種類・長さ・間隔は図形だけ）で変えられ、Undo 1 回で戻ること。
// 矢印と混ぜて選んでも、共通の色と太さは変えられること

const CANVAS_ID = 'canvas:border-test'
const BLUE = { type: 'solid', color: '#1971c2', opacity: 1 }
const RED = { type: 'solid', color: '#ff0000', opacity: 1 }
const RED_RGB = [255, 0, 0]
const BLUE_RGB = [0x19, 0x71, 0xc2]

function geo(id: string, x: number, y: number, index: string, props: object, version = 3) {
  return {
    typeName: 'node', id, type: 'geo', parentId: CANVAS_ID, x, y, rotation: 0, index, opacity: 1, locked: false, version,
    props: { shape: 'rect', w: 160, h: 80, fill: BLUE, stroke: RED, strokeWidth: 10, label: '', ...props }, meta: {},
  }
}

async function openApp(page: Page) {
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: 'Border', parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  const records = [
    canvas,
    geo('node:center', 100, 100, 'a1', {}),
    geo('node:inside', 350, 100, 'a2', { strokeAlign: 'inside' }),
    geo('node:outside', 600, 100, 'a3', { strokeAlign: 'outside' }),
    // 破線（長さ 20・間隔 20）と点線（間隔 10。点の中心は 20 ごと）
    geo('node:dashed', 100, 300, 'a4', { fill: null, strokeDash: 'dashed', strokeDashLength: 20, strokeDashGap: 20 }),
    geo('node:dotted', 350, 300, 'a5', { fill: null, strokeDash: 'dotted', strokeDashGap: 10 }),
    // 古いデータ（版 2：線が色の文字列）
    geo('node:old', 600, 300, 'a6', { stroke: '#ff0000', strokeWidth: 10 }, 2),
    // 外側の楕円（縁の外の線）、線の不透明度 50%
    geo('node:ellipse', 100, 500, 'a7', { shape: 'ellipse', strokeAlign: 'outside', stroke: { ...RED, opacity: 0.5 } }),
    {
      typeName: 'node', id: 'node:arrow', type: 'arrow', parentId: CANVAS_ID, x: 400, y: 560, rotation: 0, index: 'a8', opacity: 1, locked: false,
      props: { start: { x: 0, y: 0 }, end: { x: 200, y: 0 }, bend: 0, clip: [0, 1], color: '#1f2328', size: 4, arrowheadStart: 'none', arrowheadEnd: 'arrow', label: '' }, meta: {},
    },
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

async function clickWorld(page: Page, x: number, y: number, modifiers: ('Shift')[] = []) {
  const p = await screen(page, x, y)
  for (const key of modifiers) await page.keyboard.down(key)
  await page.mouse.click(p.x, p.y)
  for (const key of modifiers) await page.keyboard.up(key)
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
  const actual = await pixel(page, x, y)
  expect(near(actual, want), `${what} at ${x},${y}: ${actual} vs ${want}`).toBe(true)
}

test('draws the border inside, centered on, or outside the edge', async ({ page }) => {
  await openApp(page)
  // 中央：縁（x=100）の外 3px も内 3px も線、外 8px は背景
  await expectColor(page, 97, 140, RED_RGB, 'center outer half')
  await expectColor(page, 103, 140, RED_RGB, 'center inner half')
  await expectColor(page, 92, 140, 'background', 'center beyond')
  // 内側：縁の外は背景、内の 0〜10px が線、その内は塗り
  await expectColor(page, 347, 140, 'background', 'inside beyond')
  await expectColor(page, 353, 140, RED_RGB, 'inside')
  await expectColor(page, 358, 140, RED_RGB, 'inside')
  await expectColor(page, 363, 140, BLUE_RGB, 'inside fill')
  // 外側：縁の外の 0〜10px が線、内はすぐ塗り
  await expectColor(page, 597, 140, RED_RGB, 'outside')
  await expectColor(page, 592, 140, RED_RGB, 'outside')
  await expectColor(page, 587, 140, 'background', 'outside beyond')
  await expectColor(page, 603, 140, BLUE_RGB, 'outside fill')
  // 外側の楕円：上の縁（y=500）の外 5px は、半透明の赤（白の背景に 50%）
  const half = await pixel(page, 180, 495)
  expect(near(half, [255, 128, 128], 24), `translucent outside border: ${half}`).toBe(true)
  await expectColor(page, 180, 505, BLUE_RGB, 'ellipse fill')
  await expectColor(page, 180, 488, 'background', 'ellipse beyond')
  // 古いデータ（色の文字列）も、中央の線として描ける
  await expectColor(page, 597, 340, RED_RGB, 'old record')
})

test('draws dashed and dotted borders', async ({ page }) => {
  await openApp(page)
  // 破線：上の縁を左上の角から、長さ 20 の線と 20 の間
  await expectColor(page, 110, 297, RED_RGB, 'dash')
  await expectColor(page, 130, 297, 'background', 'gap')
  await expectColor(page, 150, 297, RED_RGB, 'dash')
  // 点線：直径 10 の点が 20 ごと（角から）。点の間は背景
  await expectColor(page, 370, 300, RED_RGB, 'dot')
  await expectColor(page, 380, 300, 'background', 'between dots')
  await expectColor(page, 390, 300, RED_RGB, 'dot')
})

test('changes the border from the panel, each undoable', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 180, 140)
  const stroke = page.getByTestId('design-panel').locator('[data-section="stroke"]')
  await expect(stroke.getByRole('group', { name: '位置' })).toBeVisible()
  const length = stroke.getByRole('textbox', { name: '長さ', exact: true })
  const gap = stroke.getByRole('textbox', { name: '間隔', exact: true })
  // 実線なので、破線の長さ・間隔は出さない
  await expect(length).toHaveCount(0)
  await expect(gap).toHaveCount(0)

  // 外側へ
  // 測る点（y=122）は、選択の枠のハンドル（角と辺の真ん中）から離す
  await stroke.getByRole('button', { name: '外側' }).click()
  await expect(stroke.getByRole('button', { name: '外側' })).toHaveAttribute('aria-pressed', 'true')
  await expectColor(page, 93, 122, RED_RGB, 'moved outside')
  await expectColor(page, 103, 122, BLUE_RGB, 'fill inside')
  await clickWorld(page, 180, 140)
  await page.keyboard.press('Control+z')
  await expectColor(page, 103, 122, RED_RGB, 'back to center')

  // 破線にすると長さと間隔が出る（太さ 10 に合わせた既定：40px と 20px）
  await stroke.getByRole('button', { name: '破線' }).click()
  await expect(length).toHaveValue('40')
  await expect(gap).toHaveValue('20')
  await expectColor(page, 150, 97, 'background', 'dash gap')
  // 点線は間隔だけ
  await stroke.getByRole('button', { name: '点線' }).click()
  await expect(length).toHaveCount(0)
  await expect(gap).toHaveValue('20')

  await stroke.getByRole('button', { name: '実線' }).click()

  // 線の不透明度と線なし
  await stroke.getByRole('button', { name: '線なしにする' }).click()
  await expect(stroke.getByRole('group', { name: '位置' })).toHaveCount(0)
  await expectColor(page, 97, 122, 'background', 'no border')
  await stroke.getByRole('button', { name: '線を足す' }).click()
  await expectColor(page, 97, 122, RED_RGB, 'border again')
  const opacity = stroke.getByRole('textbox', { name: '色の不透明度' })
  await opacity.fill('50')
  await opacity.press('Enter')
  const half = await pixel(page, 97, 122)
  expect(near(half, [255, 128, 128], 24), `translucent border: ${half}`).toBe(true)
})

test('keeps the common stroke color and width for shapes mixed with arrows', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 180, 140)
  await clickWorld(page, 500, 560, ['Shift'])
  const stroke = page.getByTestId('design-panel').locator('[data-section="stroke"]')
  await expect(stroke.locator('input.design-hex')).toBeVisible()
  // 図形だけの項目（位置・線なし・不透明度）は出さない
  await expect(stroke.getByRole('group', { name: '位置' })).toHaveCount(0)
  await expect(stroke.getByRole('button', { name: '線なしにする' })).toHaveCount(0)
  const width = stroke.getByRole('textbox', { name: '太さ', exact: true })
  await width.fill('6')
  await width.press('Enter')
  await expect(width).toHaveValue('6')
  const hex = stroke.locator('input.design-hex')
  await hex.fill('#2f9e44')
  await hex.press('Enter')
  await expect(hex).toHaveValue('#2f9e44')
  // 図形の線は緑（中央の線は 3px ずつ）。選択の枠が重ならないよう、選択を外して測る
  await page.keyboard.press('Escape')
  await expectColor(page, 98, 140, [0x2f, 0x9e, 0x44], 'shape border color')
})
