import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { PDFDocument } from 'pdf-lib'

// スライドを PDF に出力する（スライド v2）：パイメニューの 操作 ›「スライドを PDF に出力」で、表示するスライドが
// 1 枚 1 ページ（16:9 は 960×540pt）の PDF になり、キャンバスの名前のファイルでダウンロードされること。非表示のスライドは入らない

const CANVAS_ID = 'canvas:slide-pdf-test'

function slide(id: string, x: number, y: number, index: string, props: object = {}) {
  return {
    typeName: 'node', id, type: 'slide', parentId: CANVAS_ID, x, y, rotation: 0, index, opacity: 1, locked: false, version: 1,
    props: { ratio: '16:9', name: '', hidden: false, ...props }, meta: {},
  }
}

async function openApp(page: Page) {
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: '発表 2026', parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  const records = [
    canvas,
    // 置いた順（index）ではなく位置で順番が決まる：左の node:first が 1 枚目、右の node:second が 2 枚目
    slide('node:second', 2200, 0, 'a1'),
    slide('node:first', 0, 0, 'a2', { name: '表紙' }),
    // 非表示のスライドは PDF に入らない
    slide('node:hidden', 4400, 0, 'a3', { hidden: true }),
    // 1 枚目のスライドの中の図形
    {
      typeName: 'node', id: 'node:rect', type: 'geo', parentId: 'node:first', x: 200, y: 200, rotation: 0, index: 'a1', opacity: 1, locked: false, version: 3,
      props: { shape: 'rect', w: 600, h: 300, fill: { type: 'solid', color: '#e03131', opacity: 1 }, stroke: null, strokeWidth: 0, label: '' }, meta: {},
    },
  ]
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [] } }))
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
}

test('exports the shown slides to a PDF from the actions pie menu', async ({ page }) => {
  await openApp(page)
  const rect = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
  const download = page.waitForEvent('download')
  await page.keyboard.down('o')
  await page.locator('.pie-item', { hasText: 'スライドを PDF に出力' }).click({ force: true })
  await page.keyboard.up('o')
  const file = await download
  expect(file.suggestedFilename()).toBe('発表 2026.pdf')
  await expect(page.getByText('発表 2026.pdf を出力しました')).toBeVisible()

  const pdf = await PDFDocument.load(await readFile(await file.path()))
  expect(pdf.getTitle()).toBe('発表 2026')
  expect(pdf.getPageCount()).toBe(2)
  expect(pdf.getPages().map((p) => p.getSize())).toEqual([
    { width: 960, height: 540 },
    { width: 960, height: 540 },
  ])
})
