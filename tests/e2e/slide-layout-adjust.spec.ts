import { expect, test, type Page } from '@playwright/test'

// スライド（v2）の「配置」：デザインパネルで表の幅・高さ・位置を変える。表パネルをドラッグすると、離した位置に残る（並べ直しで戻らない）

const CANVAS_ID = 'canvas:slide-adjust-test'
const SLIDE_ID = 'node:slide'

type Box = { x: number; y: number; w: number; h: number }

async function openApp(page: Page) {
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: '配置', parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  const slide = {
    typeName: 'node', id: SLIDE_ID, type: 'slide', parentId: CANVAS_ID, x: 0, y: 0, rotation: 0, index: 'a0', opacity: 1, locked: false, version: 1,
    props: { ratio: '16:9', name: 'S1', hidden: false }, meta: {},
  }
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records: [canvas, slide] } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [] } }))
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
  await page.evaluate((slideId) => {
    const { editor } = (window as any).canvcode
    editor.applySlideTemplate(slideId, 'table-image')
    editor.session.set({ camera: { x: -40, y: -40, zoom: 0.5 } })
    editor.setSelection([slideId])
  }, SLIDE_ID)
}

// 表パネル・右図枠（slide-layout の slots）の箱と、slide-layout の adjust
async function state(page: Page): Promise<{ panel: Box; figure: Box; adjust: unknown }> {
  return page.evaluate((slideId) => {
    const { editor } = (window as any).canvcode
    const layout = editor.slideLayoutFor(slideId)
    const box = (id: string) => {
      const n = editor.getNode(id)
      return { x: n.x, y: n.y, w: n.props.w, h: n.props.h }
    }
    return { panel: box(layout.props.slots.panel), figure: box(layout.props.slots.figure), adjust: layout.props.adjust ?? {} }
  }, SLIDE_ID)
}

// 世界座標の点の画面上の位置
async function screenOf(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ x, y }) => {
      const { editor, view } = (window as any).canvcode
      const camera = editor.session.get().camera
      const root = view.root.getBoundingClientRect()
      return { x: root.left + (x - camera.x) * camera.zoom, y: root.top + (y - camera.y) * camera.zoom }
    },
    { x, y },
  )
}

async function setNumber(page: Page, row: string, index: number, value: string) {
  const input = page.locator(`[data-testid="slide-layout-adjust"] ${row} input`).nth(index)
  await input.fill(value)
  await input.press('Enter')
}

test('changes the table width and position from the design panel, and keeps a dragged panel', async ({ page }) => {
  await openApp(page)
  const section = page.getByTestId('slide-layout-adjust')
  await expect(section).toBeVisible()
  const before = await state(page)
  expect(before.panel.w).toBe(680)

  // 幅：表が広がり、右図枠は右端を変えずに狭くなる
  await setNumber(page, '> .design-field:not(:first-child)', 0, '800')
  let after = await state(page)
  expect(after.panel.w).toBe(800)
  expect(after.figure.x + after.figure.w).toBe(before.figure.x + before.figure.w)
  expect(after.figure.w).toBe(before.figure.w - 120)

  // 表の Y：表が上へ動く（右図枠は動かない）
  await setNumber(page, '[data-row="slide-layout.table"]', 1, '-60')
  after = await state(page)
  expect(after.panel.y).toBe(before.panel.y - 60)
  expect(after.figure.y).toBe(before.figure.y)
  expect(after.adjust).toEqual({ table: { dy: -60, w: 800 } })
  await page.screenshot({ path: test.info().outputPath('adjusted.png') })

  // 表パネルの余白（左下の内側。上はタイトルと重なる）をつかんで右下へドラッグする。離したあとも位置が残る
  const grab = await screenOf(page, after.panel.x + 10, after.panel.y + after.panel.h - 10)
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(grab.x + 20, grab.y + 15, { steps: 8 })
  await page.mouse.up()
  const dragged = await state(page)
  // 隣との間隔に吸い付くことがあるので、動いた向きと大きさだけを見る
  expect(dragged.panel.x - after.panel.x).toBeGreaterThan(20)
  expect(dragged.panel.y - after.panel.y).toBeGreaterThan(15)
  expect(dragged.panel.w).toBe(800)
  await page.screenshot({ path: test.info().outputPath('dragged.png') })

  // Undo でドラッグの前に戻る
  await page.keyboard.press('Control+z')
  expect((await state(page)).panel).toEqual(after.panel)
})

