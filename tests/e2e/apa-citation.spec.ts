import { expect, test, type Page } from '@playwright/test'

// APA の引用を置く（右クリックの「APA の引用を置く」。MAI-98）：リンクカードを右クリックして選ぶと、サーバー
// （/api/claude/cite。ここでは差し替え）にカードの URL・題・説明・サイト名を送り、待っている間はカードの右下に「作っています」を出す。
// 答えが来たら、カードの右下に引用のテキスト（誌名などは斜体、未確認・根拠の行つき）を置く。Undo 1 回で消える。
// × で頼むのをやめられる。Claude が使えない（/api/claude/threads が 404）ときは、メニューに出さない

const CANVAS_ID = 'canvas:cite-test'
const CARD = { x: 100, y: 100, w: 400 }
const LINK = { url: 'https://arxiv.org/abs/1706.03762', title: 'Attention Is All You Need', description: 'The dominant sequence transduction models…', siteName: 'arXiv.org' }

const ANSWER = {
  citation: [
    { text: 'Vaswani, A., & Polosukhin, I. (2017). ' },
    { text: 'Attention is all you need', italic: true },
    { text: ' [Preprint]. arXiv. [未確認：DOI/URL]' },
  ],
  text: 'Vaswani, A., & Polosukhin, I. (2017). Attention is all you need [Preprint]. arXiv. [未確認：DOI/URL]',
  type: 'preprint',
  unverified: [{ field: 'link', label: 'DOI/URL' }],
  evidence: [{ url: 'https://arxiv.org/abs/1706.03762', labels: ['著者', '年', '題'] }],
  model: 'claude-sonnet-5-5',
  costUsd: 0.03,
  durationMs: 13_000,
}

async function openApp(page: Page, options: { claude: boolean; requests?: unknown[]; answer?: Promise<void> }) {
  const canvas = { typeName: 'canvas', id: CANVAS_ID, title: 'Cite', parentCanvasId: null, ownerNodeId: null, createdAt: 0, updatedAt: 0, deletedAt: null, trash: null }
  const card = {
    typeName: 'node', id: 'node:card', type: 'link-card', parentId: CANVAS_ID, x: CARD.x, y: CARD.y, rotation: 0, index: 'a0', opacity: 1, locked: false,
    props: { ...LINK, image: null, icon: null, status: 'done', w: CARD.w }, meta: {},
  }
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records: [canvas, card] } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [] } }))
  await page.route('**/api/assets**', (route) => route.fulfill({ json: { assets: [] } }))
  await page.route('**/api/claude/threads', (route) => (options.claude ? route.fulfill({ json: { threads: [] } }) : route.fulfill({ status: 404, json: {} })))
  await page.route('**/api/claude/events', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/claude/cite', async (route) => {
    options.requests?.push(route.request().postDataJSON())
    await options.answer
    await route.fulfill({ json: ANSWER }).catch(() => {})
  })
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).canvcode.editor.index.allIds().length)).toBe(1)
  await page.evaluate(() => (window as any).canvcode.view.setCamera({ x: 0, y: 0, zoom: 1 }))
}

// カードの真ん中を右クリックする
async function rightClickCard(page: Page) {
  const rect = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  await page.mouse.click(rect.x + CARD.x + CARD.w / 2, rect.y + CARD.y + 30, { button: 'right' })
}

const texts = (page: Page) =>
  page.evaluate(() => {
    const editor = (window as any).canvcode.editor
    return editor.index
      .allIds()
      .map((id: string) => ({ node: editor.getNode(id), bounds: editor.index.get(id).worldBounds }))
      .filter(({ node }: { node: { type: string } }) => node.type === 'text')
      .map(({ node, bounds }: { node: { props: { paragraphs: unknown } }; bounds: unknown }) => ({ paragraphs: node.props.paragraphs, bounds }))
  })

