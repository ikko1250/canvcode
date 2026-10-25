import { expect, test, type BrowserContext, type Page } from '@playwright/test'

// Canvas に URL だけを貼り付けると、リンクのカードになる。Ctrl（⌘）+クリックで開け、上にポインタを置くと札が出る。
// タイトル・説明・サムネイルは、サーバー（/api/link-preview）が取ってきたものを、あとから書き込む。
// 本物の画面を使い、サーバーの応答だけを差し替える（markdown-link.spec.ts と同じ）

const PAGE_URL = 'https://example.com/article'
const IMAGE_URL = 'https://example.com/og.png'
// 200×100 の PNG（左が赤、右が青。サムネイルの最小の大きさ 100×60 を超えるもの）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAMgAAABkCAIAAABM5OhcAAABJUlEQVR42u3SMQ0AAAzDsPInvVHovh2WgiByJlGZB4c8AAsssMACCyyBBRZYYIEFlsACCyywwAJLYIEFFlhggSWwwAILLLDAElhggQUWWGAJLLDAAgsssAQWWGCBBRZYAgsssMACCyyBBRZYYIEFlsACCyywwAJLYIEFFlhggSWwwAILLLDAElhggQUWWGDJA7DAAgsssMASWGCBBRZYYAkssMACCyywBBZYYIEFFlgCCyywwAILLIEFFlhggQWWwAILLLDAAktggQUWWGCBJbDAAgsssMASWGCBBRZYYAkssMACCyywBBZYYIEFFlgCCyywwAILLIEFFlhggQWWDAALLLDAAgssgQUWWGCBBZbAAgsssMACS2CBBRZYYIElsMAC63cL/ofWZIxYFTgAAAAASUVORK5CYII=', 'base64')

async function setup(page: Page, context: BrowserContext, preview: { title: string | null; image: string | null } | 'fail') {
  await page.goto('/canvas-input-test.html?kind=markdown&sizing=auto&long=0')
  await page.waitForFunction(() => Boolean((window as any).canvasInputFixture))
  const records = await page.evaluate(() => [...(window as any).canvasInputFixture.editor.workspace.store.values()])
  const text = 'カード'
  const file = { id: 'file:input-test', kind: 'markdown', title: 'Card', path: 'test.md', size: text.length, mtime: 0, hash: 'test', missing: false }
  await context.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: 'canvas:input-test', rev: 0, records } }))
  await context.route('**/api/files', (route) => route.fulfill({ json: { files: [file] } }))
  await context.route('**/api/files/file%3Ainput-test/content', (route) => route.fulfill({ body: text, headers: { etag: '"test"' } }))
  await context.route('**/api/assets**', (route) => route.fulfill({ json: { assets: [] } }))
  const requested: string[] = []
  await context.route('**/api/link-preview?**', (route) => {
    requested.push(new URL(route.request().url()).searchParams.get('url')!)
    if (preview === 'fail') return route.fulfill({ status: 502, json: { error: 'down' } })
    return route.fulfill({ json: { title: preview.title, description: 'その記事の説明', siteName: 'Example', image: preview.image } })
  })
  await context.route('**/api/link-preview/image?**', (route) => route.fulfill({ body: PNG, contentType: 'image/png' }))
  // 外のページへは出ないようにする（開いたタブの URL だけを見る）
  await context.route('https://example.com/**', (route) => route.fulfill({ body: 'example' }))
  await page.goto('/')
  const root = page.locator('.canvas-container > div[tabindex]')
  await expect(root).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).canvcode.editor.index.allIds().length), { timeout: 15_000 }).toBeGreaterThan(0)
  // 前からあるカードを画面の外へやって、何もないところに貼る
  await page.evaluate(() => (window as any).canvcode.view.setCamera({ x: 100_000, y: 100_000, zoom: 1 }))
  return { root, requested }
}

