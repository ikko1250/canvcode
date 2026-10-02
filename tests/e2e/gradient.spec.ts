import { expect, test, type Page } from '@playwright/test'

// 図形の塗りのグラデーション（MAI-82）：パネルの種類の切り替え・止め色の帯・角度・中心と、図形の上のハンドルで変えられること。
// 回転・大きさの変更に付いてくること。描いた色は、スクリーンショットの画素で確かめる（fill.spec.ts と同じ）

const CANVAS_ID = 'canvas:gradient-test'

const RED_TO_BLUE = {
  type: 'linear',
  start: { x: 0, y: 0.5 },
  end: { x: 1, y: 0.5 },
  stops: [
    { position: 0, color: '#ff0000', opacity: 1 },
    { position: 1, color: '#0000ff', opacity: 1 },
  ],
  opacity: 1,
}

function node(id: string, x: number, y: number, index: string, props: object, rotation = 0) {
  return {
    typeName: 'node', id, type: 'geo', parentId: CANVAS_ID, x, y, rotation, index, opacity: 1, locked: false, version: 2,
    props: { shape: 'rect', w: 200, h: 100, stroke: '#3b5bdb', strokeWidth: 0, label: '', ...props }, meta: {},
  }
}

async function openApp(page: Page) {
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: 'Gradient', parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  const records = [
    canvas,
    // 左から右へ、赤から青
    node('node:linear', 100, 120, 'a1', { fill: RED_TO_BLUE }),
    // 同じ塗りで、90° 回した図形（ローカルの左→右が、画面の上→下になる。画面では x 400〜500、y 150〜350）
    node('node:rotated', 500, 150, 'a2', { fill: RED_TO_BLUE }, Math.PI / 2),
    // 単色（パネルでグラデーションに切り替える）
    node('node:solid', 100, 400, 'a3', { fill: { type: 'solid', color: '#1971c2', opacity: 1 } }),
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

// 画面の 1 画素の色（[r, g, b]）。ハンドル・選択枠に重ならないよう、選びを外してから測るときは unselect
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

// 赤っぽい・青っぽい・その間（紫）
async function expectRed(page: Page, x: number, y: number) {
  const [r, , b] = await pixel(page, x, y)
  expect(r, `red at ${x},${y}: ${r},${b}`).toBeGreaterThan(200)
  expect(b, `red at ${x},${y}: ${r},${b}`).toBeLessThan(60)
}

async function expectBlue(page: Page, x: number, y: number) {
  const [r, , b] = await pixel(page, x, y)
  expect(b, `blue at ${x},${y}: ${r},${b}`).toBeGreaterThan(200)
  expect(r, `blue at ${x},${y}: ${r},${b}`).toBeLessThan(60)
}

async function expectPurple(page: Page, x: number, y: number) {
  const [r, , b] = await pixel(page, x, y)
  expect(Math.abs(r - b), `purple at ${x},${y}: ${r},${b}`).toBeLessThan(50)
  expect(r, `purple at ${x},${y}: ${r},${b}`).toBeGreaterThan(90)
}

const panelFill = (page: Page) => page.getByTestId('design-panel').locator('[data-section="fill"]')

test('draws linear gradients in the direction of the paint, and follows rotation and resizing', async ({ page }) => {
  await openApp(page)
  // 左から右へ
  await expectRed(page, 105, 170)
  await expectPurple(page, 200, 170)
  await expectBlue(page, 295, 170)
  // 90° 回した図形では、上から下へ
  await expectRed(page, 450, 155)
  await expectPurple(page, 450, 250)
  await expectBlue(page, 450, 345)

  // 大きさを変える：回した図形の、ローカルの右の辺（画面では下の辺）のハンドルを下へ
  await clickWorld(page, 450, 250)
  await dragWorld(page, { x: 450, y: 350 }, { x: 450, y: 450 })
  await clickWorld(page, 900, 700)
  // 伸びた箱の全体に付いてくる（y 150〜450）
  await expectRed(page, 450, 155)
  await expectPurple(page, 450, 300)
  await expectBlue(page, 450, 445)
})

test('moves the gradient with the handles on the shape, each drag one undo step', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 200, 170)
  const fill = panelFill(page)
  await expect(fill.locator('.design-paint-kind')).toHaveText('線形')
  await fill.getByRole('button', { name: '色を選ぶ' }).click()
  const picker = fill.getByRole('dialog')
  await expect(picker).toBeVisible()
  await expect(fill.getByRole('textbox', { name: '角度' })).toHaveValue('0')

  // 始点を下の辺の中点へ、終点を上の辺の中点へ：下から上へ、赤から青（ピッカーは開いたまま）
  await dragWorld(page, { x: 100, y: 170 }, { x: 200, y: 220 })
  await dragWorld(page, { x: 300, y: 170 }, { x: 200, y: 120 })
  await expect(picker).toBeVisible()
  await expect(fill.getByRole('textbox', { name: '角度' })).toHaveValue('270')
  // 図形は動いていない（リサイズのハンドルも出ていない）
  await expectBlue(page, 150, 125)
  await expectRed(page, 150, 215)

  // Undo 1 回で、終点だけが戻る
  await page.keyboard.press('Control+z')
  await expect(fill.getByRole('textbox', { name: '角度' })).not.toHaveValue('270')
  await page.keyboard.press('Control+z')
  await expect(fill.getByRole('textbox', { name: '角度' })).toHaveValue('0')
  // ハンドル（始点→終点の線）に重ならない所で測る
  await expectRed(page, 110, 140)

  // 回した図形でも、ハンドルは図形に付いている：終点（画面の下の辺の中点）を真ん中へ
  await clickWorld(page, 900, 700)
  await clickWorld(page, 450, 250)
  await fill.getByRole('button', { name: '色を選ぶ' }).click()
  await dragWorld(page, { x: 450, y: 350 }, { x: 450, y: 250 })
  // Esc でハンドルを消すと、ピッカーも閉じる（選んだまま）
  await page.keyboard.press('Escape')
  await expect(fill.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId('design-panel')).toBeVisible()
  await clickWorld(page, 900, 700)
  await expectRed(page, 450, 155)
  await expectBlue(page, 450, 300)
  await expectBlue(page, 450, 345)
})

