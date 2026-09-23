import { expect, test, type Page } from '@playwright/test'

// MAI-55: an inline editor (CodeMirror on a card, textarea on a sticky note) must stay exactly
// where the card is drawn, even when the card sticks out of the viewport and the browser tries
// to reveal the caret by scrolling the canvas root. These use trusted keyboard input so the
// browser's real caret-reveal scrolling runs.

type Rect = { left: number; top: number; width: number; height: number }

async function rootScroll(page: Page) {
  return page.evaluate(() => {
    const { view } = (window as any).canvasInputFixture
    return { top: view.root.scrollTop, left: view.root.scrollLeft, layerTop: view.editingLayer.scrollTop, layerLeft: view.editingLayer.scrollLeft }
  })
}

// Where the node's local origin (offset by dx/dy in local units) should land on screen, from the camera and the world matrix.
async function expectedRect(page: Page, nodeId: string, offset: { x: number; y: number; w: number; h: number }): Promise<Rect> {
  return page.evaluate(
    ({ nodeId, offset }) => {
      const { editor, view } = (window as any).canvasInputFixture
      const camera = editor.session.get().camera
      const m = editor.index.get(nodeId).worldMatrix
      const root = view.root.getBoundingClientRect()
      const z = camera.zoom
      return {
        left: root.left + (m.e + offset.x - camera.x) * z,
        top: root.top + (m.f + offset.y - camera.y) * z,
        width: offset.w * z,
        height: offset.h * z,
      }
    },
    { nodeId, offset },
  )
}

async function actualRect(page: Page, selector: string): Promise<Rect> {
  return page.evaluate((selector) => {
    const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect()
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  }, selector)
}

function expectClose(actual: Rect, expected: Rect) {
  expect(Math.abs(actual.left - expected.left)).toBeLessThanOrEqual(1)
  expect(Math.abs(actual.top - expected.top)).toBeLessThanOrEqual(1)
  expect(Math.abs(actual.width - expected.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(actual.height - expected.height)).toBeLessThanOrEqual(1)
}

for (const zoom of [1, 1.5] as const) {
  test(`code card sticking out of the viewport keeps its editor aligned while typing (zoom ${zoom})`, async ({ page }) => {
    await page.goto('/canvas-input-test.html?kind=code&sizing=auto&long=1')
    await page.waitForFunction(() => Boolean((window as any).canvasInputFixture))
    // The container is 800x600; a 440-wide, 90-line card at (500, 300) sticks out to the right and below.
    await page.evaluate((zoom) => {
      const fixture = (window as any).canvasInputFixture
      fixture.moveCard(500, 300)
      fixture.view.setCamera({ x: 0, y: 0, zoom })
    }, zoom)
    await page.evaluate(() => (window as any).canvasInputFixture.start())
    const content = page.locator('.canvcode-document-editor .cm-content')
    await expect(content).toBeVisible()

    // Move the caret to the end of the last (off-screen) line and type there.
    await content.press('ControlOrMeta+End')
    await page.keyboard.type(' typed')
    await expect.poll(() => content.innerText()).toContain('typed')

    const scroll = await rootScroll(page)
    expect(scroll.top).toBe(0)
    expect(scroll.left).toBe(0)
    expect(scroll.layerTop).toBe(0)
    expect(scroll.layerLeft).toBe(0)

    const cardId = await page.evaluate(() => (window as any).canvasInputFixture.cardId)
    const bounds = await page.evaluate((id) => {
      const { editor } = (window as any).canvasInputFixture
      return { ...editor.index.get(id).localBounds }
    }, cardId)
    const host = await actualRect(page, '.canvcode-document-editor')
    const expected = await expectedRect(page, cardId, { x: 0, y: 0, w: bounds.w, h: bounds.h })
    // The auto-height editor grows with its content, so only the top-left corner and the width are fixed by the card.
    expect(Math.abs(host.left - expected.left)).toBeLessThanOrEqual(1)
    expect(Math.abs(host.top - expected.top)).toBeLessThanOrEqual(1)
    expect(Math.abs(host.width - expected.width)).toBeLessThanOrEqual(1)
    expect(host.height).toBeGreaterThanOrEqual(expected.height - 1)

    // The first text row must sit at the card's header + vertical padding (36 + 10), and its first line number
    // must be right-aligned at paddingX + digits * charWidth, exactly where the card draws it.
    const metrics = await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>('.canvcode-document-editor')!
      const hostRect = host.getBoundingClientRect()
      const line = host.querySelector<HTMLElement>('.cm-line')!.getBoundingClientRect()
      const number = [...host.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement')].find((el) => el.textContent === '1')!.getBoundingClientRect()
      const gutter = host.querySelector<HTMLElement>('.cm-gutters')!.getBoundingClientRect()
      return { lineTop: line.top - hostRect.top, lineHeight: line.height, numberRight: number.right - hostRect.left, gutterRight: gutter.right - hostRect.left, lineLeft: line.left - hostRect.left }
    })
    const charWidth = await page.evaluate(() => {
      const ctx = document.createElement('canvas').getContext('2d')!
      ctx.font = "13px ui-monospace, 'SFMono-Regular', Menlo, 'DejaVu Sans Mono', 'Noto Sans Mono CJK JP', monospace"
      return ctx.measureText('0'.repeat(40)).width / 40
    })
    expect(Math.abs(metrics.lineTop - 46 * zoom)).toBeLessThanOrEqual(1)
    expect(Math.abs(metrics.lineHeight - 20 * zoom)).toBeLessThanOrEqual(1)
    // 90 lines → 2 digits
    expect(Math.abs(metrics.numberRight - (14 + 2 * charWidth) * zoom)).toBeLessThanOrEqual(1)
    expect(Math.abs(metrics.gutterRight - metrics.lineLeft)).toBeLessThanOrEqual(1)
  })

  test(`sticky note sticking out of the viewport keeps its textarea aligned while typing (zoom ${zoom})`, async ({ page }) => {
    await page.goto('/canvas-input-test.html?kind=code&sizing=auto&long=0')
    await page.waitForFunction(() => Boolean((window as any).canvasInputFixture))
    const noteId = await page.evaluate((zoom) => {
      const fixture = (window as any).canvasInputFixture
      fixture.view.setCamera({ x: 0, y: 0, zoom })
      // A 220-wide note at (700, 450) with many lines sticks out to the right and below the 800x600 container.
      return fixture.startNote(700, 450, Array.from({ length: 30 }, (_, i) => `note line ${i + 1}`).join('\n'))
    }, zoom)
    const textarea = page.locator('textarea')
    await expect(textarea).toBeFocused()

    await page.keyboard.type(' typed')
    await expect.poll(() => textarea.inputValue()).toContain('typed')

    const scroll = await rootScroll(page)
    expect(scroll.top).toBe(0)
    expect(scroll.left).toBe(0)
    expect(scroll.layerTop).toBe(0)
    expect(scroll.layerLeft).toBe(0)

    const box = await page.evaluate((id) => {
      const { editor } = (window as any).canvasInputFixture
      const node = editor.getNode(id)
      const spec = editor.getType(node).editText(node)
      return { ...spec.box }
    }, noteId)
    const actual = await actualRect(page, 'textarea')
    const expected = await expectedRect(page, noteId, box)
    expectClose(actual, expected)
  })
}
