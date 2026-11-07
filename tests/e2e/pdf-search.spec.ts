import { expect, test, type Page } from '@playwright/test'
import { searchPages } from '../../packages/core/src/pdfSearch.ts'

// PDF の単語検索（Ctrl+F。試作）：一致するページと件数はサーバー（/api/assets/<ハッシュ>/search。ここでは差し替え）が数え、
// 画面は一致したページの文字の位置を PDF.js で読んで、上から順に移る。PDF の中の文字の順番が、見た目の順と違っても
// （スライドを PDF にしたものなど）、ページの上から順に移ることを、カメラの位置で確かめる。
// 英語の PDF で、行末のハイフンで切れた語が見つかり、語の間の空白は無視しないことも確かめる

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
  // 英語：行末のハイフンで切れた語（manage- / ment）と、行をまたいだ 2 語（the / rapist）
  [
    { text: 'risk manage-', y: 700 },
    { text: 'ment of the', y: 670 },
    { text: 'rapist', y: 640 },
  ],
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
  await page.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records: [canvas, file, ...pages] } }))
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
  // 画面の下の中央に、今のページ（画面の中心があるページ）の PDF の中での番号と総ページ数が出る（MAI-92）
  const pageNumber = page.locator('.pdf-page-number')
  for (const [i, y] of expected.entries()) {
    await input.press('Enter')
    await expect(count).toHaveText(`${i + 1} / 4`)
    await expect.poll(() => centerY(page)).toBeCloseTo(y, -1)
    if (i === 0) await expect(pageNumber).toHaveText('p.1 / 3')
  }
  await expect(pageNumber).toHaveText('p.2 / 3')
  // 最後の次は最初に戻り、Shift+Enter で前へ（最初の前は最後）
  await input.press('Enter')
  await expect(count).toHaveText('1 / 4')
  await input.press('Shift+Enter')
  await expect(count).toHaveText('4 / 4')
  await expect.poll(() => centerY(page)).toBeCloseTo(expected[3], -1)

  await input.fill('cherry')
  await expect(count).toHaveText('見つかりません')

  // 行末のハイフンで切れた語は、つないで見つかる（画面も PDF.js の行の終わりで改行を入れ、サーバーと同じ 1 件を見つける）
  await input.fill('management')
  await expect(count).toHaveText('1 件')
  await input.press('Enter')
  await expect(count).toHaveText('1 / 1')
  await expect.poll(() => centerY(page)).toBeCloseTo((lineY(2, 700) + lineY(2, 670)) / 2, -1)
  // 英語の語の間の空白は無視しない
  await input.fill('therapist')
  await expect(count).toHaveText('見つかりません')
  await input.fill('the rapist')
  await expect(count).toHaveText('1 件')
  await input.press('Enter')
  await expect(count).toHaveText('1 / 1')

  await input.press('Escape')
  await expect(page.locator('.pdf-search')).toHaveCount(0)
})

// PDF の中での番号のページへ移る（MAI-92）：画面の下の「p.N / M」を押すか G で番号の欄になり、Enter で移る
const surface = (page: Page) => page.locator('.canvas-container > div[tabindex]')
const cameraOf = (page: Page) => page.evaluate(() => (window as any).canvcode.editor.session.get().camera as { x: number; y: number; zoom: number })
// 1 ページ目の左上を、倍率 1 で画面の左上に合わせる
const showFirstPage = (page: Page) => page.evaluate(() => (window as any).canvcode.view.setCamera({ x: 0, y: 0, zoom: 1 }))
// 移った先のカメラ（pageJumpTarget）：倍率はそのままに、ページを横は画面の中央に、縦は上下の余白（56px）と合わせて
// 画面に収まれば中央に、収まらなければ上端を画面の上から 56px に置く
async function expectAtPage(page: Page, pageIndex: number, zoom: number) {
  const { width, height } = await page.evaluate(() => (window as any).canvcode.view.size as { width: number; height: number })
  const w = PAGE.width * SCALE
  const h = PAGE.height * SCALE
  const y = h * zoom + 56 * 2 <= height ? pageTop(pageIndex) + h / 2 - height / 2 / zoom : pageTop(pageIndex) - 56 / zoom
  const camera = await cameraOf(page)
  expect(camera.zoom).toBe(zoom)
  expect(camera.x).toBeCloseTo(w / 2 - width / 2 / zoom, 6)
  expect(camera.y).toBeCloseTo(y, 6)
}

