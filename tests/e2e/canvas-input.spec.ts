import { expect, test, type Page } from '@playwright/test'

// These exercise trusted browser wheel/pointer input, not dispatchEvent (which does
// not run the browser's default scrolling or CodeMirror's real DOM handlers).
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return
  const diagnostic = await page.evaluate(() => {
    const fixture = (window as any).canvasInputFixture
    if (!fixture || !document.querySelector('.canvcode-document-editor')) return null
    const host = document.querySelector<HTMLElement>('.canvcode-document-editor')!
    const scroll = host.querySelector<HTMLElement>('.cm-scroller')!
    return {
      events: fixture.events,
      camera: fixture.editor.session.get().camera,
      editing: fixture.view.documentEditor.editingId,
      scrollTop: { root: fixture.view.root.scrollTop, layer: fixture.view.editingLayer.scrollTop, host: host.scrollTop, scroller: scroll.scrollTop },
      overflow: { root: getComputedStyle(fixture.view.root).overflow, host: getComputedStyle(host).overflow, scroller: getComputedStyle(scroll).overflow },
    }
  }).catch(() => null)
  if (diagnostic) await testInfo.attach('canvas-input-diagnostic', { body: JSON.stringify(diagnostic, null, 2), contentType: 'application/json' })
})

type State = {
  camera: { x: number; y: number; zoom: number }
  rootScroll: number
  layerScroll: number
  hostScroll: number
  scrollerScroll: number
  hostTop: number
  editing: string | null
  active: string
  events: Array<{ type: string; target: string; reachedRoot: boolean; prevented: boolean }>
}

async function open(page: Page, kind: 'code' | 'markdown', sizing: 'auto' | 'fixed', long = true) {
  await page.goto(`/canvas-input-test.html?kind=${kind}&sizing=${sizing}&long=${long ? 1 : 0}`)
  await page.waitForFunction(() => Boolean((window as any).canvasInputFixture))
  await page.evaluate(() => (window as any).canvasInputFixture.start())
  await expect(page.locator('.canvcode-document-editor .cm-scroller')).toBeVisible()
}

async function state(page: Page): Promise<State> {
  return page.evaluate(() => {
    const { editor, view } = (window as any).canvasInputFixture
    const host = document.querySelector<HTMLElement>('.canvcode-document-editor')!
    const scroller = host.querySelector<HTMLElement>('.cm-scroller')!
    return {
      camera: { ...editor.session.get().camera },
      rootScroll: view.root.scrollTop,
      layerScroll: view.editingLayer.scrollTop,
      hostScroll: host.scrollTop,
      scrollerScroll: scroller.scrollTop,
      hostTop: host.getBoundingClientRect().top,
      editing: view.documentEditor.editingId,
      active: document.activeElement?.className ?? '',
      events: [...(window as any).canvasInputFixture.events],
    }
  })
}

async function hover(page: Page, target: 'body' | 'header' | 'edge') {
  const host = page.locator('.canvcode-document-editor')
  if (target === 'body') await host.locator('.cm-content').hover({ position: { x: 80, y: 35 } })
  else if (target === 'header') await host.hover({ position: { x: 100, y: 15 } })
  else await host.hover({ position: { x: 4, y: 45 } })
}

