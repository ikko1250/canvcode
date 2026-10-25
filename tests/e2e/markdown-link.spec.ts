import { expect, test, type BrowserContext, type Page } from '@playwright/test'

// Markdown カードのリンクの上にポインタを置くと、行き先と開き方の札を出し、Ctrl を押している間は指のカーソルにする。
// Ctrl+クリックで新しいタブに開く（MAI-21）。本物の画面を使い、サーバーの応答だけを差し替える（markdown-tiles.spec.ts と同じ）

const URL_TO_OPEN = 'https://example.com/'

async function setup(page: Page, context: BrowserContext) {
  await page.goto('/canvas-input-test.html?kind=markdown&sizing=auto&long=0')
  await page.waitForFunction(() => Boolean((window as any).canvasInputFixture))
  const records = await page.evaluate(() => [...(window as any).canvasInputFixture.editor.workspace.store.values()])
  const text = `[example](${URL_TO_OPEN}) へのリンク\n\nリンクのない段落。リンクのない段落。リンクのない段落。`
  const file = { id: 'file:input-test', kind: 'markdown', title: 'Links', path: 'test.md', size: text.length, mtime: 0, hash: 'test', missing: false }
  await context.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: 'canvas:input-test', rev: 0, records } }))
  await context.route('**/api/files', (route) => route.fulfill({ json: { files: [file] } }))
  await context.route('**/api/files/file%3Ainput-test/content', (route) => route.fulfill({ body: text, headers: { etag: '"test"' } }))
  // 外のページへは出ないようにする（開いたタブの URL だけを見る）
  await context.route('https://example.com/**', (route) => route.fulfill({ body: 'example' }))
  await page.goto('/')
  const root = page.locator('.canvas-container > div[tabindex]')
  await expect(root).toBeVisible()

  // カードの左上が画面の (100, 100) に来るように、等倍で見る
  await expect.poll(() => page.evaluate(() => (window as any).canvcode.editor.index.allIds().length), { timeout: 15_000 }).toBeGreaterThan(0)
  const card = await page.evaluate(() => {
    const editor = (window as any).canvcode.editor
    const id = editor.index.allIds()[0]
    const bounds = editor.index.get(id).worldBounds
    ;(window as any).canvcode.view.setCamera({ x: bounds.x - 100, y: bounds.y - 100, zoom: 1 })
    return bounds
  })
  // 本文の 1 行目のリンクのある点を探す（ヘッダー 36・本文の上の余白 18・左の余白 22 の先）
  const findLink = () =>
    page.evaluate((card) => {
      const view = (window as any).canvcode.view
      for (let y = 40; y < 110; y += 2) {
        if (view.linkUnder({ x: card.x + 40, y: card.y + y })) return { x: 40, y }
      }
      return null
    }, card)
  await expect.poll(findLink, { timeout: 15_000 }).not.toBeNull()
  const local = (await findLink())!
  const rect = (await root.boundingBox())!
  return {
    root,
    link: { x: rect.x + 100 + local.x, y: rect.y + 100 + local.y },
    // 2 つ目の段落（リンクがない）
    plain: { x: rect.x + 100 + 40, y: rect.y + 100 + local.y + 60 },
  }
}

test('hovering a link in a markdown card shows where it goes and how to open it', async ({ page, context }) => {
  const { root, link, plain } = await setup(page, context)
  const hint = page.getByTestId('canvas-link-hint')
  await page.mouse.move(link.x, link.y)
  await expect(hint).toBeVisible()
  await expect(hint).toContainText(URL_TO_OPEN)
  await expect(hint).toContainText('+クリックで開く')
  // Ctrl を押している間だけ、指のカーソル
  expect(await root.evaluate((el) => el.style.cursor)).not.toBe('pointer')
  await page.keyboard.down('Control')
  await expect.poll(() => root.evaluate((el) => el.style.cursor)).toBe('pointer')
  await page.keyboard.up('Control')
  await expect.poll(() => root.evaluate((el) => el.style.cursor)).not.toBe('pointer')
  // リンクのないところでは消える
  await page.mouse.move(plain.x, plain.y)
  await expect(hint).toBeHidden()
})

