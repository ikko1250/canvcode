import { expect, test, type Page } from '@playwright/test'
import { searchPages } from '../../packages/core/src/pdfSearch.ts'

// PDF の単語検索（Ctrl+F。試作）：一致するページと件数はサーバー（/api/assets/<ハッシュ>/search。ここでは差し替え）が数え、
// 画面は一致したページの文字の位置を PDF.js で読んで、上から順に移る。PDF の中の文字の順番が、見た目の順と違っても
// （スライドを PDF にしたものなど）、ページの上から順に移ることを、カメラの位置で確かめる

const CANVAS_ID = 'canvas:pdf-search-test'
const FILE_ID = 'file:pdf-search-test'
const HASH = 'c'.repeat(64)
const ASSET_ID = `asset:${HASH}`
const PAGE = { width: 612, height: 792 }
// PDF のポイント → ワールド座標（PDF_POINT_SCALE）と、ページの間隔（PDF_PAGE_GAP）
const SCALE = 96 / 72
const GAP = 40

// ページごとの文字。y は PDF の座標（下が 0）で、書く順。1 ページ目は、下・上・中の順に書く
const PAGES: { text: string; y: number }[][] = [
  [
    { text: 'apple three', y: 100 },
    { text: 'apple one', y: 700 },
    { text: 'apple two', y: 400 },
  ],
  [{ text: 'apple four', y: 700 }],
  [{ text: 'banana', y: 700 }],
]

// Helvetica（埋め込まない標準フォント）で文字を書いた PDF
function textPdf(): Buffer {
  const pageObjects = PAGES.map((_, i) => 4 + i * 2)
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageObjects.map((n) => `${n} 0 R`).join(' ')}] /Count ${PAGES.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  for (const [i, lines] of PAGES.entries()) {
    const content = lines.map((line) => `BT /F1 24 Tf 72 ${line.y} Td (${line.text}) Tj ET`).join('\n')
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`)
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  }
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((body, i) => {
    const offset = pdf.length
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
    return offset
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

const PDF = textPdf()
const pageTop = (pageIndex: number) => pageIndex * (PAGE.height * SCALE + GAP)
// 文字の行の中ほどの、ワールド座標の y
const lineY = (pageIndex: number, y: number) => pageTop(pageIndex) + (PAGE.height - y - 8) * SCALE

async function openApp(page: Page, searches: string[]) {
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: 'PDF search', parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  const file = {
    typeName: 'file', id: FILE_ID, kind: 'pdf', title: 'search.pdf', path: '', size: PDF.length, mtime: 0, hash: HASH, missing: false,
    assetId: ASSET_ID, pagesCanvasId: CANVAS_ID, pageCount: PAGES.length, parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  const pages = PAGES.map((_, pageIndex) => ({
    typeName: 'node', id: `node:page${pageIndex}`, type: 'pdf-page', parentId: CANVAS_ID, x: 0, y: pageTop(pageIndex), rotation: 0,
    index: `a${pageIndex}`, opacity: 1, locked: true, version: 1,
    props: { assetId: ASSET_ID, fileId: FILE_ID, pageIndex, w: PAGE.width * SCALE, h: PAGE.height * SCALE }, meta: {},
  }))
  // サーバーが pages.json から取り出すテキスト（行ごと。書いた順のまま）
  const texts = PAGES.map((lines) => lines.map((line) => `${line.text}\n`).join(''))
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records: [canvas, file, ...pages] } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [] } }))
  await page.route('**/api/assets**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/assets') {
      return route.fulfill({ json: { assets: [{ mime: 'application/pdf', size: PDF.length, hash: HASH, width: 0, height: 0, variants: [] }] } })
    }
    if (url.pathname === `/api/assets/${HASH}/search`) {
      const query = url.searchParams.get('q') ?? ''
      searches.push(query)
      const found = searchPages(texts, query)
      return route.fulfill({ json: { status: 'ok', total: found.reduce((sum, p) => sum + p.count, 0), pages: found } })
    }
    return route.fulfill({ body: PDF, contentType: 'application/pdf' })
  })
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
}

// 画面の中央の、ワールド座標の y
function centerY(page: Page): Promise<number> {
  return page.evaluate(() => {
    const { editor, view } = (window as unknown as { canvcode: { editor: { session: { get(): { camera: { y: number; zoom: number } } } }; view: { root: HTMLElement } } }).canvcode
    const { camera } = editor.session.get()
    return camera.y + view.root.clientHeight / 2 / camera.zoom
  })
}

test('finds words in PDF pages, and moves through the matches from the top of each page', async ({ page }) => {
  const searches: string[] = []
  await openApp(page, searches)
  await page.locator('.canvas-container > div[tabindex]').focus()
  await page.keyboard.press('ControlOrMeta+f')
  const input = page.locator('.pdf-search input')
  await expect(input).toBeFocused()
  // 全角でも、大文字でも見つかる
  await input.fill('ＡＰＰＬＥ')
  const count = page.locator('.pdf-search-count')
  await expect(count).toHaveText('4 件')
  expect(searches).toEqual(['ＡＰＰＬＥ'])

  // 1 ページ目の上・中・下、2 ページ目の順
  const expected = [lineY(0, 700), lineY(0, 400), lineY(0, 100), lineY(1, 700)]
  for (const [i, y] of expected.entries()) {
    await input.press('Enter')
    await expect(count).toHaveText(`${i + 1} / 4`)
    await expect.poll(() => centerY(page)).toBeCloseTo(y, -1)
  }
  // 最後の次は最初に戻り、Shift+Enter で前へ（最初の前は最後）
  await input.press('Enter')
  await expect(count).toHaveText('1 / 4')
  await input.press('Shift+Enter')
  await expect(count).toHaveText('4 / 4')
  await expect.poll(() => centerY(page)).toBeCloseTo(expected[3], -1)

  await input.fill('cherry')
  await expect(count).toHaveText('見つかりません')
  await input.press('Escape')
  await expect(page.locator('.pdf-search')).toHaveCount(0)
})

test('leaves Ctrl+F to the browser on a canvas without PDF pages', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear())
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: 'Empty', parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  await page.route('**/api/records', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records: [canvas] } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [] } }))
  await page.route('**/api/assets', (route) => route.fulfill({ json: { assets: [] } }))
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
  await page.locator('.canvas-container > div[tabindex]').focus()
  const prevented = await page.evaluate(() => {
    const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true })
    document.activeElement!.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(prevented).toBe(false)
  await expect(page.locator('.pdf-search')).toHaveCount(0)
})
