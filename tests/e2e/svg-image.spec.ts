import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

// SVG の画像（MAI-116）：ドロップ・貼り付けで置け、中のスクリプトや外への参照は消毒してからサーバーへ送る。
// 拡大したら、その倍率で描き直してぼやけない。画像として保存するときも、要る大きさで描いてから PNG にする。
// サーバーの応答は page.route で差し替え、描けたかは画面・PNG の画素で確かめる（image-crop.spec.ts と同じ）

const CANVAS_ID = 'canvas:svg-image-test'
// 20×20 の SVG：左半分が赤、右半分が青（消毒しても変わらない形）。境目がくっきりしているかで、描き直したかを確かめる
const HALF =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><rect width="10" height="20" fill="#ff0000"/><rect x="10" width="10" height="20" fill="#0000ff"/></svg>'
const HALF_HASH = sha256(HALF)

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function imageNode(id: string, x: number, y: number, hash: string, w: number, h: number) {
  return {
    typeName: 'node', id, type: 'image', parentId: CANVAS_ID, x, y, rotation: 0, index: 'a1', opacity: 1, locked: false,
    props: { assetId: `asset:${hash}`, w, h, crop: null }, meta: {},
  }
}

// サーバーの代わり。受け取った SVG を覚えておき、同じハッシュで返す
async function openApp(page: Page) {
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: 'SVG', parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  const records = [canvas, imageNode('node:svg', 100, 100, HALF_HASH, 20, 20)]
  const stored = new Map<string, string>([[HALF_HASH, HALF]])
  const uploads: { headers: Record<string, string>; body: string }[] = []
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [] } }))
  await page.route('**/api/assets**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/api/assets' && request.method() === 'GET') {
      return route.fulfill({ json: { assets: [{ mime: 'image/svg+xml', size: HALF.length, hash: HALF_HASH, width: 20, height: 20, variants: [] }] } })
    }
    if (url.pathname === '/api/assets' && request.method() === 'POST') {
      const body = request.postData() ?? ''
      uploads.push({ headers: request.headers(), body })
      stored.set(sha256(body), body)
      return route.fulfill({ json: { hash: sha256(body), mime: 'image/svg+xml', size: body.length } })
    }
    const svg = stored.get(url.pathname.split('/')[3] ?? '')
    if (svg && request.method() === 'GET') return route.fulfill({ body: svg, contentType: 'image/svg+xml' })
    return route.fulfill({ status: 404, json: { error: 'not found' } })
  })
  // SVG の中のスクリプトが動いたら（alert）、ここに入る
  const dialogs: string[] = []
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message())
    void dialog.dismiss()
  })
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
  return { uploads, dialogs }
}

async function canvasBox(page: Page) {
  return (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
}

// 画面の、キャンバスの左上から (x, y) の横 width 画素の色（[r, g, b] の並び）
async function screenRow(page: Page, x: number, y: number, width: number): Promise<number[][]> {
  const box = await canvasBox(page)
  await page.mouse.move(5, 5)
  const png = await page.screenshot({ clip: { x: box.x + x, y: box.y + y, width, height: 1 } })
  return pngRow(page, png, 0)
}

// PNG の y 行目の色
async function pngRow(page: Page, png: Buffer, y: number): Promise<number[][]> {
  return page.evaluate(
    async ({ base64, y }) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: 'image/png' }))
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      const data = ctx.getImageData(0, y, bitmap.width, 1).data
      return Array.from({ length: bitmap.width }, (_, i) => [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]])
    },
    { base64: png.toString('base64'), y },
  )
}

function kindOf([r, g, b]: number[]): string {
  if (r > 200 && g < 60 && b < 60) return 'red'
  if (b > 200 && r < 60 && g < 60) return 'blue'
  if (Math.min(r, g, b) > 200) return 'light'
  return 'mixed'
}

// 横に並んだ画素の、赤から青への変わり目のようす：左端・右端の色と、間の混ざった色の画素の数
function edge(row: number[][]): { left: string; right: string; mixed: number } {
  const kinds = row.map(kindOf)
  return { left: kinds[0], right: kinds.at(-1)!, mixed: kinds.filter((kind) => kind === 'mixed').length }
}

async function setCamera(page: Page, camera: { x: number; y: number; zoom: number }) {
  await page.evaluate((camera) => (window as any).canvcode.view.setCamera(camera), camera)
}

test('draws an SVG image node, and redraws it sharply when zoomed in', async ({ page }) => {
  await openApp(page)
  // 等倍：画像は (100, 100) から 20×20。左半分が赤、右半分が青
  await expect.poll(async () => edge(await screenRow(page, 102, 110, 16))).toEqual({ left: 'red', right: 'blue', mixed: expect.any(Number) })
  expect(edge(await screenRow(page, 102, 110, 16)).mixed).toBeLessThanOrEqual(1)
  // 8 倍に拡大：境目（x = 110）は画面の 160。描き直すまでは引き伸ばしで境目がぼやけ、描き直すと 1 画素ほどになる
  await setCamera(page, { x: 90, y: 90, zoom: 8 })
  await expect.poll(async () => edge(await screenRow(page, 140, 160, 40)), { timeout: 10_000 }).toEqual({ left: 'red', right: 'blue', mixed: expect.any(Number) })
  await expect.poll(async () => edge(await screenRow(page, 140, 160, 40)).mixed, { timeout: 10_000 }).toBeLessThanOrEqual(1)
  // 頼んだ大きさ（画面で 160 画素 → 256 画素）で描いた
  expect(await page.evaluate((key) => (window as any).canvcode.view.images.has(key, 'v1', 256), `asset:${HALF_HASH}`)).toBe(true)
})

