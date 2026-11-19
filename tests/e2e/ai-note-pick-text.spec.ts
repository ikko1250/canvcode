import { expect, test, type Page } from '@playwright/test'

// AI 付箋の添える所を、PDF の文字をなぞって選ぶ（docs/ai-note-pick-text-plan.md）：
// 「添える所を選ぶ」状態で、PDF のページの上を Ctrl（⌘）+ドラッグすると、文字を読む順になぞって、選んだ文字を添える。
// 添えたときに Ctrl（⌘）を押していれば選ぶ状態のまま続き、離すと付箋を選び直す。動かさずに Ctrl+クリックしただけでは添えない。
// 修飾キーなしで範囲で囲むと、今までどおり 1 か所で抜け、ページの範囲の文字も添える

const CANVAS_ID = 'canvas:pick-text-test'
const FILE_ID = 'file:pick-text-test'
const HASH = 'e'.repeat(64)
const ASSET_ID = `asset:${HASH}`
const PAGE = { width: 612, height: 792 }
// PDF のポイント → ワールド座標（PDF_POINT_SCALE）
const SCALE = 96 / 72
const FONT = 20
// 文字の行。y は PDF の座標（下が 0）
const LINES = [
  { text: 'The model was trained on a large cor-', y: 700 },
  { text: 'pus of text. It works well.', y: 670 },
  { text: 'Results are shown in Table 2.', y: 600 },
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

// PDF のページの Canvas に、AI 付箋を 1 枚置いて開く。refs に保存した ref を、asks に答えの頼みを残す。付箋の id を返す
async function openApp(page: Page, sent: { refs: Record<string, unknown>[]; asks: Record<string, unknown>[] }): Promise<string> {
  const canvas = {
    typeName: 'canvas', id: CANVAS_ID, title: 'Pick text', parentCanvasId: null, ownerNodeId: null,
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
  await page.route('**/api/claude/threads', (route) => route.fulfill({ json: { threads: [] } }))
  await page.route('**/api/claude/events', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/claude/models', (route) => route.fulfill({ json: { models: [], default: {}, fromClaude: false } }))
  await page.route('**/api/claude/questions*', (route) => route.fulfill({ json: { questions: [] } }))
  // 付箋の作業を頼む（docs/ai-note-tasks-plan.md）。送ったものを集め、その付箋の作業のジョブを返す
  await page.route('**/api/claude/note-tasks', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    sent.asks.push(body)
    const id = '11111111-2222-4333-8444-555555555555'
    const job = { id, threadId: id, prompt: body.instruction, status: 'done', createdAt: 0, note: { noteId: body.noteId, canvasId: body.canvasId }, eventCount: 0, events: [] }
    await route.fulfill({ status: 201, json: { job } })
  })
  await page.route('**/api/refs', async (route) => {
    sent.refs.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({ status: 200, json: {} })
  })
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
  // ページの文字の下（ワールド座標で y = 380 から）に、AI 付箋を置く。ページ全体が画面に入るよう縮める
  return page.evaluate(() => {
    const editor = (window as any).canvcode.editor
    const node = editor.makeNode('note', { x: 160, y: 380, props: { paragraphs: [{ runs: [{ text: 'この結果は何を示す？' }] }] } })
    editor.createNodes([{ ...node, meta: { ...node.meta, ai: { contexts: [] } } }])
    editor.session.set({ camera: { x: -40, y: -40, zoom: 0.6 } })
    return node.id as string
  })
}

// PDF の点（ポイント。x は左から、y は PDF の座標）の、画面の位置
async function screenAt(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ wx, wy }) => {
      const { editor, view } = (window as any).canvcode
      const { camera } = editor.session.get()
      const rect = view.root.getBoundingClientRect()
      return { x: rect.left + (wx - camera.x) * camera.zoom, y: rect.top + (wy - camera.y) * camera.zoom }
    },
    { wx: x * SCALE, wy: (PAGE.height - y) * SCALE },
  )
}

// 行の中ほど（ベースラインから字の高さの 3 分の 1 ほど上）の画面の位置
const lineAt = (page: Page, x: number, line: number) => screenAt(page, x, LINES[line]!.y + FONT * 0.35)

