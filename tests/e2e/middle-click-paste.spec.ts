import { expect, test, type Page } from '@playwright/test'

// Linux のブラウザは、中ボタンを離すと、最後に選んだ文字（PRIMARY の選択）を貼り付ける。
// キャンバスでは中ボタンはパン（とポータルを新しいタブで開く）なので、貼り付けさせない。編集中の文字の中では、ふつうに貼る。
// ヘッドレスの Chromium・Firefox でも、マウスで文字を選ぶと PRIMARY に入り、中ボタンで paste イベントが届く。
// Chromium と Firefox で止め方が違う（pointerup・auxclick）ので、Firefox でも回す（playwright.config.ts）

const CANVAS_ID = 'canvas:middle-paste'

const canvas = {
  typeName: 'canvas', id: CANVAS_ID, title: 'Middle', parentCanvasId: null, ownerNodeId: null,
  createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
}

const text = {
  typeName: 'node', id: 'node:text', type: 'text', parentId: CANVAS_ID, x: 100, y: 100, rotation: 0, index: 'a0', opacity: 1, locked: false,
  props: { text: 'hello world', fontSize: 16, color: '#1f2328', align: 'left', w: 200, autoWidth: true }, meta: {},
}

async function openApp(page: Page, records: object[]) {
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [] } }))
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
  await page.waitForFunction(() => Boolean((window as any).canvcode))
  // キャンバスの外に文字を置いて、マウスで選ぶ（PRIMARY の選択に入る）。届いた paste イベントを覚える
  await page.evaluate(() => {
    const source = document.createElement('div')
    source.id = 'primary-source'
    source.textContent = 'PRIMARY_TEXT'
    source.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:99999;background:#fff;padding:4px;user-select:text'
    document.body.appendChild(source)
    const w = window as any
    w.__pastes = []
    window.addEventListener('paste', (e) => w.__pastes.push(e.clipboardData?.getData('text/plain') ?? ''), true)
  })
  await page.locator('#primary-source').click({ clickCount: 3 })
}

const pastes = (page: Page) => page.evaluate(() => (window as any).__pastes as string[])
const camera = (page: Page) => page.evaluate(() => (window as any).canvcode.editor.session.get().camera as { x: number; y: number })
const nodeCount = (page: Page) =>
  page.evaluate(() => {
    const editor = (window as any).canvcode.editor
    return [...editor.workspace.store.values()].filter((r: any) => r.typeName === 'node' && r.parentId === editor.canvasId).length
  })

async function canvasPoint(page: Page, x: number, y: number) {
  const rect = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  return { x: rect.x + x, y: rect.y + y }
}

// 確かめる側：キャンバスの外で中ボタンを押すと paste が届く（PRIMARY を選ぶやり方が効いていて、paste を数えられている）。
// キャンバスの外（上のバー・AI 付箋の札など）で離したものも、キャンバスには貼らない
test('a middle click outside the canvas sends a paste, which the canvas does not take', async ({ page }) => {
  await openApp(page, [canvas])
  const at = (await page.locator('#primary-source').boundingBox())!
  await page.mouse.click(at.x + 5, at.y + 5, { button: 'middle' })
  await expect.poll(() => pastes(page)).toEqual(['PRIMARY_TEXT'])
  await page.waitForTimeout(200)
  expect(await nodeCount(page)).toBe(0)
})

test('middle drag pans without pasting the primary selection', async ({ page }) => {
  await openApp(page, [canvas, text])
  const before = await camera(page)
  const at = await canvasPoint(page, 500, 400)
  await page.mouse.move(at.x, at.y)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(at.x + 60, at.y + 40, { steps: 4 })
  await page.mouse.up({ button: 'middle' })
  const after = await camera(page)
  expect(after.x).not.toBe(before.x)
  expect(after.y).not.toBe(before.y)
  await page.waitForTimeout(200)
  expect(await pastes(page)).toEqual([])
  expect(await nodeCount(page)).toBe(1)
})

test('a middle click on the canvas does not paste the primary selection', async ({ page }) => {
  await openApp(page, [canvas, text])
  const at = await canvasPoint(page, 500, 400)
  await page.mouse.click(at.x, at.y, { button: 'middle' })
  await page.waitForTimeout(200)
  expect(await pastes(page)).toEqual([])
  expect(await nodeCount(page)).toBe(1)
})

// パン中は編集を続ける。編集中の文字にも、PRIMARY の文字を入れない
test('middle drag while editing a text does not paste into it', async ({ page }) => {
  await openApp(page, [canvas, text])
  const card = await canvasPoint(page, 120, 110)
  await page.mouse.dblclick(card.x, card.y)
  const editor = page.locator('.canvcode-text-editor')
  await expect(editor).toBeFocused()
  await page.keyboard.press('End')
  const at = await canvasPoint(page, 500, 400)
  await page.mouse.move(at.x, at.y)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(at.x + 60, at.y + 40, { steps: 4 })
  await page.mouse.up({ button: 'middle' })
  await page.waitForTimeout(200)
  await expect(editor).toBeFocused()
  await expect(editor).toHaveText('hello world')
  expect(await pastes(page)).toEqual([])
})

// 中ボタンでパンしながら左ボタンを押し、中ボタンを先に離す（Chromium では pointerup ではなく pointermove になる）
test('releasing the middle button first while both are held does not paste', async ({ page }) => {
  await openApp(page, [canvas, text])
  const at = await canvasPoint(page, 500, 400)
  await page.mouse.move(at.x, at.y)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(at.x + 30, at.y + 20, { steps: 2 })
  await page.mouse.down({ button: 'left' })
  await page.mouse.up({ button: 'middle' })
  await page.mouse.up({ button: 'left' })
  await page.waitForTimeout(200)
  expect(await nodeCount(page)).toBe(1)
})

// 編集中の文字の中で中ボタンを押すのは、パンにならない（文字の要素が止める）。そこでは Linux のふつうの貼り付けをする
test('a middle click inside the text being edited still pastes into it', async ({ page }) => {
  await openApp(page, [canvas, text])
  const card = await canvasPoint(page, 120, 110)
  await page.mouse.dblclick(card.x, card.y)
  const editor = page.locator('.canvcode-text-editor')
  await expect(editor).toBeFocused()
  await page.keyboard.press('End')
  const before = await camera(page)
  await page.mouse.click(card.x, card.y, { button: 'middle' })
  await expect.poll(() => pastes(page)).toHaveLength(1)
  // 貼る位置は、Chromium はカーソルの所、Firefox は押した所。中身は PRIMARY に入っているもの
  await expect.poll(async () => (await editor.textContent())!.length).toBeGreaterThan('hello world'.length)
  expect(await camera(page)).toEqual(before)
  expect(await nodeCount(page)).toBe(1)
})