async function paste(page: Page, text: string): Promise<void> {
  await page.locator('.canvas-container > div[tabindex]').evaluate((el, text) => {
    // Firefox は、作った paste イベントの中では DataTransfer の中身を読ませないので、同じ形の物を持たせる
    const data = { types: ['text/plain'], files: [], items: [], getData: (type: string) => (type === 'text/plain' ? text : '') }
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: data })
    el.dispatchEvent(event)
  }, text)
}

function selectedNode(page: Page) {
  return page.evaluate(() => {
    const editor = (window as any).canvcode.editor
    const [id] = [...editor.session.get().selectedIds]
    const node = id ? editor.getNode(id) : null
    return node ? { id, type: node.type, props: node.props, bounds: editor.index.get(id).worldBounds } : null
  })
}

// ワールド座標を、ページの座標に
async function toPage(page: Page, world: { x: number; y: number }) {
  const rect = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  const camera = await page.evaluate(() => (window as any).canvcode.editor.session.get().camera)
  return { x: rect.x + (world.x - camera.x) * camera.zoom, y: rect.y + (world.y - camera.y) * camera.zoom }
}

test('pasting a URL makes a link card that fills in the page title and thumbnail', async ({ page, context }) => {
  const { requested } = await setup(page, context, { title: '記事のタイトル', image: IMAGE_URL })
  await paste(page, `  ${PAGE_URL}\n`)
  await expect.poll(async () => (await selectedNode(page))?.props.status).toBe('done')
  const node = (await selectedNode(page))!
  expect(node.type).toBe('link-card')
  expect(node.props).toMatchObject({ url: PAGE_URL, title: '記事のタイトル', description: 'その記事の説明', siteName: 'Example' })
  expect(node.props.image).toMatchObject({ aspect: 0.5 })
  expect(requested).toEqual([PAGE_URL])
  // Undo で消え、Redo でタイトルの入ったまま戻る（取り直さない）
  await page.keyboard.press('Control+z')
  await expect.poll(() => page.evaluate((id) => Boolean((window as any).canvcode.editor.getNode(id)), node.id)).toBe(false)
  await page.keyboard.press('Control+Shift+z')
  await expect.poll(() => page.evaluate((id) => (window as any).canvcode.editor.getNode(id)?.props.title, node.id)).toBe('記事のタイトル')
  expect(requested).toHaveLength(1)
})

test('a pasted link card shows where it goes, and opens with Ctrl+click', async ({ page, context }) => {
  const { root } = await setup(page, context, 'fail')
  await paste(page, PAGE_URL)
  // 取れなくても、URL だけのカードとして残る
  await expect.poll(async () => (await selectedNode(page))?.props.status).toBe('failed')
  const node = (await selectedNode(page))!
  expect(node.props).toMatchObject({ url: PAGE_URL, title: null, image: null })
  const point = await toPage(page, { x: node.bounds.x + node.bounds.w / 2, y: node.bounds.y + node.bounds.h / 2 })
  // 選んでいると札を出さないので、外す
  await page.evaluate(() => (window as any).canvcode.editor.setSelection([]))
  const hint = page.getByTestId('canvas-link-hint')
  await page.mouse.move(point.x, point.y)
  await expect(hint).toBeVisible()
  await expect(hint).toContainText(PAGE_URL)
  await expect(hint).toContainText('+クリックで開く')
  await page.keyboard.down('Control')
  await expect.poll(() => root.evaluate((el) => el.style.cursor)).toBe('pointer')
  const opened = context.waitForEvent('page')
  await page.mouse.click(point.x, point.y)
  await page.keyboard.up('Control')
  const tab = await opened
  await expect.poll(() => tab.url()).toBe(PAGE_URL)
  await tab.close()
})

test('text that is not just a URL is still pasted as a text node', async ({ page, context }) => {
  const { requested } = await setup(page, context, 'fail')
  await paste(page, `これを読む ${PAGE_URL}`)
  await expect.poll(async () => (await selectedNode(page))?.type).toBe('text')
  await paste(page, 'javascript:alert(1)')
  await expect.poll(async () => (await selectedNode(page))?.type).toBe('text')
  expect(requested).toEqual([])
})