// ノードの真ん中の画面の位置
async function centerOf(page: Page, id: string): Promise<{ x: number; y: number }> {
  return page.evaluate((id) => {
    const { editor, view } = (window as any).canvcode
    const bounds = editor.index.get(id).worldBounds
    const { camera } = editor.session.get()
    const rect = view.root.getBoundingClientRect()
    return { x: rect.left + (bounds.x + bounds.w / 2 - camera.x) * camera.zoom, y: rect.top + (bounds.y + bounds.h / 2 - camera.y) * camera.zoom }
  }, id)
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 4 })
  await page.mouse.up()
}

const contextsOf = (page: Page, id: string) => page.evaluate((id) => (window as any).canvcode.editor.getNode(id)?.meta?.ai?.contexts ?? [], id)
const selection = (page: Page) => page.evaluate(() => [...(window as any).canvcode.editor.session.get().selectedIds] as string[])
const wordHighlight = (page: Page) => page.evaluate(() => (window as any).canvcode.editor.session.get().wordHighlight)

async function startPicking(page: Page, noteId: string) {
  const note = await centerOf(page, noteId)
  await page.mouse.click(note.x, note.y)
  await page.locator('.ai-note-attach').click()
  await expect(page.locator('.ai-note-picking')).toBeVisible()
}

test('選ぶ状態で Ctrl+ドラッグでなぞると、選んだ文字を添える。押したまま続けてなぞれ、離すと付箋を選び直す。送ると PDF の範囲の ref を送る', async ({ page }) => {
  const sent = { refs: [] as Record<string, unknown>[], asks: [] as Record<string, unknown>[] }
  const noteId = await openApp(page, sent)
  await startPicking(page, noteId)
  await expect(page.locator('.ai-note-picking-help')).toHaveText('PDF は Ctrl+ドラッグで文字をなぞる。Ctrl を押している間は続けて選べる')

  await page.keyboard.down('Control')
  // Ctrl を押してページの文字の上に来ると、なぞれるカーソルになる
  const from = await lineAt(page, 72 + 45, 0)
  await page.mouse.move(from.x - 2, from.y)
  await page.mouse.move(from.x, from.y)
  await expect(page.locator('.canvas-container > div[tabindex]')).toHaveCSS('cursor', 'text')
  // 1 行目の「model」から、2 行目の「text」まで（行をまたぎ、行末のハイフンで切れた語をつなぐ）
  await drag(page, from, await lineAt(page, 72 + 84, 1))
  await expect(page.locator('.ai-note-attach-count')).toHaveText('1')
  // 押したままなので、選ぶ状態が続く。なぞった所はハイライトしたまま
  await expect(page.locator('.ai-note-picking')).toBeVisible()
  expect(await wordHighlight(page)).not.toBeNull()
  // 2 か所目：3 行目の「Results」から「are」まで
  await drag(page, await lineAt(page, 72 + 4, 2), await lineAt(page, 72 + 80, 2))
  await expect(page.locator('.ai-note-attach-count')).toHaveText('2')
  await expect(page.locator('.ai-note-picking')).toBeVisible()
  // 離すと、選ぶ状態を抜けて付箋を選び直す。ハイライトも消す
  await page.keyboard.up('Control')
  await expect(page.locator('.ai-note-picking')).toHaveCount(0)
  await expect.poll(() => selection(page)).toEqual([noteId])
  await expect.poll(() => wordHighlight(page)).toBeNull()

  const contexts = await contextsOf(page, noteId)
  expect(contexts).toHaveLength(2)
  expect(contexts[0]).toMatchObject({
    kind: 'canvas',
    label: 'PDF の 1 ページ「model was traine…」',
    target: { kind: 'pdf', fileId: FILE_ID, pageIndex: 0, text: 'model was trained on a large corpus of text' },
  })
  expect(contexts[1]).toMatchObject({ label: 'PDF の 1 ページ「Results are」', target: { kind: 'pdf', text: 'Results are' } })
  await page.locator('.ai-note-attach-count').click()
  await expect(page.locator('.ai-note-context')).toHaveText(['PDF の 1 ページ「model was traine…」×', 'PDF の 1 ページ「Results are」×'])

  // 送ると、なぞった所を PDF の範囲の ref にして、その id を送る
  await page.locator('.ai-note-send').click()
  await expect.poll(() => sent.asks.length).toBe(1)
  expect(sent.refs).toHaveLength(2)
  expect(sent.refs[0]).toMatchObject({ kind: 'pdf', fileId: FILE_ID, pageIndex: 0, text: 'model was trained on a large corpus of text' })
  expect(sent.refs[1]).toMatchObject({ kind: 'pdf', text: 'Results are' })
  expect(sent.asks[0]!.refs).toEqual([
    { label: 'PDF の 1 ページ「model was traine…」', refId: sent.refs[0]!.id },
    { label: 'PDF の 1 ページ「Results are」', refId: sent.refs[1]!.id },
  ])
})

