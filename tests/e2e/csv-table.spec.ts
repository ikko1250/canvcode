import { expect, test, type Page } from '@playwright/test'

// 表のカード（.csv の File）：見出しと縞を塗ったセルを、見えているところだけタイルの画像にして描くこと、
// CSV のファイルを落とすと、Shift_JIS も読んで UTF-8 の File（kind: 'table'）にし、表のカードを置くこと。
// 本物の画面を使い、サーバーの応答だけを差し替える（markdown-tiles.spec.ts と同じ）

const CANVAS_ID = 'canvas:csv-test'
const FILE_ID = 'file:csv-test'
// 2000 行（見出しを入れて 2001 行）の表。高さを中身に合わせると、帯 36 + 2001 × 28
const ROWS = 2000
const CSV = ['番号,名前,値', ...Array.from({ length: ROWS }, (_, i) => `${i + 1},項目 ${i + 1},${(i + 1) * 10}`)].join('\n') + '\n'

async function openApp(page: Page) {
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: 'CSV', parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  const card = {
    typeName: 'node', id: 'node:table', type: 'table-card', parentId: CANVAS_ID, x: 100, y: 100, rotation: 0, index: 'a1', opacity: 1, locked: false, version: 1,
    props: { fileId: FILE_ID, w: 400, h: 200, sizing: 'auto', role: 'owner', header: true },
    meta: {},
  }
  const file = { id: FILE_ID, kind: 'table', title: '一覧', path: '一覧.csv', size: CSV.length, mtime: 0, hash: 'test', missing: false }
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records: [canvas, card] } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [file] } }))
  await page.route(`**/api/files/${encodeURIComponent(FILE_ID)}/content`, (route) => route.fulfill({ body: CSV, headers: { etag: '"test"' } }))
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
}

async function setCamera(page: Page, x: number, y: number, zoom: number) {
  await page.evaluate((camera) => (window as any).canvcode.view.setCamera(camera), { x, y, zoom })
}

// 作った表のタイル（キーの # から後ろ → 作った解像度）
async function tableTiles(page: Page): Promise<Record<string, number[]>> {
  return page.evaluate(() => {
    const entries: Array<[string, any]> = [...(window as any).canvcode.view.images.images.entries()]
    return Object.fromEntries(entries.filter(([key]) => key.startsWith('node:table#table:')).map(([key, entry]) => [key.slice('node:table'.length), [...entry.levels.keys()]]))
  })
}

async function waitForImages(page: Page) {
  await expect
    .poll(() => page.evaluate(() => {
      const images = (window as any).canvcode.view.images
      return images.stats.produced > 0 && images.idle
    }), { timeout: 20_000 })
    .toBe(true)
}

// 画面の 1 画素の色（[r, g, b]）。ポインタを外へ動かして、ホバーの枠を消してから測る
async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  const rect = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  await page.mouse.move(5, 5)
  const png = await page.screenshot({ clip: { x: rect.x + x, y: rect.y + y, width: 1, height: 1 } })
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

const near = (a: number[], b: number[], tolerance = 4) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance)

test('a table card fits its rows and draws only the visible tiles, with the header and stripes', async ({ page }) => {
  await openApp(page)
  const bounds = () => page.evaluate(() => (window as any).canvcode.editor.index.get('node:table')?.worldBounds)
  // 高さは全部の行に合わせる
  await expect.poll(async () => (await bounds())?.h, { timeout: 15_000 }).toBe(36 + (ROWS + 1) * 28)
  await setCamera(page, 0, 0, 1)
  await waitForImages(page)
  // 見出し（1 行目）・白い行（2 行目）・縞の行（3 行目）。セルの左の余白（文字のないところ）の色
  await expect.poll(() => pixel(page, 104, 100 + 36 + 14).then((c) => near(c, [0xee, 0xf1, 0xf5]))).toBe(true)
  await expect.poll(() => pixel(page, 104, 100 + 36 + 28 + 14).then((c) => near(c, [0xff, 0xff, 0xff]))).toBe(true)
  await expect.poll(() => pixel(page, 104, 100 + 36 + 56 + 14).then((c) => near(c, [0xf7, 0xf8, 0xfa]))).toBe(true)
  expect((await tableTiles(page))['#table:0,0']).toEqual([1])

  // 表の真ん中あたりへ移る：見えているタイルは頼んだ解像度で作り、表の下の端のタイルは作らない
  const card = (await bounds())!
  // （カメラを止めてから作り始めるまで少し待つので、作り終えたことは、そのタイルができるまで待って確かめる）
  await setCamera(page, 0, card.y + card.h / 2, 1)
  const topRow = Math.floor((card.h / 2 - 36) / 512)
  await expect.poll(async () => (await tableTiles(page))[`#table:0,${topRow + 1}`], { timeout: 20_000 }).toEqual([1])
  await waitForImages(page)
  expect((await tableTiles(page))[`#table:0,${Math.floor(((ROWS + 1) * 28 - 1) / 512)}`]).toBeUndefined()
})

test('dropping a Shift_JIS CSV saves it as a UTF-8 table file and places a table card', async ({ page }) => {
  let posted: { kind?: string; title?: string; content?: string } | null = null
  await openApp(page)
  await page.route('**/api/files', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    posted = route.request().postDataJSON()
    const content = posted!.content ?? ''
    await route.fulfill({ json: { file: { id: 'file:dropped', kind: 'table', title: posted!.title, path: `${posted!.title}.csv`, size: content.length, mtime: 0, hash: 'dropped', missing: false } } })
  })
  const rect = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  // 「月,売上\n1,120\n」の Shift_JIS
  const bytes = [140, 142, 44, 148, 132, 143, 227, 10, 49, 44, 49, 50, 48, 10]
  await page.evaluate(
    ({ bytes, x, y }) => {
      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(new File([new Uint8Array(bytes)], '売上.csv', { type: 'text/csv' }))
      const target = document.querySelector('.canvas-container > div[tabindex]')!
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer }))
    },
    { bytes, x: rect.x + 700, y: rect.y + 300 },
  )
  await expect.poll(() => posted).toEqual({ kind: 'table', title: '売上', content: '月,売上\n1,120\n' })
  await expect
    .poll(() => page.evaluate(() => {
      const records: any[] = [...(window as any).canvcode.editor.workspace.store.values()]
      const node = records.find((r) => r.typeName === 'node' && r.props.fileId === 'file:dropped')
      return node ? { type: node.type, w: node.props.w, h: node.props.h, sizing: node.props.sizing, header: node.props.header } : null
    }))
    // 幅は表に合わせ（狭い表は最小の 200）、高さは帯 36 + 2 行 × 28
    .toEqual({ type: 'table-card', w: 200, h: 92, sizing: 'auto', header: true })
})