// 何も書いていない、595×842 のページが 2 つの PDF
function blankPdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
  ]
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

test('right-click → PDF ポータルを作成 downloads the PDF of a link card and puts its portal beside the card', async ({ page, context }) => {
  const PDF_URL = 'https://example.com/docs/dgc3.0.pdf'
  await setup(page, context, { title: null, image: null })
  const downloads: string[] = []
  await context.route('**/api/link-preview/pdf?**', (route) => {
    downloads.push(new URL(route.request().url()).searchParams.get('url')!)
    return route.fulfill({ body: blankPdf(), contentType: 'application/pdf', headers: { 'x-canvcode-filename': encodeURIComponent('dgc3.0') } })
  })
  const uploads: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/assets') uploads.push(request.headers()['content-type'])
  })
  const menuItem = page.locator('.context-menu button', { hasText: 'PDF ポータルを作成' })

  // PDF でない URL のカードには、項目を出さない
  await paste(page, PAGE_URL)
  await expect.poll(async () => (await selectedNode(page))?.props.status).toBe('done')
  const pageCard = (await selectedNode(page))!
  let at = await toPage(page, { x: pageCard.bounds.x + 20, y: pageCard.bounds.y + 20 })
  await page.mouse.click(at.x, at.y, { button: 'right' })
  await expect(page.locator('.context-menu')).toBeVisible()
  await expect(menuItem).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.locator('.context-menu')).toBeHidden()
  await page.evaluate(() => (window as any).canvcode.view.setCamera({ x: 100_000, y: 101_000, zoom: 1 }))

  await paste(page, PDF_URL)
  await expect.poll(async () => (await selectedNode(page))?.props.status).toBe('done')
  const card = (await selectedNode(page))!
  expect(card.props.url).toBe(PDF_URL)
  at = await toPage(page, { x: card.bounds.x + 20, y: card.bounds.y + 20 })
  await page.mouse.click(at.x, at.y, { button: 'right' })
  await menuItem.click()
  // 取り込んだ Portal を選ぶ
  await expect.poll(async () => (await selectedNode(page))?.type, { timeout: 15_000 }).toBe('portal')
  expect(downloads).toEqual([PDF_URL])
  const portal = (await selectedNode(page))!
  // カードの右隣（縦はカードと重なる位置）に置く
  expect(portal.bounds.x).toBeGreaterThan(card.bounds.x + card.bounds.w)
  expect(portal.bounds.y).toBeLessThan(card.bounds.y + card.bounds.h)
  expect(portal.bounds.y + portal.bounds.h).toBeGreaterThan(card.bounds.y)
  // ページの Canvas に 2 ページを並べ、名前はファイルの名前（カードにタイトルが無いので）
  const target = await page.evaluate((targetId) => {
    const workspace = (window as any).canvcode.editor.workspace
    const records = [...workspace.store.values()]
    return {
      title: workspace.getCanvas(targetId)?.title,
      pages: records.filter((r: any) => r.typeName === 'node' && r.type === 'pdf-page' && r.parentId === targetId).length,
      pageCount: records.find((r: any) => r.typeName === 'file' && r.kind === 'pdf' && r.pagesCanvasId === targetId)?.pageCount,
    }
  }, portal.props.targetId)
  expect(target).toEqual({ title: 'dgc3.0', pages: 2, pageCount: 2 })
  // ドロップしたときと同じく、PDF をアップロードする
  await expect.poll(() => uploads).toEqual(['application/pdf'])
  // 1 回の Undo で Portal がなくなり、カードは残る
  await page.keyboard.press('Control+z')
  await expect.poll(() => page.evaluate((id) => Boolean((window as any).canvcode.editor.getNode(id)), portal.id)).toBe(false)
  expect(await page.evaluate((id) => Boolean((window as any).canvcode.editor.getNode(id)), card.id)).toBe(true)
})

