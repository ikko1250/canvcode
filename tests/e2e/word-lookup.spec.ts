import { expect, test, type Page } from '@playwright/test'

// PDF の上の語を調べる（o メニューの「単語を調べる」。MAI-99）：選ぶと、なぞるモードに入り、PDF のページの上でなぞった語を、
// 読む順に（行をまたいで、行末のハイフンで切れた語はつないで）選ぶ。離すと、選んだ語と前後の文をサーバー
// （/api/claude/lookup。ここでは差し替え）に送り、吹き出しに「調べています」、答えが来たら意味を出す。
// 「ノートとして置く」で、ページの横に引用ノート（出典は選んだ所、メモは意味）を置く。Esc でなぞるモードをやめられる。
// Claude が使えない（/api/claude/threads が 404）ときは、メニューに出さない

const CANVAS_ID = 'canvas:word-lookup-test'
const FILE_ID = 'file:word-lookup-test'
const HASH = 'd'.repeat(64)
const ASSET_ID = `asset:${HASH}`
const PAGE = { width: 612, height: 792 }
// PDF のポイント → ワールド座標（PDF_POINT_SCALE）
const SCALE = 96 / 72
const FONT = 20
// 文字の行。y は PDF の座標（下が 0）
const LINES = [
  { text: 'The model was trained on a large cor-', y: 700 },
  { text: 'pus of text. It works well.', y: 670 },
]

// Helvetica（埋め込まない標準フォント）で文字を書いた 1 ページの PDF
function textPdf(): Buffer {
  const content = LINES.map((line) => `BT /F1 ${FONT} Tf 72 ${line.y} Td (${line.text}) Tj ET`).join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((body, i) => {
    const offset = pdf.length
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
    return offset
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

const PDF = textPdf()

type Lookup = { phrase: string; context: string }

// claude：Claude を使えるか。lookups に、調べる頼みを残す。answer が解けるまで答えない
async function openApp(page: Page, options: { claude: boolean; lookups?: Lookup[]; answer?: Promise<void> }) {
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: 'Word lookup', parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  const file = {
    typeName: 'file', id: FILE_ID, kind: 'pdf', title: 'paper.pdf', path: '', size: PDF.length, mtime: 0, hash: HASH, missing: false,
    assetId: ASSET_ID, pagesCanvasId: CANVAS_ID, pageCount: 1, parentCanvasId: null, ownerNodeId: null,
    createdAt: 0, updatedAt: 0, deletedAt: null, trash: null,
  }
  const pageNode = {
    typeName: 'node', id: 'node:page0', type: 'pdf-page', parentId: CANVAS_ID, x: 0, y: 0, rotation: 0,
    index: 'a0', opacity: 1, locked: true, version: 1,
    props: { assetId: ASSET_ID, fileId: FILE_ID, pageIndex: 0, w: PAGE.width * SCALE, h: PAGE.height * SCALE }, meta: {},
  }
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records: [canvas, file, pageNode] } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [] } }))
  await page.route('**/api/assets**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/assets') {
      return route.fulfill({ json: { assets: [{ mime: 'application/pdf', size: PDF.length, hash: HASH, width: 0, height: 0, variants: [] }] } })
    }
    return route.fulfill({ body: PDF, contentType: 'application/pdf' })
  })
  await page.route('**/api/claude/threads', (route) => (options.claude ? route.fulfill({ json: { threads: [] } }) : route.fulfill({ status: 404, json: {} })))
  await page.route('**/api/claude/events', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/claude/lookup', async (route) => {
    options.lookups?.push(route.request().postDataJSON() as Lookup)
    await options.answer
    await route.fulfill({ json: { phrase: 'corpus', meaning: '学習に使った文章の集まり', reading: 'ˈkɔːrpəs', partOfSpeech: '名詞', model: 'claude-haiku-5-5' } })
  })
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
}

// PDF の点（ポイント。x は左から、y は PDF の座標）の、画面の位置
async function screenAt(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ wx, wy }) => {
      const { editor, view } = (window as unknown as { canvcode: { editor: { session: { get(): { camera: { x: number; y: number; zoom: number } } } }; view: { root: HTMLElement } } }).canvcode
      const { camera } = editor.session.get()
      const rect = view.root.getBoundingClientRect()
      return { x: rect.left + (wx - camera.x) * camera.zoom, y: rect.top + (wy - camera.y) * camera.zoom }
    },
    { wx: x * SCALE, wy: (PAGE.height - y) * SCALE },
  )
}

