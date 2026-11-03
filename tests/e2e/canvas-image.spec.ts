import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

// Canvas を画像にする（MAI-89。docs/canvas-image-plan.md）：右クリックの「画像として保存 ›」「画像をコピー ›」と、
// パイメニューの 操作 › 画像 ›。範囲選択なら範囲に見えるものを全部、ノードを選んだらそれだけ、スライドを 1 枚だけならスライドの枠どおりに描く

const CANVAS_ID = 'canvas:image-test'

function rect(id: string, x: number, y: number, w: number, h: number, color: string, index: string, parentId = CANVAS_ID) {
  return {
    typeName: 'node', id, type: 'geo', parentId, x, y, rotation: 0, index, opacity: 1, locked: false, version: 3,
    props: { shape: 'rect', w, h, fill: { type: 'solid', color, opacity: 1 }, stroke: null, strokeWidth: 0, label: '' }, meta: {},
  }
}

async function openApp(page: Page) {
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: '図 / 2026', parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  const records = [
    canvas,
    // 赤い矩形の上に、子ではない青い矩形が重なっている
    rect('node:red', 0, 0, 400, 300, '#e03131', 'a1'),
    rect('node:blue', 150, 100, 100, 100, '#1971c2', 'a2'),
    // スライドと、その中の緑の矩形
    {
      typeName: 'node', id: 'node:slide', type: 'slide', parentId: CANVAS_ID, x: 0, y: 1000, rotation: 0, index: 'a3', opacity: 1, locked: false, version: 1,
      props: { ratio: '16:9', name: '', hidden: false }, meta: {},
    },
    rect('node:green', 100, 100, 600, 300, '#2f9e44', 'a1', 'node:slide'),
  ]
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [] } }))
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
  // 倍率 0.5 で、矩形を画面の左上の欄（パンくずリスト）から離して見る（スライドも画面に入る）
  await page.evaluate(() => (window as any).canvcode.editor.session.set({ camera: { x: -400, y: -300, zoom: 0.5 } }))
}

// ワールド座標の点の、画面の位置
async function screenOf(page: Page, x: number, y: number) {
  const box = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  const camera = await page.evaluate(() => (window as any).canvcode.editor.session.get().camera)
  return { x: box.x + (x - camera.x) * camera.zoom, y: box.y + (y - camera.y) * camera.zoom }
}

async function select(page: Page, ids: string[]) {
  await page.evaluate((ids) => (window as any).canvcode.editor.setSelection(ids), ids)
}

// PNG の大きさと、割合で指した位置の色（ブラウザで読む）
async function pngInfo(page: Page, png: Buffer, points: [number, number][]) {
  return page.evaluate(
    async ({ base64, points }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      const hex = (n: number) => n.toString(16).padStart(2, '0')
      const colors = points.map(([fx, fy]) => {
        const [r, g, b] = ctx.getImageData(Math.floor(bitmap.width * fx), Math.floor(bitmap.height * fy), 1, 1).data
        return `#${hex(r)}${hex(g)}${hex(b)}`
      })
      return { width: bitmap.width, height: bitmap.height, colors }
    },
    { base64: png.toString('base64'), points },
  )
}

async function rightClickMenu(page: Page, at: { x: number; y: number }, labels: string[]) {
  await page.mouse.click(at.x, at.y, { button: 'right' })
  for (const label of labels) {
    await expect(page.locator('.context-menu')).toBeVisible()
    await page.locator('.context-menu button', { hasText: label }).first().click()
  }
}

