import { expect, test, type Page } from '@playwright/test'

// スライドにテンプレートを置く（スライド v2）：パイメニューの ツール › 図形 ›「スライド 16:9」で置いたスライド（子が無い）を選んだまま、
// 操作 › テンプレート ›「表」で表のテンプレート（3 行）が入り、続けて操作 ›「行を足す」で 4 行になること

const CANVAS_ID = 'canvas:slide-template-menu-test'

async function openApp(page: Page) {
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: 'テンプレート', parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records: [canvas] } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [] } }))
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
}

// キーを押したまま、パイメニューの項目を順に選ぶ（名前は完全に一致するもの。「表」と「表紙」を取り違えない）
async function choose(page: Page, key: string, labels: string[]) {
  await page.keyboard.down(key)
  for (const label of labels) {
    await page.locator('.pie-item').filter({ hasText: new RegExp(`^${label}›?$`) }).click({ force: true })
  }
  await page.keyboard.up(key)
}

// キャンバスのスライド（1 枚だけのはず）の中の slide-layout の種類と行の数
async function slideState(page: Page) {
  return page.evaluate((canvasId) => {
    type Node = { id: string; type: string; props: Record<string, unknown> }
    type Api = { editor: { index: { childrenOf(id: string): string[] }; getNode(id: string): Node | undefined } }
    const { editor } = (window as unknown as { canvcode: Api }).canvcode
    const nodes = (parentId: string) => editor.index.childrenOf(parentId).map((id) => editor.getNode(id)!)
    const slides = nodes(canvasId).filter((n) => n.type === 'slide')
    if (slides.length !== 1) return null
    const layouts = nodes(slides[0].id).filter((n) => n.type === 'slide-layout')
    return layouts.map((n) => ({ layout: n.props.layout, rows: (n.props.slots as { rows: unknown[] }).rows.length }))
  }, CANVAS_ID)
}

test('applies the table template to a placed slide from the actions pie menu and adds a row', async ({ page }) => {
  await openApp(page)
  const rect = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
  // 置いたスライドは選ばれたまま。子が無いので、操作に「テンプレート ›」が出る
  await choose(page, 'a', ['図形', 'スライド 16:9'])
  expect(await slideState(page)).toEqual([])

  await choose(page, 'o', ['テンプレート', '表'])
  expect(await slideState(page)).toEqual([{ layout: 'table', rows: 3 }])

  // 中身ができたので「テンプレート ›」は出ず、「行を足す」が出る
  await page.keyboard.down('o')
  await expect(page.locator('.pie-item').filter({ hasText: /^比率を切り替え$/ })).toBeVisible()
  await expect(page.locator('.pie-item').filter({ hasText: /^テンプレート›$/ })).toHaveCount(0)
  await page.locator('.pie-item').filter({ hasText: /^行を足す$/ }).click({ force: true })
  await page.keyboard.up('o')
  expect(await slideState(page)).toEqual([{ layout: 'table', rows: 4 }])
})
