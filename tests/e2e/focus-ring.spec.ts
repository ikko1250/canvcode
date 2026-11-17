import { expect, test, type Locator, type Page } from '@playwright/test'

// フォーカスの枠（MAI-109）：キーボードで移ったボタンと入力欄に、DADS の 2 重の枠（黒 4px の outline と、内側に黄 2px の box-shadow）が出ること、
// マウスで押したボタンと、キャンバスの面・キャンバスの上で文字を編集する要素には出ないことを、計算後のスタイルで確かめる。
// サーバーの応答だけを差し替える（design-panel.spec.ts と同じ）

const CANVAS_ID = 'canvas:focus-test'

function node(id: string, type: string, x: number, y: number, index: string, props: object) {
  return { typeName: 'node', id, type, parentId: CANVAS_ID, x, y, rotation: 0, index, opacity: 1, locked: false, props, meta: {} }
}

async function openApp(page: Page) {
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: 'Focus', parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  const records = [
    canvas,
    node('node:geo', 'geo', 100, 120, 'a0', { shape: 'rect', w: 120, h: 120, fill: '#e8eefc', stroke: '#3b5bdb', strokeWidth: 2, label: '' }),
    node('node:text', 'text', 500, 320, 'a1', { text: 'hello', fontSize: 16, color: '#1f2328', align: 'left', w: 200, autoWidth: true }),
  ]
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [] } }))
  await page.goto('/')
  const root = page.locator('.canvas-container > div[tabindex]')
  await expect(root).toBeVisible()
  return root
}

// 選ぶ（ノードの真ん中をクリック）。カメラは最初 (0, 0)・倍率 1
async function clickWorld(page: Page, x: number, y: number) {
  const rect = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  await page.mouse.click(rect.x + x, rect.y + y)
}

// 枠の見た目（計算後のスタイル）と、:focus-visible か
function ringOf(locator: Locator) {
  return locator.evaluate((el) => {
    const style = getComputedStyle(el)
    return {
      outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
      offset: style.outlineOffset,
      shadow: style.boxShadow,
    }
  })
}

const YELLOW = 'rgb(255, 212, 61)'

async function expectRing(locator: Locator) {
  const ring = await ringOf(locator)
  expect(ring.outline).toBe('solid 4px rgb(0, 0, 0)')
  expect(ring.offset).toBe('2px')
  expect(ring.shadow).toContain(`${YELLOW} 0px 0px 0px 2px`)
}

async function expectNoRing(locator: Locator) {
  const ring = await ringOf(locator)
  expect(ring.outline).toMatch(/^none /)
  expect(ring.shadow).not.toContain(YELLOW)
}

// 目当ての要素にフォーカスが来るまで Tab を押す
async function tabTo(page: Page, target: Locator, max = 60) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab')
    if (await target.evaluate((el) => el === document.activeElement)) return
  }
  throw new Error('Tab で目当ての要素に移れませんでした')
}

test('Tab shows the DADS focus ring on buttons and text fields', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 160, 180)
  const panel = page.getByTestId('design-panel')
  await expect(panel).toBeVisible()

  // ボタン
  const textTab = panel.getByRole('tab', { name: '文字' })
  await tabTo(page, textTab)
  await expect(textTab).toBeFocused()
  expect(await textTab.evaluate((el) => el.matches(':focus-visible'))).toBe(true)
  await expectRing(textTab)

  // 一覧から選ぶ欄（もとは枠の色を変えるだけで、outline を消していた）
  const shape = panel.locator('select.design-select').first()
  await tabTo(page, shape)
  await expectRing(shape)

  // 色のコードの入力欄
  const hex = panel.locator('[data-section="fill"] input.design-hex')
  await tabTo(page, hex)
  await expectRing(hex)

  // 数字の欄は、欄の形をした外側に枠を出し、中の入力には出さない
  const opacity = panel.locator('[data-section="fill"] .design-number').first()
  await tabTo(page, opacity.locator('input'))
  await expectRing(opacity)
  await expectNoRing(opacity.locator('input'))

  // 前に戻っても出る
  await page.keyboard.press('Shift+Tab')
  await expect(hex).toBeFocused()
  await expectRing(hex)
})

test('a button pressed with the mouse shows no focus ring', async ({ page }) => {
  await openApp(page)
  // サイドバーの今の Canvas の名前は、押してもフォーカスがボタンに残る（デザインパネルのボタンは、押すとキャンバスに戻す）
  await page.locator('.sidebar-open').click()
  const title = page.locator('.sidebar-title.current')
  await title.click()
  await expect(title).toBeFocused()
  expect(await title.evaluate((el) => el.matches(':focus-visible'))).toBe(false)
  await expectNoRing(title)

  // 同じボタンでも、キーボードで移ってきたら出る
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await expect(title).toBeFocused()
  await expectRing(title)
})

test('the canvas surface and the text being edited on the canvas show no focus ring', async ({ page }) => {
  const root = await openApp(page)
  // 開いた直後（プログラムからのフォーカス）
  await expect(root).toBeFocused()
  await expectNoRing(root)

  // キーボードで移ってきたとき（:focus-visible になる）も出さない
  await page.keyboard.press('Tab')
  await root.evaluate((el) => (el as HTMLElement).focus())
  await expect(root).toBeFocused()
  expect(await root.evaluate((el) => el.matches(':focus-visible'))).toBe(true)
  await expectNoRing(root)

  // テキストを選んで Enter で編集する。編集用の要素（contenteditable）にも出さない
  await clickWorld(page, 510, 328)
  await page.keyboard.press('Enter')
  const editor = page.locator('.canvcode-text-editor')
  await expect(editor).toBeFocused()
  await expectNoRing(editor)
  await page.keyboard.press('Escape')
  await expect(root).toBeFocused()
  await expectNoRing(root)
})