// 行の中ほど（ベースラインから字の高さの 3 分の 1 ほど上）の画面の位置
const lineAt = (page: Page, x: number, line: number) => screenAt(page, x, LINES[line]!.y + FONT * 0.35)

async function chooseLookUp(page: Page) {
  const rect = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
  await page.keyboard.down('o')
  await page.locator('.pie-item', { hasText: '単語を調べる' }).click({ force: true })
  await page.keyboard.up('o')
}

const quoteNotes = (page: Page) =>
  page.evaluate(() => {
    const { editor } = (window as unknown as { canvcode: { editor: { index: { allIds(): string[] }; getNode(id: string): { type: string; props: Record<string, unknown> } | undefined } } }).canvcode
    return editor.index
      .allIds()
      .map((id) => editor.getNode(id))
      .filter((node) => node?.type === 'quote-card')
      .map((node) => ({ quote: node!.props.quote, memo: node!.props.memo }))
  })

test('looks up the words traced on a PDF page, and places the meaning as a quote note', async ({ page }) => {
  const lookups: Lookup[] = []
  let answer!: () => void
  await openApp(page, { claude: true, lookups, answer: new Promise<void>((resolve) => (answer = resolve)) })
  await chooseLookUp(page)
  await expect(page.locator('.canvas-container > div[tabindex]')).toHaveCSS('cursor', 'text')

  // 1 行目の「model」の「m」から、2 行目の「text」の「x」まで（Helvetica の幅で数えた位置）なぞる
  const from = await lineAt(page, 72 + 45, 0)
  const to = await lineAt(page, 72 + 84, 1)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 4 })
  await page.mouse.up()

  const bubble = page.getByRole('dialog', { name: '単語を調べる' })
  await expect(bubble).toContainText('調べています')
  await expect.poll(() => lookups.length).toBe(1)
  // 行末のハイフンで切れた語はつなぎ、前後の文も同じページの文字から送る
  expect(lookups[0]!.phrase).toBe('model was trained on a large corpus of text')
  expect(lookups[0]!.context).toContain('The model was trained on a large corpus of text.')
  expect(lookups[0]!.context).toContain('It works well.')
  // 選択ツールに戻っている（もう一度なぞっても調べない）
  expect(await page.evaluate(() => (window as unknown as { canvcode: { editor: { session: { get(): { toolId: string; wordLookupArmed: boolean } } } } }).canvcode.editor.session.get())).toMatchObject({
    toolId: 'select',
    wordLookupArmed: false,
  })

  answer()
  await expect(bubble).toContainText('学習に使った文章の集まり')
  await expect(bubble).toContainText('名詞 /ˈkɔːrpəs/')
  await bubble.getByRole('button', { name: 'ノートとして置く' }).click()
  await expect(bubble).toBeHidden()
  await expect.poll(() => quoteNotes(page)).toEqual([{ quote: 'model was trained on a large corpus of text', memo: '名詞 /ˈkɔːrpəs/\n学習に使った文章の集まり' }])
})

test('Esc leaves the tracing mode without looking anything up', async ({ page }) => {
  const lookups: Lookup[] = []
  await openApp(page, { claude: true, lookups })
  await chooseLookUp(page)
  await page.keyboard.press('Escape')
  const from = await lineAt(page, 72 + 4, 0)
  const to = await lineAt(page, 72 + FONT * 4, 0)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 4 })
  await page.mouse.up()
  await expect(page.getByRole('dialog', { name: '単語を調べる' })).toHaveCount(0)
  expect(lookups).toEqual([])
})

test('does not offer 単語を調べる when Claude is not available', async ({ page }) => {
  await openApp(page, { claude: false })
  const rect = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
  await page.keyboard.down('o')
  await expect(page.locator('.pie-item', { hasText: 'ページをすべて選ぶ' })).toBeVisible()
  await expect(page.locator('.pie-item', { hasText: '単語を調べる' })).toHaveCount(0)
  // 文字を選ぶのは、Claude がなくても出す（MAI-103）
  await expect(page.locator('.pie-item', { hasText: '文字を選ぶ' })).toBeVisible()
  await page.keyboard.up('o')
})