test('sanitizes a dropped SVG before uploading it, and places it at its size', async ({ page }) => {
  const { uploads, dialogs } = await openApp(page)
  // Material Symbols の配布物の形（width・height に px）に、スクリプト・イベントの属性・外への参照を足したもの
  const dropped = [
    '<?xml version="1.0"?>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" height="100px" viewBox="0 0 200 100" width="200px" onload="alert(1)">',
    '<script>alert(2)</script>',
    '<rect width="100" height="100" fill="#ff0000"/><rect x="100" width="100" height="100" fill="#0000ff" onclick="alert(3)"/>',
    '<image href="https://example.com/x.png" width="10" height="10"/>',
    '<foreignObject width="10" height="10"><iframe xmlns="http://www.w3.org/1999/xhtml" src="javascript:alert(4)"/></foreignObject>',
    '</svg>',
  ].join('\n')
  const box = await canvasBox(page)
  await page.evaluate(
    async ({ svg, x, y }) => {
      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(new File([svg], 'icon.svg', { type: 'image/svg+xml' }))
      const target = document.querySelector('.canvas-container > div[tabindex]')!
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer }))
    },
    { svg: dropped, x: box.x + 500, y: box.y + 500 },
  )
  await expect.poll(() => uploads.length).toBe(1)
  const upload = uploads[0]
  expect(upload.headers['content-type']).toBe('image/svg+xml')
  expect(upload.headers['x-canvcode-sha256']).toBe(sha256(upload.body))
  expect(upload.body).toBe(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">' +
      '<rect width="100" height="100" fill="#ff0000"/><rect x="100" width="100" height="100" fill="#0000ff"/><image width="10" height="10"/></svg>',
  )
  // 落とした所を中心に、SVG の大きさ（200×100）で置く
  const node = await page.evaluate(() => {
    const editor = (window as any).canvcode.editor
    const [id] = [...editor.session.get().selectedIds]
    return { type: editor.getNode(id).type, bounds: editor.index.get(id).worldBounds }
  })
  expect(node).toEqual({ type: 'image', bounds: { x: 400, y: 450, w: 200, h: 100 } })
  await expect.poll(async () => edge(await screenRow(page, 420, 500, 160))).toMatchObject({ left: 'red', right: 'blue' })
  expect(dialogs).toEqual([])
})

test('pastes SVG code (such as "Copy as SVG" in Figma) as an image', async ({ page }) => {
  const { uploads } = await openApp(page)
  // 置いてある SVG と違う中身にする（同じ中身なら、同じ Asset を使ってアップロードしない）
  const pasted = HALF.replace('#0000ff', '#00ff00')
  await page.locator('.canvas-container > div[tabindex]').evaluate((el, text) => {
    // Firefox は、作った paste イベントの中では DataTransfer の中身を読ませないので、同じ形の物を持たせる
    const data = { types: ['text/plain'], files: [], items: [], getData: (type: string) => (type === 'text/plain' ? text : '') }
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: data })
    el.dispatchEvent(event)
  }, `\n${pasted.replace('<svg ', '<svg onload="alert(1)" ')}\n`)
  await expect.poll(() => uploads.map((upload) => upload.body)).toEqual([pasted])
  expect(await page.evaluate(() => {
    const editor = (window as any).canvcode.editor
    const [id] = [...editor.session.get().selectedIds]
    return editor.getNode(id)?.props.assetId
  })).toBe(`asset:${sha256(pasted)}`)
})

test('saves an SVG image as a PNG drawn at the size it needs', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => (window as any).canvcode.editor.setSelection(['node:svg']))
  // 右クリックの「画像として保存 › 2 倍」
  const download = page.waitForEvent('download')
  const box = await canvasBox(page)
  await page.mouse.click(box.x + 110, box.y + 110, { button: 'right' })
  await page.locator('.context-menu button', { hasText: '画像として保存 ›' }).first().click()
  await page.locator('.context-menu button', { hasText: '2 倍（' }).first().click()
  const saved = await readFile(await (await download).path())
  // 20×20 に余白（8）を足して 2 倍：72×72。画像は (16, 16) から 40×40
  const row = await pngRow(page, saved, 36)
  expect(row).toHaveLength(72)
  expect(edge(row.slice(18, 54))).toEqual({ left: 'red', right: 'blue', mixed: expect.any(Number) })
  expect(edge(row.slice(18, 54)).mixed).toBeLessThanOrEqual(1)

  // 8 倍（AI の render_canvas などで大きく描くとき）でも、引き伸ばさずに描く
  const big = await page.evaluate(async () => {
    const { view, editor } = (window as any).canvcode
    const image = await view.renderImage(editor, { kind: 'nodes', ids: ['node:svg'] }, { scale: 8 })
    const bytes = new Uint8Array(await image.png.arrayBuffer())
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return { width: image.width, base64: btoa(binary) }
  })
  expect(big.width).toBe(288)
  const bigRow = await pngRow(page, Buffer.from(big.base64, 'base64'), 144)
  // 境目は x = 64 + 80 = 144
  expect(edge(bigRow.slice(104, 184))).toEqual({ left: 'red', right: 'blue', mixed: expect.any(Number) })
  expect(edge(bigRow.slice(104, 184)).mixed).toBeLessThanOrEqual(1)
})
