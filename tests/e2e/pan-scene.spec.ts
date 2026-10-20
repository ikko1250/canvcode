import { expect, test, type Page } from '@playwright/test'

// パン（倍率が同じまま動く）では、シーンの前の絵をずらして、見えてきた端だけを描く（view.ts の drawSceneLayer）。
// 端数の量で何度パンしても、シーン全体を描き直したときと同じ絵になること。止まったら全体を描き直すこと

const CANVAS_ID = 'canvas:pan-scene'

async function openApp(page: Page) {
  const canvas = { typeName: 'canvas', id: CANVAS_ID, title: 'Pan', parentCanvasId: null, ownerNodeId: null, createdAt: 0, updatedAt: 0, deletedAt: null, trash: null }
  const colors = ['#e03131', '#2f9e44', '#1971c2', '#f08c00']
  const nodes = Array.from({ length: 400 }, (_, i) => ({
    typeName: 'node', id: `node:${i}`, type: 'geo', parentId: CANVAS_ID, x: (i % 20) * 70, y: Math.floor(i / 20) * 70, rotation: (i % 7) * 0.2,
    index: `a${String(i).padStart(4, '0')}`, opacity: 1, locked: false, version: 3,
    props: {
      shape: i % 3 ? 'rect' : 'ellipse', w: 50, h: 40, fill: { type: 'solid', color: colors[i % 4], opacity: 1 },
      stroke: { type: 'solid', color: '#212529', opacity: 1 }, strokeWidth: 2, label: '',
    },
    meta: {},
  }))
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records: [canvas, ...nodes] } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [] } }))
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
  await page.waitForFunction(() => Boolean((window as any).canvcode))
}

// シーンの Canvas の画素を覚える（2 番目の canvas がシーン）。compare なら、覚えたものと違う画素の割合を返す
const snapshotScene = (page: Page, compare: boolean) =>
  page.evaluate((compare) => {
    const canvas = document.querySelectorAll('.canvas-container canvas')[1] as HTMLCanvasElement
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    const w = window as any
    if (!compare) {
      w.__scene = data
      return 0
    }
    const before: Uint8ClampedArray = w.__scene
    let differing = 0
    for (let i = 0; i < data.length; i += 4) {
      const d = Math.abs(data[i] - before[i]) + Math.abs(data[i + 1] - before[i + 1]) + Math.abs(data[i + 2] - before[i + 2]) + Math.abs(data[i + 3] - before[i + 3])
      if (d > 24) differing++
    }
    return differing / (data.length / 4)
  }, compare)

const nextFrames = (page: Page, n = 2) =>
  page.evaluate((n) => new Promise<void>((resolve) => {
    let left = n
    const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step))
    requestAnimationFrame(step)
  }), n)

test('panning by fractional amounts draws the same scene as a full redraw', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => (window as any).canvcode.view.setCamera({ x: 100.3, y: 80.7, zoom: 0.83 }))
  await nextFrames(page)
  // 1 フレームごとに、端数の量で動かす（ずらして描く）
  for (let i = 0; i < 12; i++) {
    await page.evaluate((i) => {
      const view = (window as any).canvcode.view
      const c = view.editor.session.get().camera
      view.setCamera({ ...c, x: c.x + 7.37 + i, y: c.y - 3.21 * (i % 3) })
    }, i)
    await nextFrames(page, 1)
  }
  await nextFrames(page)
  await snapshotScene(page, false)
  await page.evaluate(() => (window as any).canvcode.view.invalidate('scene'))
  await nextFrames(page)
  const differing = await snapshotScene(page, true)
  // 帯の境目の、なめらかにした縁の画素がわずかに違うことはある
  expect(differing).toBeLessThan(0.002)
})

test('after panning stops, the whole scene is redrawn', async ({ page }) => {
  await openApp(page)
  const drawnAfter = async () => (await page.evaluate(() => (window as any).canvcode.view.getStats().drawnNodes)) as number
  await page.evaluate(() => (window as any).canvcode.view.setCamera({ x: 0, y: 0, zoom: 1 }))
  // 開いた直後は、パネルが出るなどでキャンバスの大きさが変わり、シーン全体を描き直すことがあるので、落ち着くまで待つ
  await page.waitForTimeout(600)
  await nextFrames(page)
  await page.evaluate(() => (window as any).canvcode.view.resetStats())
  await page.evaluate(() => {
    const view = (window as any).canvcode.view
    view.setCamera({ x: 3, y: 0, zoom: 1 })
  })
  await nextFrames(page)
  // ずらしたフレームは、見えてきた端のノードだけを描く
  const partial = await drawnAfter()
  // 止まってしばらくすると、全体を描き直す
  await page.waitForTimeout(400)
  await nextFrames(page)
  const full = await drawnAfter()
  expect(full).toBeGreaterThan(partial)
})