test('changes the table panel height from the design panel, keeping its top and the rows inside it', async ({ page }) => {
  await openApp(page)
  await expect(page.getByTestId('slide-layout-adjust')).toBeVisible()
  const before = await state(page)
  // 高さ（幅の次の欄）：決めていなければ今のパネルの高さを出す
  const height = page.locator('[data-testid="slide-layout-adjust"] > .design-field:not(:first-child) input').nth(1)
  await expect(height).toHaveValue(String(before.panel.h))

  await setNumber(page, '> .design-field:not(:first-child)', 1, '400')
  const after = await state(page)
  expect(after.panel).toEqual({ ...before.panel, h: 400 })
  expect(after.figure).toEqual(before.figure)
  expect(after.adjust).toEqual({ table: { h: 400, dy: before.panel.y - 197 } })
  // 行はパネルの中に収まる（引き伸ばされない）
  const bottom = await page.evaluate((slideId) => {
    const { editor } = (window as any).canvcode
    const rows = editor.slideLayoutFor(slideId).props.slots.rows
    return Math.max(...rows.map((row: { body: string }) => {
      const n = editor.getNode(row.body)
      return n.y + n.props.h
    }))
  }, SLIDE_ID)
  expect(bottom).toBeLessThanOrEqual(after.panel.y + after.panel.h)
  await page.screenshot({ path: test.info().outputPath('height.png') })
})

test('returns the table panel height to automatic with the button next to the height, keeping the other values', async ({ page }) => {
  await openApp(page)
  await expect(page.getByTestId('slide-layout-adjust')).toBeVisible()
  const before = await state(page)
  const auto = page.getByRole('button', { name: '高さを自動に戻す' })
  // 高さが自動なら押せない
  await expect(auto).toBeDisabled()

  await setNumber(page, '> .design-field:not(:first-child)', 0, '800')
  await setNumber(page, '> .design-field:not(:first-child)', 1, '400')
  const fixed = await state(page)
  expect(fixed.adjust).toEqual({ table: { w: 800, h: 400, dy: before.panel.y - 197 } })
  await expect(auto).toBeEnabled()

  // h だけを消す（幅・位置は残す）。高さは行数と内容から決まる高さに戻る
  await auto.click()
  const reset = await state(page)
  expect(reset.adjust).toEqual({ table: { w: 800, dy: before.panel.y - 197 } })
  expect(reset.panel.h).toBe(before.panel.h)
  expect(reset.panel.w).toBe(800)
  await expect(auto).toBeDisabled()
  await page.screenshot({ path: test.info().outputPath('auto-height.png') })

  // Undo 1 回で、決めた高さに戻る（キャンバスに戻ってから。数の欄の Undo は欄の文字の Undo）
  await page.locator('.canvas-container > div[tabindex]').focus()
  await page.keyboard.press('Control+z')
  expect(await state(page)).toEqual(fixed)
})

test('a title spans the panel width, grows up to two lines, and is marked as an overflow from the third line', async ({ page }) => {
  await openApp(page)
  // タイトルの文字を変えて、タイトルの箱（x・y・幅・高さ）と、あふれている子を返す
  const setTitle = (value: string) =>
    page.evaluate(
      ({ slideId, value }) => {
        const { editor } = (window as any).canvcode
        const layout = editor.slideLayoutFor(slideId)
        const id = layout.props.slots.title
        editor.transact('title', (tx: any) => {
          const n = editor.getNode(id)
          tx.put({ ...n, props: { ...n.props, paragraphs: value.split('\n').map((text: string) => ({ runs: [{ text }] })) } })
        })
        const n = editor.getNode(id)
        const bounds = editor.getType(n).getBounds(n)
        return { id, x: n.x, y: n.y, w: n.props.w, h: bounds.h, overflows: editor.slideOverflows().get(slideId)?.nodes ?? [] }
      },
      { slideId: SLIDE_ID, value },
    )
  const one = await setTitle('一行目')
  // 表紙のタイトルと同じ、パネルの横枠（150〜1810）
  expect(one.x).toBe(150)
  expect(one.w).toBe(1660)
  expect(one.overflows).toEqual([])
  const two = await setTitle('一行目\n二行目')
  expect(two.y).toBeLessThan(one.y)
  expect(two.overflows).toEqual([])
  const three = await setTitle('一行目\n二行目\n三行目')
  // 上へ伸ばすのは 2 行分まで。3 行目からはあふれの印を出す
  expect(three.y).toBe(two.y)
  expect(three.h).toBeGreaterThan(two.h)
  expect(three.overflows).toEqual([three.id])
  await page.screenshot({ path: test.info().outputPath('title-overflow.png') })
})
