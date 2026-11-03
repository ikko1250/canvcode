import { expect, test, type Page } from '@playwright/test'

// 付箋の右クリックの「箇条書きのメモにする」：サーバー（/api/claude/memo。ここでは差し替え）の項目で、付箋の文字が箇条書きに置き換わり、
// Undo 1 回で元に戻る。待っている間に付箋を書き換えたら、置き換えない

const SPOKEN = 'そりゃ受け手の方もAIを使うでしょ。えっと、送信側もAI使って喋るし、受信側もAI使って喋るし。'
const ITEMS = [
  { text: '受け手も AI を使う', level: 0 },
  { text: '送信側も AI で喋る', level: 1 },
  { text: '受信側も AI で喋る', level: 1 },
]

async function openApp(page: Page, memo: Parameters<Page['route']>[1]): Promise<string> {
  await page.goto('/canvas-input-test.html?kind=markdown&sizing=auto')
  await page.waitForFunction(() => Boolean((window as any).canvasInputFixture))
  const { records, noteId } = await page.evaluate((text) => {
    const fixture = (window as any).canvasInputFixture
    const noteId = fixture.startNote(500, 300, text)
    return { records: [...fixture.editor.workspace.store.values()], noteId }
  }, SPOKEN)
  const file = { id: 'file:input-test', kind: 'markdown', title: 'Input test', path: 'test.md', size: 100, mtime: 0, hash: 'test', missing: false }
  await page.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: 'canvas:input-test', rev: 0, records } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [file] } }))
  await page.route('**/api/files/file%3Ainput-test/content', (route) => route.fulfill({ body: '# Card', headers: { etag: '"test"' } }))
  await page.route('**/api/claude/threads', (route) => route.fulfill({ json: { threads: [] } }))
  await page.route('**/api/claude/events', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/claude/memo', memo)
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
  await expect.poll(() => page.evaluate((id) => Boolean((window as any).canvcode.editor.getNode(id)), noteId)).toBe(true)
  return noteId
}

// 付箋の真ん中を右クリックして、メニューの項目を押す
async function chooseFromNoteMenu(page: Page, noteId: string, label: string): Promise<void> {
  const root = page.locator('.canvas-container > div[tabindex]')
  const box = (await root.boundingBox())!
  const at = await page.evaluate((id) => {
    const editor = (window as any).canvcode.editor
    const bounds = editor.index.get(id).worldBounds
    const camera = editor.session.get().camera
    return { x: (bounds.x + bounds.w / 2 - camera.x) * camera.zoom, y: (bounds.y + bounds.h / 2 - camera.y) * camera.zoom }
  }, noteId)
  await page.mouse.click(box.x + at.x, box.y + at.y)
  await page.mouse.click(box.x + at.x, box.y + at.y, { button: 'right' })
  await page.locator('.context-menu button', { hasText: label }).click()
}

const paragraphsOf = (page: Page, id: string) => page.evaluate((id) => (window as any).canvcode.editor.getNode(id).props.paragraphs, id)

test('付箋の文字を箇条書きのメモに置き換え、Undo で戻す', async ({ page }) => {
  let sent: unknown
  const noteId = await openApp(page, async (route) => {
    sent = route.request().postDataJSON()
    await route.fulfill({ json: { items: ITEMS } })
  })
  await chooseFromNoteMenu(page, noteId, '箇条書きのメモにする')
  await expect.poll(() => paragraphsOf(page, noteId)).toEqual(ITEMS.map((item) => ({ runs: [{ text: item.text }], list: { type: 'bullet', level: item.level } })))
  expect(sent).toEqual({ text: SPOKEN })
  await page.keyboard.press('Control+z')
  await expect.poll(() => paragraphsOf(page, noteId)).toEqual([{ runs: [{ text: SPOKEN }] }])
})

test('待っている間に付箋を書き換えたら置き換えず、失敗はその理由を知らせる', async ({ page }) => {
  let answer: (() => void) | undefined
  const noteId = await openApp(page, async (route) => {
    await new Promise<void>((resolve) => (answer = resolve))
    await route.fulfill({ json: { items: ITEMS } })
  })
  await chooseFromNoteMenu(page, noteId, '箇条書きのメモにする')
  await expect.poll(() => Boolean(answer)).toBe(true)
  await page.evaluate((id) => {
    const editor = (window as any).canvcode.editor
    const node = editor.getNode(id)
    editor.transact('edit', (tx: any) => tx.put({ ...node, props: { ...node.props, paragraphs: [{ runs: [{ text: '書き換えた' }] }] } }))
  }, noteId)
  answer!()
  await expect(page.getByText('待っている間に付箋が変わったので、置き換えませんでした')).toBeVisible()
  expect(await paragraphsOf(page, noteId)).toEqual([{ runs: [{ text: '書き換えた' }] }])

  await page.unroute('**/api/claude/memo')
  await page.route('**/api/claude/memo', (route) => route.fulfill({ status: 504, json: { error: 'メモにするのに時間がかかりすぎたので、止めました' } }))
  await chooseFromNoteMenu(page, noteId, '箇条書きのメモにする')
  await expect(page.getByText('メモにできませんでした：メモにするのに時間がかかりすぎたので、止めました')).toBeVisible()
  expect(await paragraphsOf(page, noteId)).toEqual([{ runs: [{ text: '書き換えた' }] }])
})
