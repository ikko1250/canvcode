import { crc32, deflateSync } from 'node:zlib'
import { expect, test, type Page } from '@playwright/test'

// 図形の画像の塗り（MAI-83）：塗りつぶし・全体を収める・切り抜き・タイルの各モードと、楕円での切り抜きを、
// スクリーンショットの画素で確かめる（gradient.spec.ts と同じ）。パネルで単色から画像へ切り替え、
// Alt を押しながらのドロップで塗りにできること。サーバーの応答（記録・Asset の一覧と画像）は差し替える

const CANVAS_ID = 'canvas:image-fill-test'
const HASH = 'a'.repeat(64)
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

async function openApp(page: Page) {
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: 'Image fill', parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  const records = [
    canvas,
    // 正方形に横長（2:1）の画像
    node('node:fill', 100, 100, 'a1', { fill: imageFill() }),
    node('node:fit', 250, 100, 'a2', { fill: imageFill({ scaleMode: 'fit' }) }),
    // 右半分（青）だけを切り抜く
    node('node:crop', 400, 100, 'a3', { fill: imageFill({ scaleMode: 'crop', crop: { x: 0.5, y: 0, w: 0.5, h: 1 } }) }),
    // 元の大きさの半分（20×10）で敷き詰める
    node('node:tile', 550, 100, 'a4', { fill: imageFill({ scaleMode: 'tile', tileScale: 0.5 }) }),
    // 楕円は形で切り抜く
    node('node:ellipse', 700, 100, 'a5', { shape: 'ellipse', fill: imageFill() }),
    // 単色（パネルで画像に切り替える）
    node('node:solid', 100, 300, 'a6', { fill: { type: 'solid', color: '#2f9e44', opacity: 1 } }),
    // Alt を押しながら画像を落とす先
    node('node:drop', 300, 300, 'a7', { fill: { type: 'solid', color: '#2f9e44', opacity: 1 } }),
  ]
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records } }))
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

const panelFill = (page: Page) => page.getByTestId('design-panel').locator('[data-section="fill"]')

test('draws image fills in each scale mode, clipped to the shape', async ({ page }) => {
  await openApp(page)
  // 塗りつぶし：画像を 200×100 にして中央に置く。左半分が赤、右半分が青で、上下も覆う
  await expectKind(page, 125, 105, 'red')
  await expectKind(page, 125, 195, 'red')
  await expectKind(page, 175, 150, 'blue')
  // 全体を収める：100×50 にして中央（y 125〜175）。上下は塗らない
  await expectKind(page, 275, 150, 'red')
  await expectKind(page, 325, 150, 'blue')
  await expectKind(page, 275, 110, 'light')
  await expectKind(page, 325, 190, 'light')
  // 切り抜き：右半分（青）だけを図形に合わせる
  await expectKind(page, 410, 110, 'blue')
  await expectKind(page, 490, 190, 'blue')
  // タイル：20×10 のタイル（左 10 が赤、右 10 が青）を左上から
  await expectKind(page, 555, 105, 'red')
  await expectKind(page, 565, 105, 'blue')
  await expectKind(page, 575, 145, 'red')
  await expectKind(page, 585, 195, 'blue')
  // 楕円：形の外（箱の角）は塗らない
  await expectKind(page, 725, 150, 'red')
  await expectKind(page, 775, 150, 'blue')
  await expectKind(page, 703, 103, 'light')
  await expectKind(page, 797, 197, 'light')
})

