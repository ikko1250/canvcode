import { expect, test, type BrowserContext, type Page } from '@playwright/test'

// Canvas に URL だけを貼り付けると、リンクのカードになる。Ctrl（⌘）+クリックで開け、上にポインタを置くと札が出る。
// タイトル・説明・サムネイルは、サーバー（/api/link-preview）が取ってきたものを、あとから書き込む。
// 本物の画面を使い、サーバーの応答だけを差し替える（markdown-link.spec.ts と同じ）

const PAGE_URL = 'https://example.com/article'
const IMAGE_URL = 'https://example.com/og.png'
// 2×1 の PNG（赤と青）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAADUlEQVR4nGP4zwAE/wEHAAH/4iOeWQAAAABJRU5ErkJggg==', 'base64')

async function setup(page: Page, context: BrowserContext, preview: { title: string | null; image: string | null } | 'fail') {
  await page.goto('/canvas-input-test.html?kind=markdown&sizing=auto&long=0')
  await page.waitForFunction(() => Boolean((window as any).canvasInputFixture))
  const records = await page.evaluate(() => [...(window as any).canvasInputFixture.editor.workspace.store.values()])
  const text = 'カード'
  const file = { id: 'file:input-test', kind: 'markdown', title: 'Card', path: 'test.md', size: text.length, mtime: 0, hash: 'test', missing: false }
  await context.route('**/api/records', (route) => route.fulfill({ json: { rootCanvasId: 'canvas:input-test', rev: 0, records } }))
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