test('places the APA citation of a link card at its bottom right, and undo removes it', async ({ page }) => {
  const requests: unknown[] = []
  let answer!: () => void
  await openApp(page, { claude: true, requests, answer: new Promise<void>((resolve) => (answer = resolve)) })
  await rightClickCard(page)
  await page.locator('.context-menu button', { hasText: 'APA の引用を置く' }).click()

  const pending = page.locator('.cite-pending')
  await expect(pending).toContainText('APA の引用を作っています')
  await expect.poll(() => requests).toEqual([{ kind: 'link', ...LINK }])
  // 待っている間の印は、カードの右下に出す
  const card = await page.evaluate(() => (window as any).canvcode.editor.index.get('node:card').worldBounds)
  const root = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  const box = (await pending.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(root.x + card.x + card.w)
  expect(box.y).toBeGreaterThanOrEqual(root.y + card.y + card.h)

  answer()
  await expect(pending).toHaveCount(0)
  const [text] = await texts(page)
  expect(text!.paragraphs).toEqual([
    { runs: [{ text: 'Vaswani, A., & Polosukhin, I. (2017). ' }, { text: 'Attention is all you need', format: { italic: true } }, { text: ' [Preprint]. arXiv. [未確認：DOI/URL]' }] },
    { runs: [{ text: '未確認：DOI/URL（Web で確かめられなかったので、推測で埋めていません）', format: { color: '#6b7280' } }] },
    { runs: [{ text: '根拠（著者・年・題）：https://arxiv.org/abs/1706.03762', format: { color: '#6b7280' } }] },
  ])
  expect(text!.bounds.x).toBeGreaterThan(card.x + card.w)
  expect(text!.bounds.y).toBeGreaterThan(card.y + card.h)

  await page.locator('.canvas-container > div[tabindex]').focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => texts(page)).toEqual([])
})

test('× stops making the citation and places nothing', async ({ page }) => {
  await openApp(page, { claude: true, answer: new Promise<void>(() => {}) })
  await rightClickCard(page)
  await page.locator('.context-menu button', { hasText: 'APA の引用を置く' }).click()
  await page.getByRole('button', { name: '引用を作るのをやめる' }).click()
  await expect(page.locator('.cite-pending')).toHaveCount(0)
  await expect(page.getByText('引用を作るのをやめました')).toBeVisible()
  expect(await texts(page)).toEqual([])
})

test('does not offer APA の引用を置く when Claude is not available', async ({ page }) => {
  await openApp(page, { claude: false })
  await rightClickCard(page)
  await expect(page.locator('.context-menu button', { hasText: '複製' })).toBeVisible()
  await expect(page.locator('.context-menu button', { hasText: 'APA の引用を置く' })).toHaveCount(0)
})

test('offers APA の引用を置く on a locked PDF page, and sends the PDF file', async ({ page }) => {
  const pagesCanvas = { typeName: 'canvas', id: 'canvas:cite-pages', title: 'paper', parentCanvasId: null, ownerNodeId: null, createdAt: 0, updatedAt: 0, deletedAt: null, trash: null }
  const file = {
    typeName: 'file', id: 'file:cite-pdf', kind: 'pdf', title: 'paper', path: '', size: 1, mtime: 0, hash: 'e'.repeat(64), missing: false,
    assetId: `asset:${'e'.repeat(64)}`, pagesCanvasId: pagesCanvas.id, pageCount: 1, parentCanvasId: null, ownerNodeId: null, createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  const pdfPage = {
    typeName: 'node', id: 'node:page0', type: 'pdf-page', parentId: pagesCanvas.id, x: 0, y: 0, rotation: 0, index: 'a0', opacity: 1, locked: true, version: 1,
    props: { assetId: file.assetId, fileId: file.id, pageIndex: 0, w: 400, h: 500 }, meta: {},
  }
  const requests: unknown[] = []
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: pagesCanvas.id, rev: 0, records: [pagesCanvas, file, pdfPage] } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [] } }))
  await page.route('**/api/assets**', (route) => route.fulfill({ json: { assets: [] } }))
  await page.route('**/api/claude/threads', (route) => route.fulfill({ json: { threads: [] } }))
  await page.route('**/api/claude/events', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/claude/cite', async (route) => {
    requests.push(route.request().postDataJSON())
    await route.fulfill({ json: ANSWER })
  })
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
  await page.evaluate(() => (window as any).canvcode.view.setCamera({ x: -50, y: -50, zoom: 1 }))
  const rect = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  await page.mouse.click(rect.x + 250, rect.y + 250, { button: 'right' })
  await page.locator('.context-menu button', { hasText: 'APA の引用を置く' }).click()
  await expect.poll(() => requests).toEqual([{ kind: 'pdf', fileId: file.id }])
  await expect.poll(async () => (await texts(page)).length).toBe(1)
  const [text] = await texts(page)
  expect(text!.bounds).toMatchObject({ x: 424, y: 524 })
})
