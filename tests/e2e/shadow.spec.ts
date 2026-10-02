import { expect, test, type Page } from '@playwright/test'

// 図形のシャドウ（MAI-86）：ドロップシャドウのずらし・ぼかし・広がり、塗りなしでも形の中に影が透けないこと、内側の影が、
// 画素のとおりに描かれること（dpr 2 でも同じ位置）。デザインパネルの「効果」で影を足し・変え・隠し・消せ、Undo で戻ること

const CANVAS_ID = 'canvas:shadow-test'
const BLUE = { type: 'solid', color: '#1971c2', opacity: 1 }
const RED_RGB = [255, 0, 0]
const BLUE_RGB = [0x19, 0x71, 0xc2]

const red = (patch: object) => ({ type: 'drop', x: 0, y: 0, blur: 0, spread: 0, color: '#ff0000', opacity: 1, ...patch })

function geo(id: string, x: number, y: number, index: string, props: object) {
  return {
    typeName: 'node', id, type: 'geo', parentId: CANVAS_ID, x, y, rotation: 0, index, opacity: 1, locked: false, version: 3,
    props: { shape: 'rect', w: 160, h: 80, fill: BLUE, stroke: null, strokeWidth: 0, label: '', ...props }, meta: {},
  }
}

async function openApp(page: Page) {
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: 'Shadow', parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  const records = [
    canvas,
    // 右下へ 20px ずらした、ぼかしのない赤い影
    geo('node:drop', 100, 100, 'a1', { shadows: [red({ x: 20, y: 20 })] }),
    // ずらしのない、ぼかし 20 の影
    geo('node:blur', 350, 100, 'a2', { shadows: [red({ blur: 20 })] }),
    // 塗りなし（線もなし）の図形の影は、形の中に透けない
    geo('node:hollow', 600, 100, 'a3', { fill: null, shadows: [red({ x: 10, y: 10 })] }),
    // 内側の影（広がり 10 の縁取り）
    geo('node:inner', 100, 300, 'a4', { shadows: [red({ type: 'inner', spread: 10 })] }),
    // 広がり 10 のドロップシャドウ
    geo('node:spread', 350, 300, 'a5', { shadows: [red({ spread: 10 })] }),
    // 影のない図形（パネルで足す）
    geo('node:plain', 600, 300, 'a6', {}),
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

async function expectDropShadows(page: Page) {
  // ずらし：形（x 100〜260、y 100〜180）の右下に、20px ずらした影
  await expectColor(page, 270, 150, RED_RGB, 'shadow right of the shape')
  await expectColor(page, 150, 190, RED_RGB, 'shadow below the shape')
  await expectColor(page, 110, 190, 'background', 'left of the shadow')
  await expectColor(page, 285, 150, 'background', 'beyond the shadow')
  await expectColor(page, 150, 150, BLUE_RGB, 'fill above the shadow')
  // 広がり：縁の外 0〜10px が影
  await expectColor(page, 345, 340, RED_RGB, 'spread')
  await expectColor(page, 337, 340, 'background', 'beyond the spread')
}

test('draws drop shadows with offset, blur and spread, not behind transparent fills', async ({ page }) => {
  await openApp(page)
  await expectDropShadows(page)
  // ぼかし：縁から離れるほど薄い（G が大きくなる）。標準偏差 10 なので、19px 先はほぼ背景（グリッドの線を避けて測る）
  const g = async (x: number) => (await pixel(page, x, 140))[1]
  const [g2, g10, g19] = [await g(348), await g(340), await g(331)]
  expect(g2, `blur near the edge: ${g2}`).toBeLessThan(200)
  expect(g10, `blur 10px away: ${g10}`).toBeGreaterThan(g2)
  expect(g19, `blur 19px away: ${g19}`).toBeGreaterThan(g10)
  expect(g19).toBeGreaterThan(238)
  // 塗りなしの図形：影は形の外だけ（中は背景のまま）
  await expectColor(page, 765, 150, RED_RGB, 'hollow shadow outside')
  await expectColor(page, 680, 175, 'background', 'no shadow inside a hollow shape')
  // 内側の影：縁の内 0〜10px が影、その内は塗り、外は背景
  await expectColor(page, 105, 340, RED_RGB, 'inner shadow')
  await expectColor(page, 180, 305, RED_RGB, 'inner shadow top')
  await expectColor(page, 125, 340, BLUE_RGB, 'fill inside the inner shadow')
  await expectColor(page, 95, 340, 'background', 'no inner shadow outside')
})

test.describe('on a high density display', () => {
  test.use({ deviceScaleFactor: 2 })
  test('draws shadows at the same place', async ({ page }) => {
    await openApp(page)
    await expectDropShadows(page)
  })
})

test('adds, changes, hides and removes shadows from the panel, each undoable', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 680, 340)
  const effects = page.getByTestId('design-panel').locator('[data-section="effects"]')
  await expect(effects).toBeVisible()
  await expect(effects.locator('.design-shadow')).toHaveCount(0)
  await effects.getByRole('button', { name: '影を足す' }).click()
  const row = effects.locator('[data-shadow-index="0"]')
  // 既定：下へ 4px、ぼかし 4px、黒 25 %
  await expect(row.getByRole('textbox', { name: 'Y', exact: true })).toHaveValue('4')
  await expect(row.getByRole('textbox', { name: 'ぼかし', exact: true })).toHaveValue('4')
  await expect(row.locator('input.design-hex')).toHaveValue('#000000')
  await expect(row.getByRole('textbox', { name: '色の不透明度' })).toHaveValue('25')

  const set = async (name: string, value: string) => {
    const input = row.getByRole('textbox', { name, exact: true })
    await input.fill(value)
    await input.press('Enter')
    await expect(input).toHaveValue(value)
  }
  await set('X', '20')
  await set('Y', '20')
  await set('ぼかし', '0')
  const hex = row.locator('input.design-hex')
  await hex.fill('#ff0000')
  await hex.press('Enter')
  const opacity = row.getByRole('textbox', { name: '色の不透明度' })
  await opacity.fill('100')
  await opacity.press('Enter')
  // 選択の枠が重ならないよう、選択を外して測る（形は x 600〜760、y 300〜380）
  await page.keyboard.press('Escape')
  await expectColor(page, 770, 340, RED_RGB, 'shadow added from the panel')
  await clickWorld(page, 680, 340)

  // 内側の影にする：外は背景、内の左上の縁は影にならず（右下へずらしたので）、右下の縁の内側が影
  await row.getByRole('combobox', { name: '影 1の種類' }).selectOption('inner')
  await page.keyboard.press('Escape')
  await expectColor(page, 770, 340, 'background', 'inner shadow is not outside')
  await expectColor(page, 610, 340, RED_RGB, 'inner shadow along the left edge')
  await expectColor(page, 750, 340, BLUE_RGB, 'no inner shadow along the right edge')
  await clickWorld(page, 680, 340)
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Escape')
  await expectColor(page, 770, 340, RED_RGB, 'back to a drop shadow')
  await clickWorld(page, 680, 340)

  // 隠す・表示する
  await row.getByRole('button', { name: '影を隠す' }).click()
  await expect(row.getByRole('button', { name: '影を表示する' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expectColor(page, 770, 340, 'background', 'hidden shadow')
  await clickWorld(page, 680, 340)
  await row.getByRole('button', { name: '影を表示する' }).click()

  // 2 つ目を足して、1 つ目を消す
  await effects.getByRole('button', { name: '影を足す' }).click()
  await expect(effects.locator('.design-shadow')).toHaveCount(2)
  await row.getByRole('button', { name: '影を消す' }).click()
  await expect(effects.locator('.design-shadow')).toHaveCount(1)
  await expect(row.getByRole('textbox', { name: 'X', exact: true })).toHaveValue('0')
  await row.getByRole('button', { name: '影を消す' }).click()
  await expect(effects.locator('.design-shadow')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expectColor(page, 770, 340, 'background', 'no shadows')
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+z')
  await expectColor(page, 770, 340, RED_RGB, 'shadow back by undo')
})

test('shows mixed when the selected shapes have different shadows', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 180, 140)
  await clickWorld(page, 680, 340, ['Shift'])
  const effects = page.getByTestId('design-panel').locator('[data-section="effects"]')
  await expect(effects.getByText('混在')).toBeVisible()
  await expect(effects.locator('.design-shadow')).toHaveCount(0)
  // ＋で既定の影 1 つにそろえる
  await effects.getByRole('button', { name: '影を足す' }).click()
  await expect(effects.locator('.design-shadow')).toHaveCount(1)
  await expect(effects.locator('[data-shadow-index="0"]').getByRole('textbox', { name: 'Y', exact: true })).toHaveValue('4')
})