for (const kind of ['code', 'markdown'] as const) {
  for (const target of ['body', 'header', 'edge'] as const) {
    test(`${kind} auto: wheel over ${target} pans canvas, not any DOM scroller`, async ({ page }) => {
      await open(page, kind, 'auto')
      await hover(page, target)
      const before = await state(page)
      await page.mouse.wheel(0, 100)
      await expect.poll(async () => (await state(page)).camera.y).toBeGreaterThan(before.camera.y)
      const after = await state(page)
      expect(after.camera.zoom).toBe(before.camera.zoom)
      expect(after.scrollerScroll).toBe(before.scrollerScroll)
      expect(after.hostScroll).toBe(before.hostScroll)
      expect(after.layerScroll).toBe(before.layerScroll)
      expect(after.rootScroll).toBe(before.rootScroll)
      expect(after.hostTop).toBeLessThan(before.hostTop)
      expect(after.editing).toBe(before.editing)
      expect(after.events.at(-1)).toMatchObject({ reachedRoot: true, prevented: true })
    })
  }

  test(`${kind} fixed: wheel scrolls editor, not canvas`, async ({ page }) => {
    await open(page, kind, 'fixed')
    await hover(page, 'body')
    const before = await state(page)
    await page.mouse.wheel(0, 120)
    await expect.poll(async () => (await state(page)).scrollerScroll).toBeGreaterThan(before.scrollerScroll)
    const after = await state(page)
    expect(after.camera).toEqual(before.camera)
    expect(after.rootScroll).toBe(before.rootScroll)
    expect(after.events.at(-1)).toMatchObject({ reachedRoot: false })
  })

  for (const sizing of ['auto', 'fixed'] as const) {
    test(`${kind} ${sizing}: Ctrl+wheel zooms canvas`, async ({ page }) => {
      await open(page, kind, sizing)
      await hover(page, 'body')
      const before = await state(page)
      await page.keyboard.down('Control')
      try {
        await page.mouse.wheel(0, -100)
        await expect.poll(async () => (await state(page)).camera.zoom).toBeGreaterThan(before.camera.zoom)
      } finally {
        await page.keyboard.up('Control')
      }
      const after = await state(page)
      expect(after.scrollerScroll).toBe(before.scrollerScroll)
      expect(after.editing).toBe(before.editing)
    })
  }

  test(`${kind} auto: middle drag pans while editing, releases capture`, async ({ page }) => {
    await open(page, kind, 'auto')
    await hover(page, 'body')
    const before = await state(page)
    const box = await page.locator('.canvcode-document-editor .cm-content').boundingBox()
    expect(box).not.toBeNull()
    const x = box!.x + 100, y = box!.y + 40
    await page.mouse.move(x, y)
    await page.mouse.down({ button: 'middle' })
    await page.mouse.move(x + 45, y + 35, { steps: 4 })
    await page.mouse.up({ button: 'middle' })
    const after = await state(page)
    expect(after.camera.x).toBeLessThan(before.camera.x)
    expect(after.camera.y).toBeLessThan(before.camera.y)
    expect(after.editing).toBe(before.editing)
    expect(after.active).toBe(before.active)
    expect(await page.evaluate(() => (window as any).canvasInputFixture.view.root.hasPointerCapture(1))).toBe(false)
  })

  test(`${kind} auto: Space drag from canvas onto card pans without ending editing`, async ({ page }) => {
    await open(page, kind, 'auto')
    await page.evaluate(() => (window as any).canvasInputFixture.view.root.focus({ preventScroll: true }))
    await hover(page, 'body')
    const before = await state(page)
    const box = await page.locator('.canvcode-document-editor .cm-content').boundingBox()
    expect(box).not.toBeNull()
    const x = box!.x + 100, y = box!.y + 40
    await page.keyboard.down('Space')
    try {
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + 40, y + 25, { steps: 4 })
      await page.mouse.up()
    } finally {
      await page.keyboard.up('Space')
    }
    const after = await state(page)
    expect(after.camera.x).toBeLessThan(before.camera.x)
    expect(after.editing).toBe(before.editing)
  })
}

test('auto card wheel pans at non-unit camera zoom without scrolling its DOM', async ({ page }) => {
  await open(page, 'code', 'auto')
  await page.evaluate(() => (window as any).canvasInputFixture.view.setCamera({ x: 0, y: 0, zoom: 1.5 }))
  await hover(page, 'body')
  const before = await state(page)
  await page.mouse.wheel(0, 60)
  await expect.poll(async () => (await state(page)).camera.y).toBeGreaterThan(before.camera.y)
  const after = await state(page)
  expect(after.camera.y - before.camera.y).toBeCloseTo(40, 1)
  expect(after.camera.zoom).toBe(1.5)
  expect(after.rootScroll).toBe(before.rootScroll)
  expect(after.scrollerScroll).toBe(before.scrollerScroll)
})