test('jumps to the page with the number typed into the label at the bottom (MAI-92)', async ({ page }) => {
  await openApp(page, [])
  await showFirstPage(page)
  const label = page.locator('.pdf-page-number')
  await expect(label).toHaveText('p.1 / 3')
  await expect(label).toHaveAttribute('title', 'ページの番号を入れて移る（G）')
  await label.click()
  const input = label.locator('input')
  await expect(input).toBeFocused()
  // 今の番号を選んだ状態で入る
  await expect(input).toHaveValue('1')
  expect(await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 1])
  await page.keyboard.type('3')
  await page.keyboard.press('Enter')
  await expect(input).toHaveCount(0)
  // 倍率 1 ではページが画面に収まらないので、ページの頭を上のバーの下に置く
  await expectAtPage(page, 2, 1)
  await expect(label).toHaveText('p.3 / 3')
  // キャンバスにフォーカスが戻る
  await expect(surface(page)).toBeFocused()

  // 全角の数字と、前後の空白。倍率はそのまま（0.5 ではページが収まるので、画面の中央に置く）
  await page.evaluate(() => (window as any).canvcode.view.setCamera({ x: 0, y: 0, zoom: 0.5 }))
  await page.keyboard.press('g')
  await input.fill('　２ ')
  await input.press('Enter')
  await expect(input).toHaveCount(0)
  await expectAtPage(page, 1, 0.5)
  await expect(label).toHaveText('p.2 / 3')
})

test('shows the typed number in the label after the jump, even zoomed out with every page in view (MAI-92)', async ({ page }) => {
  await openApp(page, [])
  // 3 ページがすべて見える倍率。ページの左上を画面の左上に合わせると、画面の中心は隣のページに入ってしまう
  await page.evaluate(() => (window as any).canvcode.view.setCamera({ x: 0, y: 0, zoom: 0.2 }))
  const label = page.locator('.pdf-page-number')
  const input = label.locator('input')
  await surface(page).focus()
  for (const [pageNumber, from] of [[1, 'p.2 / 3'], [3, 'p.1 / 3'], [2, 'p.3 / 3']] as const) {
    await expect(label).toHaveText(from)
    await page.keyboard.press('g')
    await input.fill(String(pageNumber))
    await input.press('Enter')
    await expect(input).toHaveCount(0)
    await expect(label).toHaveText(`p.${pageNumber} / 3`)
    await expectAtPage(page, pageNumber - 1, 0.2)
  }
})

test('warns about a page number it cannot go to, and closes without moving on Esc or leaving the box (MAI-92)', async ({ page }) => {
  await openApp(page, [])
  await showFirstPage(page)
  const input = page.locator('.pdf-page-number input')
  const error = page.locator('.pdf-page-number-error')
  await surface(page).focus()
  await page.keyboard.press('g')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('1')

  // 範囲の外・数でない値：移らずに注意を出し、欄は開いたまま
  for (const value of ['4', '0', 'abc']) {
    await input.fill(value)
    await input.press('Enter')
    await expect(error).toHaveText('1〜3 の番号を入れてください')
    await expect(input).toBeFocused()
  }
  // 打ち直すと注意は消える
  await input.fill('2')
  await expect(error).toHaveCount(0)
  // 消したページ
  await page.evaluate(() => (window as any).canvcode.editor.deleteNodes(['node:page1']))
  await input.press('Enter')
  await expect(error).toHaveText('2 ページは消されています')
  await expect(input).toBeFocused()
  expect(await cameraOf(page)).toEqual({ x: 0, y: 0, zoom: 1 })

  // Esc：移らずに閉じて、キャンバスにフォーカスを戻す
  await input.fill('3')
  await input.press('Escape')
  await expect(input).toHaveCount(0)
  await expect(surface(page)).toBeFocused()
  expect(await cameraOf(page)).toEqual({ x: 0, y: 0, zoom: 1 })

  // ほかを押して欄を離れても、移らずに閉じる（ページの右の、何もない所）
  await page.keyboard.press('g')
  await input.fill('3')
  await surface(page).click({ position: { x: 1000, y: 300 } })
  await expect(input).toHaveCount(0)
  expect(await cameraOf(page)).toEqual({ x: 0, y: 0, zoom: 1 })
  await expect(page.locator('.pdf-page-number')).toHaveText('p.1 / 3')
})

test('G is typed as a letter while editing a note or in the search box (MAI-92)', async ({ page }) => {
  await openApp(page, [])
  await showFirstPage(page)
  const input = page.locator('.pdf-page-number input')
  // 1 ページ目の上の付箋の文字を編集する
  await page.evaluate(() => {
    const editor = (window as any).canvcode.editor
    editor.createNodes([editor.makeNode('note', { x: 100, y: 300 })])
  })
  const box = (await surface(page).boundingBox())!
  await page.mouse.dblclick(box.x + 150, box.y + 350)
  const textEditor = page.locator('.canvcode-text-editor')
  await expect(textEditor).toBeFocused()
  await page.keyboard.press('g')
  await expect(textEditor).toContainText('g')
  await expect(input).toHaveCount(0)
  await page.keyboard.press('Escape')

  // PDF の単語検索の欄
  await surface(page).focus()
  await page.keyboard.press('ControlOrMeta+f')
  const search = page.locator('.pdf-search input')
  await expect(search).toBeFocused()
  await page.keyboard.press('g')
  await expect(search).toHaveValue('g')
  await expect(input).toHaveCount(0)
})

test('leaves Ctrl+F to the browser on a canvas without PDF pages', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear())
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: 'Empty', parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  await page.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records: [canvas] } }))
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
