import { expect, test, type Page } from '@playwright/test'

// ファイルのカード（MAI-100）：今扱えない種類のファイル（docx・xlsx・zip など）を落とすと、原本を Asset として送り、
// 名前・種類・大きさのカードを置く。右クリックで開く・ダウンロードでき、docx は Markdown に、xlsx は表（CSV）に変換して、
// できた文書のカードを元のカードの右に置く（元のカードは残る）。pandoc がないサーバーでは、Markdown への変換を押すと理由を出す。
// 本物の画面を使い、サーバーの応答だけを差し替える（csv-table.spec.ts と同じ）

const CANVAS_ID = 'canvas:attachment-test'

interface Posted {
  uploads: { type: string; ext: string | undefined; size: number }[]
  converts: { assetId: string; name: string; to: string }[]
}

async function openApp(page: Page, options: { pandoc?: boolean } = {}): Promise<Posted> {
  const posted: Posted = { uploads: [], converts: [] }
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: 'ファイル', parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records: [canvas] } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [] } }))
  await page.route('**/api/assets', async (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { assets: [] } })
    const headers = route.request().headers()
    posted.uploads.push({ type: headers['content-type'], ext: headers['x-canvcode-file-ext'], size: route.request().postDataBuffer()?.length ?? 0 })
    await route.fulfill({ json: { hash: headers['x-canvcode-sha256'] } })
  })
  await page.route('**/api/convert', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        json: { markdown: ['docx'], table: ['xlsx'], pandoc: options.pandoc === false ? { available: false, reason: 'pandoc がありません（テスト）' } : { available: true } },
      })
    }
    const body = route.request().postDataJSON() as Posted['converts'][number]
    posted.converts.push(body)
    const title = body.name.replace(/\.[^.]+$/, '')
    const files =
      body.to === 'markdown'
        ? [{ id: 'file:md', kind: 'markdown', title, path: `${title}.md`, size: 10, mtime: 0, hash: 'md', missing: false }]
        : ['売上', 'メモ'].map((sheet, i) => ({ id: `file:csv${i}`, kind: 'table', title: `${title} - ${sheet}`, path: `${title} - ${sheet}.csv`, size: 10, mtime: 0, hash: `csv${i}`, missing: false }))
    await route.fulfill({ json: { files, warnings: [] } })
  })
  await page.route('**/api/files/file%3Amd/content', (route) => route.fulfill({ body: '# 見出し\n\n本文\n', headers: { etag: '"md"' } }))
  await page.route('**/api/files/file%3Acsv*/content', (route) => route.fulfill({ body: '月,売上\n1,120\n', headers: { etag: '"csv"' } }))
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
  await page.evaluate(() => (window as any).canvcode.view.setCamera({ x: 0, y: 0, zoom: 1 }))
  return posted
}

async function drop(page: Page, files: { name: string; type: string; text: string }[], at: { x: number; y: number }) {
  const rect = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  await page.evaluate(
    ({ files, x, y }) => {
      const dataTransfer = new DataTransfer()
      for (const file of files) dataTransfer.items.add(new File([file.text], file.name, { type: file.type }))
      const target = document.querySelector('.canvas-container > div[tabindex]')!
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer }))
    },
    { files, x: rect.x + at.x, y: rect.y + at.y },
  )
}

function nodes(page: Page) {
  return page.evaluate(() => {
    const editor = (window as any).canvcode.editor
    return [...editor.workspace.store.values()]
      .filter((r: any) => r.typeName === 'node' && r.parentId === editor.canvasId)
      .map((r: any) => ({ id: r.id, type: r.type, props: r.props, bounds: editor.index.get(r.id)?.worldBounds }))
  })
}