test('auto card pans for horizontal, Shift+vertical and repeated small wheel deltas', async ({ page }) => {
  await open(page, 'code', 'auto')
  await hover(page, 'body')
  const before = await state(page)
  await page.mouse.wheel(55, 0)
  await expect.poll(async () => (await state(page)).camera.x).toBeGreaterThan(before.camera.x)
  const horizontal = await state(page)
  expect(horizontal.camera.y).toBe(before.camera.y)
  await page.keyboard.down('Shift')
  try {
    await page.mouse.wheel(0, 20)
    await expect.poll(async () => (await state(page)).camera.x).toBeGreaterThan(horizontal.camera.x)
  } finally {
    await page.keyboard.up('Shift')
  }
  const shifted = await state(page)
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 10)
  await expect.poll(async () => (await state(page)).camera.y).toBeGreaterThan(shifted.camera.y)
  const after = await state(page)
  expect(after.rootScroll).toBe(before.rootScroll)
  expect(after.scrollerScroll).toBe(before.scrollerScroll)
})

test('auto card stays in place when CodeMirror moves its caret to a far-away line', async ({ page }) => {
  await open(page, 'code', 'auto')
  const before = await state(page)
  await page.locator('.canvcode-document-editor .cm-content').press('ControlOrMeta+End')
  const after = await state(page)
  expect(after.camera).toEqual(before.camera)
  expect(after.rootScroll).toBe(before.rootScroll)
  expect(after.hostScroll).toBe(before.hostScroll)
  expect(after.scrollerScroll).toBe(before.scrollerScroll)
})

test('short auto card remains scroll-free when wheel pans', async ({ page }) => {
  await open(page, 'code', 'auto', false)
  await hover(page, 'body')
  const before = await state(page)
  await page.mouse.wheel(0, 75)
  await expect.poll(async () => (await state(page)).camera.y).toBeGreaterThan(before.camera.y)
  expect((await state(page)).scrollerScroll).toBe(before.scrollerScroll)
})

test('auto editor keeps panning after its content grows during editing', async ({ page }) => {
  await open(page, 'code', 'auto', false)
  const host = page.locator('.canvcode-document-editor')
  const heightBefore = await host.evaluate((node) => node.getBoundingClientRect().height)
  await page.evaluate(() => (window as any).canvasInputFixture.setText(Array.from({ length: 70 }, (_, i) => `line ${i}`).join('\n')))
  await expect.poll(() => host.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(heightBefore)
  await hover(page, 'body')
  const before = await state(page)
  await page.mouse.wheel(0, 65)
  await expect.poll(async () => (await state(page)).camera.y).toBeGreaterThan(before.camera.y)
  const after = await state(page)
  expect(after.scrollerScroll).toBe(before.scrollerScroll)
  expect(after.rootScroll).toBe(before.rootScroll)
})

test('ordinary click and typing Space still edit card text instead of panning', async ({ page }) => {
  await open(page, 'code', 'auto', false)
  const content = page.locator('.canvcode-document-editor .cm-content')
  const before = await state(page)
  await content.click()
  const textBefore = await content.innerText()
  await page.keyboard.press('Space')
  const after = await state(page)
  expect(after.camera).toEqual(before.camera)
  expect(after.editing).toBe(before.editing)
  expect(await content.innerText()).not.toBe(textBefore)
})

test('changing sizing during editing switches wheel routing', async ({ page }) => {
  await open(page, 'code', 'fixed')
  await page.evaluate(() => (window as any).canvasInputFixture.setSizing('auto'))
  await hover(page, 'body')
  const before = await state(page)
  await page.mouse.wheel(0, 100)
  await expect.poll(async () => (await state(page)).camera.y).toBeGreaterThan(before.camera.y)
  expect((await state(page)).scrollerScroll).toBe(before.scrollerScroll)
})