test('動かさずに Ctrl+クリックしただけでは添えない。同じ所は 2 回添えない。何も添えずに Ctrl を離しても、選ぶ状態は続く', async ({ page }) => {
  const noteId = await openApp(page, { refs: [], asks: [] })
  await startPicking(page, noteId)
  const word = await lineAt(page, 72 + 45, 0)
  await page.keyboard.down('Control')
  await page.mouse.click(word.x, word.y)
  await page.waitForTimeout(200)
  expect(await contextsOf(page, noteId)).toEqual([])
  expect(await wordHighlight(page)).toBeNull()
  await page.keyboard.up('Control')
  await expect(page.locator('.ai-note-picking')).toBeVisible()

  // なぞって添え、同じ所をもう一度なぞると断る
  await page.keyboard.down('Control')
  await drag(page, word, await lineAt(page, 72 + 84, 1))
  await expect(page.locator('.ai-note-attach-count')).toHaveText('1')
  await drag(page, word, await lineAt(page, 72 + 84, 1))
  await expect(page.getByText('もう添えてあります')).toBeVisible()
  await expect(page.locator('.ai-note-attach-count')).toHaveText('1')
  // Esc でもやめられる
  await page.keyboard.press('Escape')
  await expect(page.locator('.ai-note-picking')).toHaveCount(0)
  await page.keyboard.up('Control')
  await expect.poll(() => selection(page)).toEqual([noteId])
})

test('修飾キーなしで PDF のページの一部を範囲で囲むと、1 か所で抜ける。送ると、その範囲の文字を ref に付ける。ほぼ全体を囲むと、ページ全体の文字', async ({ page }) => {
  const sent = { refs: [] as Record<string, any>[], asks: [] as Record<string, unknown>[] }
  const noteId = await openApp(page, sent)
  await startPicking(page, noteId)
  // 1・2 行目を囲む（付箋にはかからない）
  await drag(page, await screenAt(page, 60, LINES[0]!.y + FONT * 1.2), await screenAt(page, 480, LINES[1]!.y - FONT * 0.6))
  await expect(page.locator('.ai-note-attach-count')).toHaveText('1')
  await expect(page.locator('.ai-note-picking')).toHaveCount(0)
  await expect.poll(() => selection(page)).toEqual([noteId])
  const [area] = await contextsOf(page, noteId)
  expect(area).toMatchObject({ kind: 'canvas', label: '1 個のノード', target: { kind: 'canvas', canvasId: CANVAS_ID } })
  expect(area.target.nodes.map((node: { id: string }) => node.id)).toEqual(['node:page0'])
  // 付箋には、ページの中の範囲だけを持つ（文字は送るときに読む）
  expect(area.regions).toHaveLength(1)
  expect(area.regions[0]).toMatchObject({ nodeId: 'node:page0', fileId: FILE_ID, pageIndex: 0 })
  expect(area.regions[0].rect.h).toBeLessThan(0.2)

  // ページのほぼ全体を囲む（付箋も入るが、付箋自身は添えない）
  await page.locator('.ai-note-attach').click()
  // 右下から左上へ（左上の角にはサイドバーを開くボタンがあるので、そこからは始めない）
  await drag(page, await screenAt(page, PAGE.width + 10, -10), await screenAt(page, -10, PAGE.height + 10))
  await expect(page.locator('.ai-note-attach-count')).toHaveText('2')
  const [, whole] = await contextsOf(page, noteId)
  expect(whole.target.nodes.map((node: { id: string }) => node.id)).toEqual(['node:page0'])
  expect(whole.regions).toEqual([expect.objectContaining({ nodeId: 'node:page0', rect: { x: 0, y: 0, w: 1, h: 1 } })])

  // 送ると、範囲の文字を読んで ref のノードに付ける
  await page.locator('.ai-note-send').click()
  await expect.poll(() => sent.asks.length).toBe(1)
  expect(sent.refs).toHaveLength(2)
  const first = sent.refs[0]!.nodes[0].pdf
  expect(first).toMatchObject({ fileId: FILE_ID, pageIndex: 0 })
  expect(first.text).toContain('The model was trained on a large corpus of text.')
  expect(first.text).not.toContain('Results')
  expect(sent.refs[1]!.nodes[0].pdf.text).toContain('Results are shown in Table 2.')
})

