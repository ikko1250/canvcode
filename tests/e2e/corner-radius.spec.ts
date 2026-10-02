import { expect, test, type Page } from '@playwright/test'

// 長方形の角丸（MAI-84）：角が丸く描かれ（角の画素が背景の色）、切り落とした角には当たらないこと。
// パネルの数値（一括・角ごと）と、図形の角の内側のハンドルのドラッグで変えられ、Undo 1 回で戻ること

const CANVAS_ID = 'canvas:corner-test'
const BLUE = { type: 'solid', color: '#1971c2', opacity: 1 }

function node(id: string, x: number, y: number, index: string, props: object) {
  return {
    typeName: 'node', id, type: 'geo', parentId: CANVAS_ID, x, y, rotation: 0, index, opacity: 1, locked: false, version: 2,
    props: { shape: 'rect', w: 200, h: 100, fill: BLUE, stroke: '#3b5bdb', strokeWidth: 0, label: '', ...props }, meta: {},
  }
}

async function openApp(page: Page) {
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: 'Corner', parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  const records = [
    canvas,
    // 4 つの角が半径 40
    node('node:rounded', 100, 120, 'a1', { cornerRadius: 40 }),
    // 右上だけ半径 40
    node('node:one', 450, 120, 'a2', { cornerRadius: [0, 40, 0, 0] }),
    // 角丸なし（古いデータ：cornerRadius を持たない）
    node('node:square', 100, 400, 'a3', {}),
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

async function dragWorld(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, modifiers: ('Alt')[] = []) {
  const a = await screen(page, from.x, from.y)
  const b = await screen(page, to.x, to.y)
  await page.mouse.move(a.x, a.y)
  for (const key of modifiers) await page.keyboard.down(key)
  await page.mouse.down()
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 })
  await page.mouse.move(b.x, b.y, { steps: 4 })
  await page.mouse.up()
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

const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 12)

// 背景の色（図形のない所）と同じか、塗りの青か
async function expectBackground(page: Page, x: number, y: number) {
  const background = await pixel(page, 60, 60)
  const actual = await pixel(page, x, y)
  expect(near(actual, background), `background at ${x},${y}: ${actual} vs ${background}`).toBe(true)
}

async function expectBlue(page: Page, x: number, y: number) {
  const actual = await pixel(page, x, y)
  expect(near(actual, [0x19, 0x71, 0xc2]), `blue at ${x},${y}: ${actual}`).toBe(true)
}

const panel = (page: Page) => page.getByTestId('design-panel')
const cornerSection = (page: Page) => panel(page).locator('[data-section="corner"]')

test('draws rounded corners, and does not hit the cut-off corners', async ({ page }) => {
  await openApp(page)
  // 4 つの角の画素は背景、中と辺の真ん中は青
  await expectBackground(page, 102, 122)
  await expectBackground(page, 298, 122)
  await expectBackground(page, 298, 218)
  await expectBackground(page, 102, 218)
  await expectBlue(page, 200, 170)
  await expectBlue(page, 200, 122)
  await expectBlue(page, 102, 170)
  // 右上だけの角丸
  await expectBlue(page, 452, 122)
  await expectBackground(page, 648, 122)
  await expectBlue(page, 648, 218)
  // 角丸のない図形は、角まで青
  await expectBlue(page, 102, 402)

  // 切り落とした角を押しても選ばれない。中を押せば選ばれ、パネルに半径が出る
  await clickWorld(page, 103, 123)
  await expect(panel(page)).toHaveCount(0)
  await clickWorld(page, 200, 170)
  await expect(cornerSection(page).getByRole('textbox', { name: '半径' })).toHaveValue('40')
  // 角のない図形は 0（古いデータ）
  await clickWorld(page, 200, 450)
  await expect(cornerSection(page).getByRole('textbox', { name: '半径' })).toHaveValue('0')
})

test('changes the radius with the panel, all corners or each corner', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 200, 450)
  const radius = cornerSection(page).getByRole('textbox', { name: '半径' })
  await radius.fill('30')
  await radius.press('Enter')
  // 選びを外して（選択枠のハンドルを消して）から測る
  await clickWorld(page, 900, 700)
  await expectBackground(page, 102, 402)
  await expectBlue(page, 200, 450)

  // 角ごとに切り替えて、左上だけ 0 に
  await clickWorld(page, 200, 450)
  await cornerSection(page).getByRole('button', { name: '角ごとに変える' }).click()
  const topLeft = cornerSection(page).getByRole('textbox', { name: '左上' })
  await expect(topLeft).toHaveValue('30')
  await topLeft.fill('0')
  await topLeft.press('Enter')
  await expect(radius).toHaveValue('')
  await expect(radius).toHaveAttribute('placeholder', '混在')
  await clickWorld(page, 900, 700)
  await expectBlue(page, 102, 402)
  await expectBackground(page, 298, 402)

  // Undo 1 回で、左上が戻る
  await page.keyboard.press('Control+z')
  await clickWorld(page, 200, 450)
  await expect(radius).toHaveValue('30')

  // 角ごとの値が違う図形を選ぶと、はじめから角ごとに出す
  await clickWorld(page, 550, 170)
  await expect(cornerSection(page).getByRole('textbox', { name: '右上' })).toHaveValue('40')
  await expect(cornerSection(page).getByRole('textbox', { name: '左上' })).toHaveValue('0')
})

test('drags the corner handles to change the radius, one corner with Alt, each drag one undo step', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 200, 450)
  const radius = cornerSection(page).getByRole('textbox', { name: '半径' })
  await expect(radius).toHaveValue('0')
  // 半径 0 のハンドルは、角から 12px 内側。対角線に沿って 25px 内へ
  await dragWorld(page, { x: 112, y: 412 }, { x: 137, y: 437 })
  await expect(radius).toHaveValue('25')
  // 図形は動いていない（角が丸い）
  await clickWorld(page, 900, 700)
  await expectBackground(page, 101, 401)
  await expectBlue(page, 200, 402)

  // Alt を押して右下だけを（ハンドルは半径の位置：角から 25px 内側）
  await clickWorld(page, 200, 450)
  await dragWorld(page, { x: 275, y: 475 }, { x: 290, y: 490 }, ['Alt'])
  await expect(radius).toHaveAttribute('placeholder', '混在')
  await cornerSection(page).getByRole('button', { name: '角ごとに変える' }).click()
  await expect(cornerSection(page).getByRole('textbox', { name: '右下' })).toHaveValue('10')
  await expect(cornerSection(page).getByRole('textbox', { name: '左上' })).toHaveValue('25')

  // Undo 1 回ずつ戻る
  await page.keyboard.press('Control+z')
  await expect(radius).toHaveValue('25')
  await page.keyboard.press('Control+z')
  await expect(radius).toHaveValue('0')
})