test('saves the selected nodes only, at twice the size, from the context menu', async ({ page }) => {
  await openApp(page)
  await select(page, ['node:red'])
  const download = page.waitForEvent('download')
  await rightClickMenu(page, await screenOf(page, 50, 50), ['画像として保存 ›', '2 倍（'])
  const file = await download
  expect(file.suggestedFilename()).toBe('図 - 2026.png')
  const info = await pngInfo(page, await readFile(await file.path()), [[0.5, 0.5], [0.1, 0.5]])
  // 400×300 に余白（長い辺の 2%）を足して 2 倍
  expect(info.width).toBeGreaterThanOrEqual(832)
  expect(info.width).toBeLessThanOrEqual(840)
  expect(info.height).toBeGreaterThanOrEqual(632)
  expect(info.height).toBeLessThanOrEqual(640)
  // 青い矩形は子ではないので写らない（真ん中も赤）
  expect(info.colors).toEqual(['#e03131', '#e03131'])
  await expect(page.getByText(/図 - 2026\.png を保存しました（\d+×\d+）/)).toBeVisible({ timeout: 15_000 })
})

test('saves everything in a brush, and a single slide as its frame', async ({ page }) => {
  await openApp(page)
  // 何もない所から、2 つの矩形を囲む
  const from = await screenOf(page, -50, -50)
  const to = await screenOf(page, 450, 350)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => Boolean((window as any).canvcode.editor.session.get().lastBrush))).toBe(true)
  let download = page.waitForEvent('download')
  // 範囲の中の、何もない所を右クリックする
  await rightClickMenu(page, await screenOf(page, -30, -30), ['画像として保存 ›', '等倍（'])
  let info = await pngInfo(page, await readFile(await (await download).path()), [[0.5, 0.5], [0.15, 0.5]])
  expect(info.width).toBe(500)
  expect(info.height).toBe(400)
  // 範囲なら、重なった青い矩形も写る
  expect(info.colors).toEqual(['#1971c2', '#e03131'])

  // スライドを 1 枚だけ選ぶ
  await select(page, ['node:slide'])
  download = page.waitForEvent('download')
  await rightClickMenu(page, await screenOf(page, 50, 1050), ['画像として保存 ›', '2 倍（3840×2160）'])
  const file = await download
  expect(file.suggestedFilename()).toBe('図 - 2026 - 1.png')
  info = await pngInfo(page, await readFile(await file.path()), [[0.2, 0.2], [0.02, 0.02]])
  expect(info).toMatchObject({ width: 3840, height: 2160 })
  expect(info.colors).toEqual(['#2f9e44', '#ffffff'])
})

test('saves the selection from the actions pie menu', async ({ page }) => {
  await openApp(page)
  await select(page, ['node:red'])
  const at = await screenOf(page, 600, 600)
  await page.mouse.move(at.x, at.y)
  const download = page.waitForEvent('download')
  await page.keyboard.down('o')
  await page.locator('.pie-item').filter({ hasText: /^画像›?$/ }).click({ force: true })
  await page.locator('.pie-item').filter({ hasText: /^保存（等倍）$/ }).click({ force: true })
  await page.keyboard.up('o')
  const info = await pngInfo(page, await readFile(await (await download).path()), [[0.5, 0.5]])
  expect(info.width).toBeGreaterThanOrEqual(416)
  expect(info.width).toBeLessThanOrEqual(420)
  expect(info.colors).toEqual(['#e03131'])
})

test('copies the selection as a PNG to the clipboard', async ({ page, context, browserName }) => {
  // クリップボードを読み戻すのは Chromium だけ（Firefox は読み出しの許可を与えられない）
  test.skip(browserName !== 'chromium', 'reads the clipboard back only in Chromium')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openApp(page)
  await select(page, ['node:red'])
  await rightClickMenu(page, await screenOf(page, 50, 50), ['画像をコピー ›', '等倍（'])
  // ほかのブラウザのテストと同時に走らせると、描き終えるまで 5 秒を超えることがある
  await expect(page.getByText(/画像をコピーしました（\d+×\d+）/)).toBeVisible({ timeout: 15_000 })
  const copied = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read()
    const blob = await item.getType('image/png')
    const bitmap = await createImageBitmap(blob)
    return { types: item.types, width: bitmap.width, height: bitmap.height }
  })
  expect(copied.types).toContain('image/png')
  expect(copied.width).toBeGreaterThanOrEqual(416)
  expect(copied.width).toBeLessThanOrEqual(420)
})