test('Ctrl を押したまま範囲で囲んで添えたあと、Ctrl+クリックや Undo で、選んでいないものを添えない', async ({ page }) => {
  const noteId = await openApp(page, { refs: [], asks: [] })
  await startPicking(page, noteId)
  await page.keyboard.down('Control')
  // 1・2 行目を、ページの外の左から囲む（Ctrl を押していても、ページの外から始めれば範囲選択）
  await drag(page, await screenAt(page, -20, LINES[0]!.y + FONT * 1.2), await screenAt(page, 480, LINES[1]!.y - FONT * 0.6))
  await expect(page.locator('.ai-note-attach-count')).toHaveText('1')
  await expect(page.locator('.ai-note-picking')).toBeVisible()
  // 添えたら、付箋を選び直しておく
  await expect.poll(() => selection(page)).toEqual([noteId])
  // 何もない所を Ctrl+クリックしても、添えない
  const empty = await screenAt(page, PAGE.width + 40, 400)
  await page.mouse.click(empty.x, empty.y)
  await page.waitForTimeout(200)
  expect(await contextsOf(page, noteId)).toHaveLength(1)
  // Ctrl+Z で添えたことを戻しても、もう一度は添えない
  await page.keyboard.press('z')
  await expect.poll(() => contextsOf(page, noteId)).toEqual([])
  await page.waitForTimeout(200)
  expect(await contextsOf(page, noteId)).toEqual([])
  await page.keyboard.up('Control')
  await expect(page.locator('.ai-note-picking')).toHaveCount(0)
})

test('2 か所目をなぞっている途中で Ctrl を離すと、そのなぞりを添えてから抜ける。なぞっている途中の Esc は、何も添えず、ハイライトも残さない', async ({ page }) => {
  const noteId = await openApp(page, { refs: [], asks: [] })
  await startPicking(page, noteId)
  await page.keyboard.down('Control')
  await drag(page, await lineAt(page, 72 + 45, 0), await lineAt(page, 72 + 84, 1))
  await expect(page.locator('.ai-note-attach-count')).toHaveText('1')
  // 2 か所目：押して動かし、離す前に Ctrl を離す
  const from = await lineAt(page, 72 + 4, 2)
  const to = await lineAt(page, 72 + 80, 2)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, from.y, { steps: 4 })
  await page.keyboard.up('Control')
  await expect(page.locator('.ai-note-picking')).toBeVisible()
  await page.mouse.move(to.x, to.y, { steps: 4 })
  await page.mouse.up()
  await expect(page.locator('.ai-note-attach-count')).toHaveText('2')
  await expect(page.locator('.ai-note-picking')).toHaveCount(0)
  await expect.poll(() => selection(page)).toEqual([noteId])
  await expect.poll(() => wordHighlight(page)).toBeNull()
  expect((await contextsOf(page, noteId))[1]).toMatchObject({ target: { text: 'Results are' } })

  // なぞっている途中で Esc
  await page.locator('.ai-note-attach').click()
  await page.keyboard.down('Control')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, from.y, { steps: 4 })
  await page.keyboard.press('Escape')
  await expect(page.locator('.ai-note-picking')).toHaveCount(0)
  await page.mouse.move(to.x, to.y, { steps: 4 })
  await page.mouse.up()
  await page.keyboard.up('Control')
  await page.waitForTimeout(200)
  expect(await contextsOf(page, noteId)).toHaveLength(2)
  expect(await wordHighlight(page)).toBeNull()
})
