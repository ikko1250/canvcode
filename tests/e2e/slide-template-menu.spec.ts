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

// slide-layout の行（本文のセルの文字の並び）と、選んでいるノード
async function rowTexts(page: Page) {
  return page.evaluate((canvasId) => {
    type Node = { id: string; type: string; props: Record<string, unknown> }
    type Api = { editor: { index: { childrenOf(id: string): string[] }; getNode(id: string): Node | undefined } }
    const { editor } = (window as unknown as { canvcode: Api }).canvcode
    const nodes = (parentId: string) => editor.index.childrenOf(parentId).map((id) => editor.getNode(id)!)
    const slide = nodes(canvasId).find((n) => n.type === 'slide')!
    const layout = nodes(slide.id).find((n) => n.type === 'slide-layout')!
    const rows = (layout.props.slots as { rows: { body: string }[] }).rows
    return rows.map((row) => editor.getNode(row.body)!.props.label as string)
  }, CANVAS_ID)
}

test('moves a row of the table up and down with Alt+arrows and the actions pie menu, each undoable (MAI-104)', async ({ page }) => {
  await openApp(page)
  const rect = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
  await choose(page, 'a', ['図形', 'スライド 16:9'])
  await choose(page, 'o', ['テンプレート', '表'])
  // 行の本文に文字を入れ、1 行目の本文を選ぶ
  const bodies = await page.evaluate((canvasId) => {
    type Node = { id: string; type: string; props: Record<string, unknown> }
    type Api = {
      editor: {
        index: { childrenOf(id: string): string[] }
        getNode(id: string): Node | undefined
        transact(label: string, fn: (tx: { put(record: Node): void }) => void): void
        setSelection(ids: string[]): void
      }
    }
    const { editor } = (window as unknown as { canvcode: Api }).canvcode
    const nodes = (parentId: string) => editor.index.childrenOf(parentId).map((id) => editor.getNode(id)!)
    const slide = nodes(canvasId).find((n) => n.type === 'slide')!
    const layout = nodes(slide.id).find((n) => n.type === 'slide-layout')!
    const rows = (layout.props.slots as { rows: { body: string }[] }).rows
    editor.transact('texts', (tx) => rows.forEach((row, i) => tx.put({ ...editor.getNode(row.body)!, props: { ...editor.getNode(row.body)!.props, label: `R${i}` } })))
    editor.setSelection([rows[0].body])
    return rows.map((row) => row.body)
  }, CANVAS_ID)
  expect(await rowTexts(page)).toEqual(['R0', 'R1', 'R2'])
  const selected = () => page.evaluate(() => [...(window as any).canvcode.editor.session.get().selectedIds])

  // Alt+↓ で 1 行目を 2 行目へ。選択はそのまま（続けて動かせる）。端では動かず、セルも動かない
  await page.keyboard.press('Alt+ArrowDown')
  expect(await rowTexts(page)).toEqual(['R1', 'R0', 'R2'])
  expect(await selected()).toEqual([bodies[0]])
  await page.keyboard.press('Alt+ArrowDown')
  expect(await rowTexts(page)).toEqual(['R1', 'R2', 'R0'])
  await page.keyboard.press('Alt+ArrowDown')
  expect(await rowTexts(page)).toEqual(['R1', 'R2', 'R0'])
  await page.keyboard.press('Alt+ArrowUp')
  expect(await rowTexts(page)).toEqual(['R1', 'R0', 'R2'])

  // o メニューの「行を移動 ›」（上へ・下へ）。スライドの項目はまとめない
  await page.keyboard.down('o')
  await expect(page.locator('.pie-item').filter({ hasText: /^行を足す$/ })).toBeVisible()
  await page.locator('.pie-item').filter({ hasText: /^行を移動›$/ }).click({ force: true })
  await page.locator('.pie-item').filter({ hasText: /^上へ$/ }).click({ force: true })
  await page.keyboard.up('o')
  expect(await rowTexts(page)).toEqual(['R0', 'R1', 'R2'])
  await choose(page, 'o', ['行を移動', '下へ'])
  expect(await rowTexts(page)).toEqual(['R1', 'R0', 'R2'])

  // それぞれ Undo 1 回で戻る
  await page.keyboard.press('ControlOrMeta+z')
  expect(await rowTexts(page)).toEqual(['R0', 'R1', 'R2'])
  await page.keyboard.press('ControlOrMeta+z')
  expect(await rowTexts(page)).toEqual(['R1', 'R0', 'R2'])
})