test('switches a solid fill to an image and changes how it is shown in the panel', async ({ page }) => {
  await openApp(page)
  await expectKind(page, 150, 350, 'green')
  await clickWorld(page, 150, 350)
  const fill = panelFill(page)
  await fill.getByRole('button', { name: '色を選ぶ' }).click()
  await fill.getByRole('group', { name: '種類' }).getByRole('button', { name: '画像' }).click()
  // 画像を選ぶまでは塗りを変えない
  await expectKind(page, 150, 350, 'green')
  await fill.getByRole('group', { name: 'ワークスペースの画像' }).locator(`[data-asset-id="${ASSET_ID}"]`).click()
  await expect(fill.locator('.design-paint-kind')).toHaveText('画像')
  await expectKind(page, 125, 350, 'red')
  await expectKind(page, 175, 350, 'blue')

  // 切り抜き：塗りつぶしで見えていた範囲（画像の中央の半分）から始め、数値で右半分にする
  const modes = fill.getByRole('group', { name: '表示のしかた' })
  await modes.getByRole('button', { name: '切り抜き' }).click()
  await expect(fill.getByRole('textbox', { name: '左' })).toHaveValue('25')
  await expect(fill.getByRole('textbox', { name: '幅' })).toHaveValue('50')
  await fill.getByRole('textbox', { name: '左' }).fill('50')
  await fill.getByRole('textbox', { name: '左' }).press('Enter')
  await expectKind(page, 125, 350, 'blue')
  await expectKind(page, 175, 350, 'blue')

  // タイル：倍率 50 % で 20×10 のタイル
  await clickWorld(page, 150, 350)
  await fill.getByRole('button', { name: '色を選ぶ' }).click()
  await fill.getByRole('group', { name: '表示のしかた' }).getByRole('button', { name: 'タイル' }).click()
  await fill.getByRole('textbox', { name: '倍率' }).fill('50')
  await fill.getByRole('textbox', { name: '倍率' }).press('Enter')
  await expectKind(page, 105, 305, 'red')
  await expectKind(page, 115, 305, 'blue')

  // Undo で戻せる（倍率 → タイル → 切り抜きの範囲）
  await clickWorld(page, 900, 700)
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+z')
  await expectKind(page, 125, 350, 'blue')

  // 単色へ戻す
  await clickWorld(page, 150, 350)
  await fill.getByRole('button', { name: '色を選ぶ' }).click()
  await fill.getByRole('group', { name: '種類' }).getByRole('button', { name: '単色' }).click()
  await expect(fill.locator('input.design-hex')).toBeVisible()
})

test('drops an image onto a shape with Alt to fill it, and places an image node without Alt', async ({ page }) => {
  await openApp(page)
  await expectKind(page, 350, 350, 'green')
  const drop = async (x: number, y: number, altKey: boolean) => {
    const p = await screen(page, x, y)
    await page.evaluate(
      async ({ bytes, x, y, altKey }) => {
        const dataTransfer = new DataTransfer()
        dataTransfer.items.add(new File([new Uint8Array(bytes)], 'stripes.png', { type: 'image/png' }))
        const target = document.querySelector('.canvas-container > div[tabindex]')!
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, altKey, dataTransfer }))
      },
      { bytes: [...PNG], x: p.x, y: p.y, altKey },
    )
  }
  await drop(350, 350, true)
  await expectKind(page, 325, 350, 'red')
  await expectKind(page, 375, 350, 'blue')
  // 塗りにした図形を選んでいる
  await expect(panelFill(page).locator('.design-paint-kind')).toHaveText('画像')

  // Alt なしなら、画像ノードを置く（図形の塗りは変えない）
  await drop(150, 600, false)
  await expect(page.getByTestId('design-panel').locator('.design-panel-title')).toHaveText('画像')
})

test('pastes a clipboard image into the fill of the selected shape with Ctrl+Alt+V', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'クリップボードの読み取りの許可を与えられるのは Chromium だけ')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openApp(page)
  await page.evaluate(async (bytes) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  }, [...PNG])
  await clickWorld(page, 350, 350)
  await page.keyboard.press('Control+Alt+v')
  await expectKind(page, 325, 350, 'red')
  await expectKind(page, 375, 350, 'blue')
  // 画像ノードは作らない（選んでいるのは図形のまま）
  // 図形は見た目と文字のタブに分かれる。開いているのは見た目のタブ
  await expect(page.getByTestId('design-panel').getByRole('tab', { selected: true })).toHaveAccessibleName('図形')
})
