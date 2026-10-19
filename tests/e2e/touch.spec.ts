import { expect, test, type CDPSession, type Page } from '@playwright/test'

// スマホ（タッチ）：2 本指でパン・ピンチでズームでき、1 本目の指で始めた操作（フリーハンドなど）は残らず、
// 1 本目の指を置いたところのノードも選ばれないこと。始めにパンかズームかを決め、指を離すまでもう一方はしないこと。
// キーボードがないので、左下のボタンからパイメニューを出し、指をずらして選べること・叩いて出して、項目を叩いて選べること。
// タッチは CDP（Input.dispatchTouchEvent）で送るので Chromium だけ

const CANVAS_ID = 'canvas:touch-test'

test.use({ hasTouch: true, viewport: { width: 420, height: 800 } })
test.skip(({ browserName }) => browserName !== 'chromium', 'タッチは CDP で送る')

function geo(id: string, x: number, y: number) {
  return {
    typeName: 'node', id, type: 'geo', parentId: CANVAS_ID, x, y, rotation: 0, index: 'a1', opacity: 1, locked: false, version: 3,
    props: { shape: 'rect', w: 3000, h: 3000, fill: { type: 'solid', color: '#1971c2', opacity: 1 }, stroke: null, strokeWidth: 0, label: '' },
    meta: {},
  }
}

async function openApp(page: Page, nodes: object[] = []) {
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: 'Touch', parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records: [canvas, ...nodes] } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [] } }))
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
  await page.waitForFunction(() => Boolean((window as any).canvcode))
}

type Point = { x: number; y: number }

// 指の組を、frames の位置を順にたどって動かす（どの指も同時に。区切りごとに steps 回に分けて）
async function touchPath(cdp: CDPSession, frames: Point[][], steps = 8) {
  // 1 本目が触れてから、2 本目が触れる
  const first = frames[0].map((p, id) => ({ id, ...p }))
  for (let n = 1; n <= first.length; n++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: first.slice(0, n) })
  for (let f = 1; f < frames.length; f++) {
    const [from, to] = [frames[f - 1], frames[f]]
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const touchPoints = from.map((p, id) => ({ id, x: p.x + (to[id].x - p.x) * t, y: p.y + (to[id].y - p.y) * t }))
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints })
    }
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

const touchGesture = (cdp: CDPSession, from: Point[], to: Point[]) => touchPath(cdp, [from, to])

const shift = (points: Point[], dx: number, dy: number) => points.map((p) => ({ x: p.x + dx, y: p.y + dy }))

const camera = (page: Page) => page.evaluate(() => (window as any).canvcode.editor.session.get().camera as { x: number; y: number; zoom: number })
const nodeCount = (page: Page) =>
  page.evaluate(() => [...(window as any).canvcode.workspace.store.values()].filter((r: any) => r.typeName === 'node').length)