test('Ctrl+click on a link in a markdown card opens it in a new tab', async ({ page, context }) => {
  const { link } = await setup(page, context)
  await page.mouse.move(link.x, link.y)
  const opened = context.waitForEvent('page')
  await page.keyboard.down('Control')
  await page.mouse.click(link.x, link.y)
  await page.keyboard.up('Control')
  const tab = await opened
  await expect.poll(() => tab.url()).toBe(URL_TO_OPEN)
  await tab.close()
})

test('a link below long paragraphs is hit where it is drawn, even when the page DOM lays text out differently', async ({ page, context }) => {
  // 端末によっては、リンクの位置を測るページの DOM と、カードの画像（SVG）とで、文字の幅が揃わず、行の数が変わる。
  // ここでは、計測の DOM だけが受け継ぐ文字間をページに付けて、同じことを起こす（画像の SVG は受け継がない）
  // （本文を読み込んで測るのは、ページを読み終えたあと）
  await page.addInitScript(() =>
    addEventListener('DOMContentLoaded', () => document.documentElement.style.setProperty('letter-spacing', '3px')),
  )
  await page.goto('/canvas-input-test.html?kind=markdown&sizing=auto&long=0')
  await page.waitForFunction(() => Boolean((window as any).canvasInputFixture))
  const records = await page.evaluate(() => [...(window as any).canvasInputFixture.editor.workspace.store.values()])
  const paragraph = 'リンクより上にある長い段落。行の数が変わると、その下にあるリンクの位置がずれる。'.repeat(3)
  const text = `${Array.from({ length: 4 }, () => paragraph).join('\n\n')}\n\n[example](${URL_TO_OPEN})`
  const file = { id: 'file:input-test', kind: 'markdown', title: 'Links', path: 'test.md', size: text.length, mtime: 0, hash: 'test', missing: false }
  await context.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: 'canvas:input-test', rev: 0, records } }))
  await context.route('**/api/files', (route) => route.fulfill({ json: { files: [file] } }))
  await context.route('**/api/files/file%3Ainput-test/content', (route) => route.fulfill({ body: text, headers: { etag: '"test"' } }))
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).canvcode.editor.index.allIds().length), { timeout: 15_000 }).toBeGreaterThan(0)
  await page.evaluate(() => {
    const editor = (window as any).canvcode.editor
    const bounds = editor.index.get(editor.index.allIds()[0]).worldBounds
    ;(window as any).canvcode.view.setCamera({ x: bounds.x - 50, y: bounds.y - 20, zoom: 1 })
  })

  // 画面に描かれたリンク（紫の文字と下線）の真ん中を、Canvas の画素から探す
  const drawn = () =>
    page.evaluate(() => {
      // 2 枚目がノードを描く Canvas（1 枚目は方眼）
      const canvas = document.querySelectorAll('.canvas-container canvas')[1] as HTMLCanvasElement
      const { data, width, height } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4
          // リンクの色 #6d43bd
          if (Math.abs(data[i] - 0x6d) < 24 && Math.abs(data[i + 1] - 0x43) < 24 && Math.abs(data[i + 2] - 0xbd) < 24) {
            minX = Math.min(minX, x)
            maxX = Math.max(maxX, x)
            minY = Math.min(minY, y)
            maxY = Math.max(maxY, y)
          }
        }
      }
      if (minX > maxX) return null
      const rect = canvas.getBoundingClientRect()
      const ratio = rect.width / canvas.width
      return { x: rect.x + ((minX + maxX) / 2) * ratio, y: rect.y + ((minY + maxY) / 2) * ratio }
    })
  await expect.poll(drawn, { timeout: 15_000 }).not.toBeNull()
  const link = (await drawn())!

  // DOM で測った位置は、描いたリンクより下にずれる（文字間の分だけ、上の段落の行が増える）。
  // 描いた画像から読んだ位置に替わると、描いたところで当たる
  const hrefAt = () =>
    page.evaluate(({ x, y }) => {
      const root = document.querySelector('.canvas-container > div[tabindex]')!.getBoundingClientRect()
      const camera = (window as any).canvcode.editor.session.get().camera
      return (window as any).canvcode.view.linkUnder({ x: camera.x + (x - root.x) / camera.zoom, y: camera.y + (y - root.y) / camera.zoom })
    }, link)
  await expect.poll(hrefAt, { timeout: 15_000 }).toBe(URL_TO_OPEN)
  await page.mouse.move(link.x, link.y)
  await expect(page.getByTestId('canvas-link-hint')).toContainText(URL_TO_OPEN)
})
