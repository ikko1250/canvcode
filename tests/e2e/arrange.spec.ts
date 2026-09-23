import { expect, test, type Page } from '@playwright/test'

// 間隔のハンドル（MAI-54）：実際の CanvasView で、ピンクの棒をドラッグしてすべての隙間が同じ間隔に変わること、
// Ctrl+Z で戻ることを確かめる。付箋は fixture の editor で置く（「詰める」はパレットの代わりに editor.spaceSelection で行う）

const NOTE_W = 220
const NOTE_Y = 350

async function openWithNotes(page: Page, xs: number[]): Promise<string[]> {
  await page.goto('/canvas-input-test.html?kind=code&sizing=fixed&long=0')
  await page.waitForFunction(() => Boolean((window as any).canvasInputFixture))
  return page.evaluate(
    ({ xs, y }) => {
      const { editor, view } = (window as any).canvasInputFixture
      view.setCamera({ x: 0, y: 0, zoom: 1 })
      const notes = xs.map((x: number) => editor.makeNode('note', { x, y, props: { text: 'メモ' } }))
      editor.createNodes(notes)
      const ids = notes.map((n: { id: string }) => n.id)
      editor.setSelection(ids)
      return ids
    },
    { xs, y: NOTE_Y },
  )
}

async function xsOf(page: Page, ids: string[]): Promise<number[]> {
  return page.evaluate((ids) => {
    const { editor } = (window as any).canvasInputFixture
    return ids.map((id: string) => editor.index.get(id).worldBounds.x)
  }, ids)
}

test('dragging the second spacing bar changes every gap, and undo restores the layout', async ({ page }) => {
  // 間隔がそろっていない 3 枚（50 と 100）。棒は出ない
  const ids = await openWithNotes(page, [50, 320, 640])
  expect(await page.evaluate(() => (window as any).canvasInputFixture.editor.spacingHandlesWorld().length)).toBe(0)

  // 「詰める」：横 30 で並べる → 50, 300, 550。横の棒が 2 本出る
  await page.evaluate(() => (window as any).canvasInputFixture.editor.spaceSelection('x', 30))
  expect(await xsOf(page, ids)).toEqual([50, 300, 550])
  const handles = await page.evaluate(() => (window as any).canvasInputFixture.editor.spacingHandlesWorld())
  expect(handles.map((h: { axis: string }) => h.axis)).toEqual(['x'])
  expect(handles[0].gaps.length).toBe(2)

  // 2 本目の棒（x = 550 - 15、付箋の重なりの範囲の真ん中）をつかんで右に 40 動かす → 間隔は 30 + 40 / 2 = 50
  const root = page.locator('#canvas > div[tabindex]')
  const rect = (await root.boundingBox())!
  const bar = { x: rect.x + 535, y: rect.y + NOTE_Y + 60 }
  await page.mouse.move(bar.x, bar.y)
  await expect.poll(() => root.evaluate((el) => getComputedStyle(el).cursor)).toBe('col-resize')
  await page.mouse.down()
  await page.mouse.move(bar.x + 40, bar.y, { steps: 8 })
  await expect.poll(async () => xsOf(page, ids)).toEqual([50, 50 + NOTE_W + 50, 50 + (NOTE_W + 50) * 2])
  expect(await page.evaluate(() => (window as any).canvasInputFixture.editor.session.get().spacingDrag)).toEqual({ axis: 'x', gap: 50 })
  await page.mouse.up()
  expect(await page.evaluate(() => (window as any).canvasInputFixture.editor.session.get().spacingDrag)).toBeNull()
  expect(await xsOf(page, ids)).toEqual([50, 320, 590])

  // 1 回の Undo で、ドラッグの前に戻る
  await page.keyboard.press('Control+z')
  await expect.poll(async () => xsOf(page, ids)).toEqual([50, 300, 550])
})

test('Escape during a spacing drag restores the start state', async ({ page }) => {
  const ids = await openWithNotes(page, [50, 300, 550])
  const root = page.locator('#canvas > div[tabindex]')
  const rect = (await root.boundingBox())!
  const bar = { x: rect.x + 285, y: rect.y + NOTE_Y + 60 }
  await page.mouse.move(bar.x, bar.y)
  await page.mouse.down()
  await page.mouse.move(bar.x + 30, bar.y, { steps: 6 })
  await expect.poll(async () => xsOf(page, ids)).toEqual([50, 330, 610])
  await page.keyboard.press('Escape')
  await expect.poll(async () => xsOf(page, ids)).toEqual([50, 300, 550])
  await page.mouse.up()
  expect(await xsOf(page, ids)).toEqual([50, 300, 550])
})