// 「文字を選ぶ」（MAI-103）：なぞるのは「単語を調べる」と同じで、離すと調べずに、矩形で引用したときと同じメニューを出す
async function traceText(page: Page) {
  // 置いた引用ノートなどを選んでいると、ページの項目が「ページ ›」にまとまるので、選択を外してから
  await page.evaluate(() => (window as unknown as { canvcode: { editor: { setSelection(ids: string[]): void } } }).canvcode.editor.setSelection([]))
  const rect = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
  await page.keyboard.down('o')
  await page.locator('.pie-item', { hasText: '文字を選ぶ' }).click({ force: true })
  await page.keyboard.up('o')
  await expect(page.locator('.canvas-container > div[tabindex]')).toHaveCSS('cursor', 'text')
  // 1 行目の「model」から、2 行目の「text」まで（行をまたぎ、行末のハイフンで切れた語をつなぐ）
  const from = await lineAt(page, 72 + 45, 0)
  const to = await lineAt(page, 72 + 84, 1)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 6 })
  await page.mouse.up()
}

const wordHighlight = (page: Page) =>
  page.evaluate(() => (window as unknown as { canvcode: { editor: { session: { get(): { wordHighlight: unknown } } } } }).canvcode.editor.session.get().wordHighlight)

const menuItems = (page: Page) => page.locator('.context-menu button')

test('selects the text traced on a PDF page and quotes, copies or gives it to Claude (MAI-103)', async ({ page, context, browserName }) => {
  const lookups: Lookup[] = []
  const refs: Record<string, unknown>[] = []
  await openApp(page, { claude: true, lookups })
  await page.route('**/api/refs', async (route) => {
    refs.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({ status: 200, json: {} })
  })
  await page.route('**/api/claude/models', (route) => route.fulfill({ json: { models: [], default: {}, fromClaude: false } }))

  await traceText(page)
  // 調べずに、引用のメニューを出す。なぞった所はハイライトしたまま
  await expect(menuItems(page)).toHaveText(['このページの横に引用ノート', '引用をコピー', '文字をコピー', 'AIに渡すIDをコピー', 'Claude に頼む…'])
  expect(await wordHighlight(page)).not.toBeNull()
  expect(lookups).toEqual([])
  // 選択ツールに戻っている
  expect(await page.evaluate(() => (window as any).canvcode.editor.session.get().wordLookupArmed)).toBe(false)

  // 文字だけをコピーする（改行は入れない）。閉じたらハイライトを消す
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await menuItems(page).filter({ hasText: '文字をコピー' }).click()
  await expect(menuItems(page)).toHaveCount(0)
  await expect.poll(() => wordHighlight(page)).toBeNull()
  if (browserName === 'chromium') expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('model was trained on a large corpus of text')

  // 引用ノートを置く（出典はなぞった所を囲む箱）
  await traceText(page)
  await menuItems(page).filter({ hasText: 'このページの横に引用ノート' }).click()
  await expect.poll(() => quoteNotes(page)).toEqual([{ quote: 'model was trained on a large corpus of text', memo: '' }])
  // 置いたノートはメモの編集が始まっているので、終えてから次へ
  await page.keyboard.press('Escape')

  // Claude に頼む：なぞった文字を ref にして、パネルに添える
  await traceText(page)
  await menuItems(page).filter({ hasText: 'Claude に頼む…' }).click()
  await expect(page.locator('.claude-attachment')).toContainText('PDF の 1 ページ「model was traine…」')
  await expect.poll(() => refs.length).toBe(1)
  expect(refs[0]).toMatchObject({ kind: 'pdf', fileId: FILE_ID, pageIndex: 0, text: 'model was trained on a large corpus of text' })
  const rect = refs[0]!.rect as { x: number; y: number; w: number; h: number }
  // 囲む箱は 2 行分（ページの中の割合）
  expect(rect.x).toBeGreaterThan(0.05)
  expect(rect.h).toBeGreaterThan(0.04)
  expect(rect.h).toBeLessThan(0.1)
})

test('quotes the traced text without Claude, and Esc leaves the mode (MAI-103)', async ({ page }) => {
  await openApp(page, { claude: false })
  await traceText(page)
  // 「AIに渡すIDをコピー」は、SSH の先の Claude Code に貼るためのものなので、画面の Claude がなくても出る
  await expect(menuItems(page)).toHaveText(['このページの横に引用ノート', '引用をコピー', '文字をコピー', 'AIに渡すIDをコピー'])
  await page.keyboard.press('Escape')
  await expect(menuItems(page)).toHaveCount(0)
  await expect.poll(() => wordHighlight(page)).toBeNull()
})