// そのノードだけを選んで、右クリックのメニューを出す（落とした直後は全部を選んでいて、整列の帯がカードに重なるので、先に選び直す）
async function rightClick(page: Page, id: string, world: { x: number; y: number }) {
  const rect = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  await page.evaluate((id) => (window as any).canvcode.editor.setSelection([id]), id)
  await page.mouse.click(rect.x + world.x, rect.y + world.y, { button: 'right' })
  await expect(page.locator('.context-menu')).toBeVisible()
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

test('dropping files of other kinds places file cards, and a docx can be turned into a Markdown copy beside it', async ({ page }) => {
  const posted = await openApp(page)
  await drop(page, [
    { name: '報告書.docx', type: DOCX, text: 'docx の中身' },
    { name: '資料.zip', type: 'application/zip', text: 'PK' },
  ], { x: 400, y: 300 })
  await expect.poll(async () => (await nodes(page)).map((n) => [n.type, n.props.name, n.props.size])).toEqual([
    ['attachment', '報告書.docx', 'docx の中身'.length + 6],
    ['attachment', '資料.zip', 2],
  ])
  // 原本は、元の拡張子を付けて送る
  await expect.poll(() => posted.uploads.map((u) => [u.type, u.ext])).toEqual([[DOCX, 'docx'], ['application/zip', 'zip']])

  const [docx] = await nodes(page)
  await rightClick(page, docx.id, { x: docx.bounds.x + 40, y: docx.bounds.y + 30 })
  await expect(page.locator('.context-menu button', { hasText: 'ダウンロード' })).toBeVisible()
  await expect(page.locator('.context-menu button', { hasText: '表（CSV）に変換' })).toHaveCount(0)
  await page.locator('.context-menu button', { hasText: 'Markdown に変換' }).click()
  await expect.poll(() => posted.converts).toEqual([{ assetId: docx.props.assetId, name: '報告書.docx', to: 'markdown' }])
  await expect.poll(async () => (await nodes(page)).find((n) => n.type === 'markdown-card')?.props.fileId).toBe('file:md')
  const all = await nodes(page)
  const card = all.find((n) => n.type === 'markdown-card')!
  // 元のカードの右に、上端を揃えて置く。元のカードは残る
  expect(card.bounds.x).toBeCloseTo(docx.bounds.x + docx.bounds.w + 40, 0)
  expect(card.bounds.y).toBeCloseTo(docx.bounds.y, 0)
  expect(all.filter((n) => n.type === 'attachment')).toHaveLength(2)
  await expect(page.getByText('報告書.md を作りました（元のファイルはそのままです）')).toBeVisible()
})

test('an xlsx becomes one table card per sheet, side by side', async ({ page }) => {
  const posted = await openApp(page)
  await drop(page, [{ name: '月次.xlsx', type: XLSX, text: 'xlsx' }], { x: 300, y: 300 })
  await expect.poll(async () => (await nodes(page)).length).toBe(1)
  const [xlsx] = await nodes(page)
  await rightClick(page, xlsx.id, { x: xlsx.bounds.x + 40, y: xlsx.bounds.y + 30 })
  await expect(page.locator('.context-menu button', { hasText: 'Markdown に変換' })).toHaveCount(0)
  await page.locator('.context-menu button', { hasText: '表（CSV）に変換' }).click()
  await expect.poll(() => posted.converts.map((c) => c.to)).toEqual(['table'])
  await expect.poll(async () => (await nodes(page)).filter((n) => n.type === 'table-card').map((n) => n.props.fileId)).toEqual(['file:csv0', 'file:csv1'])
  const [first, second] = (await nodes(page)).filter((n) => n.type === 'table-card')
  expect(first.bounds.x).toBeCloseTo(xlsx.bounds.x + xlsx.bounds.w + 40, 0)
  expect(second.bounds.x).toBeCloseTo(first.bounds.x + first.bounds.w + 40, 0)
  expect(second.bounds.y).toBeCloseTo(xlsx.bounds.y, 0)
})

test('without pandoc, the Markdown conversion tells why instead of converting', async ({ page }) => {
  const posted = await openApp(page, { pandoc: false })
  await drop(page, [{ name: '報告書.docx', type: DOCX, text: 'docx' }], { x: 300, y: 300 })
  await expect.poll(async () => (await nodes(page)).length).toBe(1)
  const [docx] = await nodes(page)
  // 1 回目の右クリックで、変換できる種類を聞き始める
  await rightClick(page, docx.id, { x: docx.bounds.x + 40, y: docx.bounds.y + 30 })
  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(() => (window as any).canvcode.files.conversions()?.pandoc.available)).toBe(false)
  await rightClick(page, docx.id, { x: docx.bounds.x + 40, y: docx.bounds.y + 30 })
  await page.locator('.context-menu button', { hasText: 'Markdown に変換（pandoc がありません）' }).click()
  await expect(page.getByText('pandoc がありません（テスト）')).toBeVisible()
  expect(posted.converts).toEqual([])
})
