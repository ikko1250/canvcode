import { crc32, deflateSync } from 'node:zlib'
import { expect, test, type Page } from '@playwright/test'

// 画像のトリミング（切り抜きモード。packages/canvas の cropHandles.ts）：画像ノードと、画像の塗りの図形（スライドの画像枠など）を、
// ダブルクリックで入るモードで切り抜く。結果はスクリーンショットの画素で確かめる（image-fill.spec.ts と同じ。サーバーの応答は差し替える）

const CANVAS_ID = 'canvas:image-crop-test'
const HASH = 'b'.repeat(64)
const ASSET_ID = `asset:${HASH}`
// 40×20 の画像：左半分が赤、右半分が青
const IMAGE = { width: 40, height: 20 }

// 左半分が赤・右半分が青の PNG（RGB、フィルタなし）
function halfRedHalfBluePng(width: number, height: number): Buffer {
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) row.set(x < width / 2 ? [255, 0, 0] : [0, 0, 255], 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const PNG = halfRedHalfBluePng(IMAGE.width, IMAGE.height)

function imageFill(options: object = {}) {
  return { type: 'image', assetId: ASSET_ID, scaleMode: 'fill', crop: { x: 0, y: 0, w: 1, h: 1 }, tileScale: 1, opacity: 1, ...options }
}

function node(id: string, x: number, y: number, index: string, props: object) {
  return {
    typeName: 'node', id, type: 'geo', parentId: CANVAS_ID, x, y, rotation: 0, index, opacity: 1, locked: false, version: 2,
    props: { shape: 'rect', w: 100, h: 100, stroke: '#3b5bdb', strokeWidth: 0, label: '', ...props }, meta: {},
  }
}

function imageNode(id: string, x: number, y: number, index: string) {
  return {
    typeName: 'node', id, type: 'image', parentId: CANVAS_ID, x, y, rotation: 0, index, opacity: 1, locked: false,
    props: { assetId: ASSET_ID, w: 200, h: 100, crop: null }, meta: {},
  }
}

async function openApp(page: Page) {
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: 'Image crop', parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  const records = [
    canvas,
    // 画像ノード（200×100。左半分が赤、右半分が青）
    imageNode('node:image', 100, 100, 'a1'),
    // 正方形の画像枠に横長（2:1）の画像を塗りつぶし：見えているのは画像の真ん中の半分
    node('node:frame', 100, 300, 'a2', { fill: imageFill() }),
  ]
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [] } }))
  await page.route('**/api/assets**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/assets' && route.request().method() === 'GET') {
      return route.fulfill({ json: { assets: [{ mime: 'image/png', size: PNG.length, hash: HASH, width: IMAGE.width, height: IMAGE.height, variants: [] }] } })
    }
    // 画像（ドロップした画像も、アップロードのあとはサーバーから読む。中身は同じ）
    if (url.pathname.startsWith('/api/assets/') && route.request().method() === 'GET') return route.fulfill({ body: PNG, contentType: 'image/png' })
    // ドロップした画像のアップロード
    return route.fulfill({ json: {} })
  })
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

// 画面の 1 画素の色（[r, g, b]）
async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  const p = await screen(page, x, y)
  await page.mouse.move(5, 5)
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

type Kind = 'red' | 'blue' | 'green' | 'light'

function kindOf([r, g, b]: number[]): string {
  if (r > 200 && g < 60 && b < 60) return 'red'
  if (b > 200 && r < 60 && g < 60) return 'blue'
  if (g > 120 && r < 90 && b < 110) return 'green'
  if (Math.min(r, g, b) > 200) return 'light'
  return `other(${r},${g},${b})`
}

// 画像は読み込まれてから描かれるので、そうなるまで待つ
async function expectKind(page: Page, x: number, y: number, kind: Kind) {
  await expect.poll(async () => kindOf(await pixel(page, x, y)), { message: `pixel at ${x},${y}` }).toBe(kind)
}

async function dragWorld(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const a = await screen(page, from.x, from.y)
  const b = await screen(page, to.x, to.y)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2)
  await page.mouse.move(b.x, b.y)
  await page.mouse.up()
}

async function doubleClickWorld(page: Page, x: number, y: number) {
  const p = await screen(page, x, y)
  await page.mouse.dblclick(p.x, p.y)
}

test('crops an image node on the canvas, undoes it and uncrops it from the panel', async ({ page }) => {
  await openApp(page)
  await expectKind(page, 150, 150, 'red')
  await expectKind(page, 250, 150, 'blue')
  await doubleClickWorld(page, 150, 150)
  // 右辺を左へ 100：左半分（赤）だけが残る
  await dragWorld(page, { x: 300, y: 150 }, { x: 200, y: 150 })
  await page.keyboard.press('Escape')
  await expectKind(page, 150, 150, 'red')
  await expectKind(page, 250, 150, 'light')

  // 画像を左へ動かす（窓は動かない）：右半分（青）が見える
  await doubleClickWorld(page, 150, 150)
  await dragWorld(page, { x: 150, y: 150 }, { x: 50, y: 150 })
  await page.keyboard.press('Enter')
  await expectKind(page, 150, 150, 'blue')
  await expectKind(page, 250, 150, 'light')

  // Undo で 1 回ずつ戻る
  await page.keyboard.press('Control+z')
  await expectKind(page, 150, 150, 'red')
  await expectKind(page, 250, 150, 'light')

  // パネルの「切り抜きを戻す」で、画像の全体に戻す（画像は動かない）
  await clickWorld(page, 150, 150)
  await page.getByTestId('design-panel').getByRole('button', { name: '切り抜きを戻す' }).click()
  await expectKind(page, 150, 150, 'red')
  await expectKind(page, 250, 150, 'blue')
})

test('pans the image in an image frame without changing the frame', async ({ page }) => {
  await openApp(page)
  // 塗りつぶし：200×100 の画像の真ん中（x 150〜250 → 枠の 100〜200）
  await expectKind(page, 125, 350, 'red')
  await expectKind(page, 175, 350, 'blue')
  await doubleClickWorld(page, 150, 350)
  // 画像を右へ動かす：左の端で止まり、画像の左半分（赤）だけが見える
  await dragWorld(page, { x: 150, y: 350 }, { x: 300, y: 350 })
  await page.keyboard.press('Escape')
  await expectKind(page, 125, 350, 'red')
  await expectKind(page, 175, 350, 'red')
  // 枠の外は塗らない
  await expectKind(page, 215, 350, 'light')
})