test('switches a solid fill to gradients and edits stops, angle and center in the panel', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 200, 450)
  const fill = panelFill(page)
  await expect(fill.locator('input.design-hex')).toHaveValue('#1971c2')
  await fill.getByRole('button', { name: '色を選ぶ' }).click()
  await fill.getByRole('group', { name: '種類' }).getByRole('button', { name: '線形' }).click()
  await expect(fill.locator('.design-paint-kind')).toHaveText('線形')

  // 今の色から、同じ色の透明へ（上から下）
  const stops = fill.locator('.design-gradient-stop')
  await expect(stops).toHaveCount(2)
  await clickWorld(page, 900, 700)
  const top = await pixel(page, 200, 403)
  expect(Math.abs(top[0] - 0x19) + Math.abs(top[1] - 0x71) + Math.abs(top[2] - 0xc2)).toBeLessThan(30)
  expect(Math.min(...(await pixel(page, 200, 497)))).toBeGreaterThan(220)

  // 帯を押すと止め色を足し、選んだ止め色を Delete で消す
  await clickWorld(page, 200, 450)
  await fill.getByRole('button', { name: '色を選ぶ' }).click()
  const bar = fill.getByTestId('gradient-bar')
  const box = (await bar.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(stops).toHaveCount(3)
  await expect(stops.nth(1)).toHaveAttribute('aria-pressed', 'true')
  await expect(fill.getByRole('textbox', { name: '位置' })).toHaveValue('50')
  // 足した止め色は、その位置の色（不透明度も半分）。選んでいる止め色の色を変える（赤）
  await fill.getByRole('group', { name: 'テンプレート：キャンバス' }).locator('[data-color="#e03131"]').click()
  await expect(stops.nth(1).locator('span')).toHaveCSS('background-color', 'rgba(224, 49, 49, 0.5)')
  // 印をドラッグで動かす（パネルが画面より長いとき、印がパネルの中でスクロールして隠れていることがある）
  await stops.nth(1).scrollIntoViewIfNeeded()
  const barBox = (await bar.boundingBox())!
  const mark = (await stops.nth(1).boundingBox())!
  await page.mouse.move(mark.x + mark.width / 2, mark.y + mark.height / 2)
  await page.mouse.down()
  await page.mouse.move(barBox.x + barBox.width * 0.25, mark.y + mark.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect(fill.getByRole('textbox', { name: '位置' })).toHaveValue(/^2[4-6]$/)
  await stops.nth(1).press('Delete')
  await expect(stops).toHaveCount(2)

  // 角度 0°：左から右
  const angle = fill.getByRole('textbox', { name: '角度' })
  await angle.fill('0')
  await angle.press('Enter')
  await clickWorld(page, 900, 700)
  const left = await pixel(page, 103, 450)
  const right = await pixel(page, 297, 450)
  expect(left[2]).toBeGreaterThan(150)
  expect(Math.min(...right)).toBeGreaterThan(220)

  // 円形：中心が今の色、隅は透明に近い。中心を動かせる
  await clickWorld(page, 200, 450)
  await fill.getByRole('button', { name: '色を選ぶ' }).click()
  await fill.getByRole('group', { name: '種類' }).getByRole('button', { name: '円形' }).click()
  await expect(fill.locator('.design-paint-kind')).toHaveText('円形')
  const centerX = fill.getByRole('textbox', { name: '中心 X' })
  await expect(centerX).toHaveValue('50')
  await clickWorld(page, 900, 700)
  expect((await pixel(page, 200, 450))[2]).toBeGreaterThan(150)
  expect(Math.min(...(await pixel(page, 103, 403)))).toBeGreaterThan(220)
  await clickWorld(page, 200, 450)
  await fill.getByRole('button', { name: '色を選ぶ' }).click()
  await centerX.fill('0')
  await centerX.press('Enter')
  await clickWorld(page, 900, 700)
  expect((await pixel(page, 103, 450))[2]).toBeGreaterThan(150)
  expect(Math.min(...(await pixel(page, 250, 450)))).toBeGreaterThan(220)

  // 単色に戻すと、最初の止め色
  await clickWorld(page, 200, 450)
  await fill.getByRole('button', { name: '色を選ぶ' }).click()
  await fill.getByRole('group', { name: '種類' }).getByRole('button', { name: '単色' }).click()
  await expect(fill.locator('input.design-hex')).toHaveValue('#1971c2')
})