async function buttonCenter(page: Page, label: string): Promise<Point> {
  const box = (await page.locator('.pie-buttons button', { hasText: label }).boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

test('2 本指でパンし、ピンチでズームする。1 本目の指で始めたフリーハンドは残らない', async ({ page }) => {
  await openApp(page)
  const cdp = await page.context().newCDPSession(page)
  await page.evaluate(() => (window as any).canvcode.editor.session.set({ toolId: 'draw' }))
  const before = await camera(page)

  // パン：2 本とも右下へ 60, 40
  await touchGesture(cdp, [{ x: 150, y: 300 }, { x: 250, y: 300 }], [{ x: 210, y: 340 }, { x: 310, y: 340 }])
  const panned = await camera(page)
  expect(panned.zoom).toBeCloseTo(before.zoom)
  expect((before.x - panned.x) * panned.zoom).toBeCloseTo(60, 0)
  expect((before.y - panned.y) * panned.zoom).toBeCloseTo(40, 0)
  expect(await nodeCount(page)).toBe(0)

  // ピンチ：中点（200, 400）のまま、間を 100 から 200 に広げる
  await touchGesture(cdp, [{ x: 150, y: 400 }, { x: 250, y: 400 }], [{ x: 100, y: 400 }, { x: 300, y: 400 }])
  const zoomed = await camera(page)
  expect(zoomed.zoom / panned.zoom).toBeCloseTo(2, 1)
  expect(await nodeCount(page)).toBe(0)
  // 中点の下のワールドの点は動かない
  const rect = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  const anchor = { x: 200 - rect.x, y: 400 - rect.y }
  expect(panned.x + anchor.x / panned.zoom).toBeCloseTo(zoomed.x + anchor.x / zoomed.zoom, 0)
  expect(panned.y + anchor.y / panned.zoom).toBeCloseTo(zoomed.y + anchor.y / zoomed.zoom, 0)

  // 1 本指なら、今までどおりフリーハンドで描く
  await touchGesture(cdp, [{ x: 150, y: 300 }], [{ x: 250, y: 380 }])
  await expect.poll(() => nodeCount(page)).toBe(1)
})

test('始めにズームしたらパンせず、始めにパンしたらズームしない', async ({ page }) => {
  await openApp(page)
  const cdp = await page.context().newCDPSession(page)
  const rect = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  const worldAt = (c: { x: number; y: number; zoom: number }, p: Point) => ({ x: c.x + (p.x - rect.x) / c.zoom, y: c.y + (p.y - rect.y) / c.zoom })

  // 指の間を 100 から 200 に広げてから、2 本とも右下へ動かす：ズームだけで、始めの中点の下の点は動かない
  const pair = [{ x: 150, y: 400 }, { x: 250, y: 400 }]
  const before = await camera(page)
  const spread = [{ x: 100, y: 400 }, { x: 300, y: 400 }]
  await touchPath(cdp, [pair, spread, shift(spread, 80, 60)])
  const zoomed = await camera(page)
  expect(zoomed.zoom / before.zoom).toBeCloseTo(2, 1)
  const anchorBefore = worldAt(before, { x: 200, y: 400 })
  const anchorAfter = worldAt(zoomed, { x: 200, y: 400 })
  expect(anchorAfter.x).toBeCloseTo(anchorBefore.x, 0)
  expect(anchorAfter.y).toBeCloseTo(anchorBefore.y, 0)

  // 2 本とも右へ 60 動かしてから、指の間を広げる：パンだけで、倍率は変わらない
  const moved = shift(pair, 60, 0)
  await touchPath(cdp, [pair, moved, [{ x: moved[0].x - 50, y: 400 }, { x: moved[1].x + 50, y: 400 }]])
  const panned = await camera(page)
  expect(panned.zoom).toBeCloseTo(zoomed.zoom)
  expect((zoomed.x - panned.x) * panned.zoom).toBeCloseTo(60, 0)
})

test('2 本指でパンしても、1 本目の指を置いたところのノードは選ばれない。1 本指で叩けば選ぶ', async ({ page }) => {
  await openApp(page, [geo('node:big', -1000, -1000)])
  const cdp = await page.context().newCDPSession(page)
  const selected = () => page.evaluate(() => [...(window as any).canvcode.editor.session.get().selectedIds] as string[])
  await touchGesture(cdp, [{ x: 150, y: 300 }, { x: 250, y: 300 }], [{ x: 210, y: 340 }, { x: 310, y: 340 }])
  expect(await selected()).toEqual([])
  const node = await page.evaluate(() => (window as any).canvcode.workspace.store.get('node:big'))
  expect([node.x, node.y]).toEqual([-1000, -1000])
  await page.touchscreen.tap(200, 300)
  await expect.poll(selected).toEqual(['node:big'])
})

test('左下のボタンからパイメニューを出し、指をずらして選ぶ・叩いて選ぶ', async ({ page }) => {
  await openApp(page)
  const cdp = await page.context().newCDPSession(page)
  const tool = () => page.evaluate(() => (window as any).canvcode.editor.session.get().toolId as string)
  await expect(page.locator('.pie-buttons button')).toHaveText(['ツール', '操作', 'そのほか'])

  // 「ツール」を押したまま右へずらす（8 項目の右は 3 番目の「フリーハンド」）と、その項目が選ばれ、離すと実行する
  const tools = await buttonCenter(page, 'ツール')
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 0, ...tools }] })
  await expect(page.locator('.pie-hub')).toBeVisible()
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 0, x: tools.x + 30, y: tools.y }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 0, x: tools.x + 60, y: tools.y }] })
  await expect(page.locator('.pie-item.highlight')).toHaveText('フリーハンド')
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await expect(page.locator('.pie-hub')).toBeHidden()
  expect(await tool()).toBe('draw')

  // 叩いただけなら出したまま。サブメニュー（図形）を叩くと中に入り、項目（矩形）を叩くと実行する
  await page.touchscreen.tap(tools.x, tools.y)
  await expect(page.locator('.pie-hub')).toBeVisible()
  await expect(page.locator('.pie-item.active')).toHaveText('フリーハンド')
  const tapItem = async (label: string) => {
    const box = (await page.locator('.pie-item', { hasText: label }).first().boundingBox())!
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
  }
  await tapItem('図形')
  await expect(page.locator('.pie-hub span')).toHaveText('ツール › 図形')
  await tapItem('矩形')
  await expect(page.locator('.pie-hub')).toBeHidden()
  expect(await tool()).toBe('rect')

  // 出しているときに輪から遠くを叩くと、何も選ばずに消す。同じボタンをもう一度叩いても消す
  await page.touchscreen.tap(tools.x, tools.y)
  await expect(page.locator('.pie-hub')).toBeVisible()
  await page.touchscreen.tap(400, 60)
  await expect(page.locator('.pie-hub')).toBeHidden()
  await page.touchscreen.tap(tools.x, tools.y)
  await expect(page.locator('.pie-hub')).toBeVisible()
  await page.touchscreen.tap(tools.x, tools.y)
  await expect(page.locator('.pie-hub')).toBeHidden()
  expect(await tool()).toBe('rect')
  expect(await nodeCount(page)).toBe(0)
})
