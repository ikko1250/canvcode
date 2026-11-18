import { expect, test, type Page, type Route } from '@playwright/test'

// キャンバスの AI：付箋の右クリックの「Claude に聞く」か AI 付箋の「送信」で、答え（サーバーの /api/claude/answer。ここでは差し替え）を
// 質問の付箋の meta.ai.answer に書く（キャンバスには何も置かない）。近くの付箋を関連する付箋の候補として送り、
// 続きの付箋は、添えた前の質問と答えを送る。どの付箋の質問かも送り（サーバーの動いている質問の一覧に載る）、付箋に書いたら finish で知らせる。
// ほかのタブで止められたら（SSE の question-done が cancelled）、付箋に書かない（docs/canvas-answer-panel-plan.md）

const QUESTION = 'swiftの開発環境ってどうやって整えたら良いの?'
const ANSWER = { body: '前提：iOS アプリを作る\n\n**Xcode** を入れれば、開発環境はほぼ整う。\n\n- まず App Store から `Xcode` を入れる', related: [] as string[], model: 'claude-sonnet-5-5' }

async function openApp(page: Page, answer: (route: Route) => Promise<void>, events?: (route: Route) => Promise<void>): Promise<string> {
  await page.goto('/canvas-input-test.html?kind=markdown&sizing=auto')
  await page.waitForFunction(() => Boolean((window as any).canvasInputFixture))
  const { records, noteId } = await page.evaluate((text) => {
    const fixture = (window as any).canvasInputFixture
    const noteId = fixture.startNote(300, 300, text)
    return { records: [...fixture.editor.workspace.store.values()], noteId }
  }, QUESTION)
  const file = { id: 'file:input-test', kind: 'markdown', title: 'Input test', path: 'test.md', size: 100, mtime: 0, hash: 'test', missing: false }
  await page.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: 'canvas:input-test', rev: 0, records } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [file] } }))
  await page.route('**/api/files/file%3Ainput-test/content', (route) => route.fulfill({ body: '# Card', headers: { etag: '"test"' } }))
  await page.route('**/api/claude/threads', (route) => route.fulfill({ json: { threads: [] } }))
  await page.route('**/api/claude/events', events ?? ((route) => route.fulfill({ status: 204 })))
  await page.route('**/api/claude/answer', answer)
  await page.goto('/')
  await expect(page.locator('.canvas-container > div[tabindex]')).toBeVisible()
  await expect.poll(() => page.evaluate((id) => Boolean((window as any).canvcode.editor.getNode(id)), noteId)).toBe(true)
  return noteId
}

// ノードの真ん中の画面の位置（ブラウザのウィンドウ基準）
async function centerOf(page: Page, id: string): Promise<{ x: number; y: number }> {
  const box = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  const at = await page.evaluate((id) => {
    const editor = (window as any).canvcode.editor
    const bounds = editor.index.get(id).worldBounds
    const camera = editor.session.get().camera
    return { x: (bounds.x + bounds.w / 2 - camera.x) * camera.zoom, y: (bounds.y + bounds.h / 2 - camera.y) * camera.zoom }
  }, id)
  return { x: box.x + at.x, y: box.y + at.y }
}

// 付箋の文字のノードを足す（id を返す）。ai を渡すと AI 付箋にする
const addNote = (page: Page, text: string, at: { x: number; y: number }, ai?: unknown) =>
  page.evaluate(
    ({ text, at, ai }) => {
      const editor = (window as any).canvcode.editor
      const node = editor.makeNode('note', { ...at, props: { paragraphs: [{ runs: [{ text }] }] } })
      editor.createNodes([ai ? { ...node, meta: { ...node.meta, ai } } : node])
      return node.id as string
    },
    { text, at, ai },
  )

// NDJSON の答え（行を並べる）
const ndjson = (route: Route, lines: unknown[]) => route.fulfill({ body: lines.map((line) => JSON.stringify(line)).join('\n') + '\n', contentType: 'application/x-ndjson' })

// 付箋で聞いている質問の終わりの知らせ（POST /api/claude/questions/<id>/finish）を集める
async function finishes(page: Page): Promise<{ id: string; body: unknown }[]> {
  const sent: { id: string; body: unknown }[] = []
  await page.route('**/api/claude/questions/*/finish', async (route) => {
    sent.push({ id: route.request().url().split('/').at(-2)!, body: route.request().postDataJSON() })
    await route.fulfill({ status: 204 })
  })
  return sent
}

const canvasIdOf = (page: Page) => page.evaluate(() => (window as any).canvcode.editor.canvasId as string)

// 付箋の meta.ai.answer
const answerOf = (page: Page, id: string) => page.evaluate((id) => (window as any).canvcode.editor.getNode(id)?.meta?.ai?.answer ?? null, id)

// Canvas のノードの型（入れ子の中も）
const nodeTypes = (page: Page) =>
  page.evaluate(() => {
    const editor = (window as any).canvcode.editor
    return [...editor.index.nodeIds()].map((id: string) => editor.getNode(id).type).sort() as string[]
  })

async function askWithMenu(page: Page, noteId: string) {
  const note = await centerOf(page, noteId)
  await page.mouse.click(note.x, note.y)
  await page.mouse.click(note.x, note.y, { button: 'right' })
  await page.locator('.context-menu button', { hasText: /^Claude に聞く$/ }).click()
}

test('付箋で聞くと、答えを付箋に書く（キャンバスには置かない）。近くの付箋を候補に送り、Undo で答えが消える', async ({ page }) => {
  const sent: any[] = []
  let release: (() => void) | undefined
  let nearId = ''
  const noteId = await openApp(page, async (route) => {
    sent.push(route.request().postDataJSON())
    await new Promise<void>((resolve) => (release = resolve))
    await route.fulfill({ json: { ...ANSWER, related: [nearId] } })
  })
  nearId = await addNote(page, '近くの付箋', { x: 600, y: 300 })
  const before = await nodeTypes(page)
  await askWithMenu(page, noteId)

  // 答えを作っている間は、付箋の角の三角が点滅する
  await expect.poll(() => page.evaluate((id) => (window as any).canvcode.editor.session.get().answeringIds.has(id), noteId)).toBe(true)
  await expect.poll(() => Boolean(release)).toBe(true)
  expect(sent[0]).toEqual({
    question: QUESTION,
    candidates: [{ id: nearId, text: '近くの付箋' }],
    source: { noteId, canvasId: await canvasIdOf(page), label: QUESTION },
  })
  release!()

  await expect.poll(() => answerOf(page, noteId)).toMatchObject({ body: ANSWER.body, related: [nearId], model: ANSWER.model, question: QUESTION })
  await expect.poll(() => page.evaluate((id) => (window as any).canvcode.editor.session.get().answeringIds.has(id), noteId)).toBe(false)
  // 答えのフレームも矢印も置かない
  expect(await nodeTypes(page)).toEqual(before)

  // 答えを書いたことは Undo 1 回で戻る
  await page.keyboard.press('Control+z')
  await expect.poll(() => answerOf(page, noteId)).toBeNull()
})

test('答えが届いたとき付箋の文字を編集していたら、編集を終えてから書き、書いたことをサーバーに知らせる', async ({ page }) => {
  let release: (() => void) | undefined
  const noteId = await openApp(page, async (route) => {
    await new Promise<void>((resolve) => (release = resolve))
    await ndjson(route, [{ type: 'start', id: 'q-1' }, { type: 'answer', answer: ANSWER }])
  })
  const finished = await finishes(page)
  await askWithMenu(page, noteId)
  await expect.poll(() => Boolean(release)).toBe(true)
  const note = await centerOf(page, noteId)
  await page.mouse.dblclick(note.x, note.y)
  await expect(page.locator('.canvcode-text-editor')).toBeFocused()
  release!()
  await expect(page.getByText('Claude の答えができました。編集を終えると付箋に書きます')).toBeVisible()
  expect(await answerOf(page, noteId)).toBeNull()
  expect(finished).toEqual([])
  await page.keyboard.press('Escape')
  await expect.poll(() => answerOf(page, noteId)).toMatchObject({ body: ANSWER.body, question: QUESTION })
  await expect.poll(() => finished).toEqual([{ id: 'q-1', body: { status: 'done' } }])
})

test('付箋に書く前に、ほかのタブで止められたら（SSE の question-done が cancelled）、書かない', async ({ page }) => {
  let release: (() => void) | undefined
  let stop: (() => void) | undefined
  const stopped = new Promise<void>((resolve) => (stop = resolve))
  const noteId = await openApp(
    page,
    async (route) => {
      await new Promise<void>((resolve) => (release = resolve))
      await ndjson(route, [{ type: 'start', id: 'q-2' }, { type: 'answer', answer: ANSWER }])
    },
    async (route) => {
      // つないだ SSE に、止めた知らせを流す（そのあとは閉じる）
      await stopped
      const messages = [{ type: 'snapshot', threads: [], running: [], questions: [] }, { type: 'question-done', id: 'q-2', status: 'cancelled' }]
      await route.fulfill({ body: messages.map((m) => `data: ${JSON.stringify(m)}\n\n`).join(''), contentType: 'text/event-stream', headers: { 'cache-control': 'no-store' } })
    },
  )
  const finished = await finishes(page)
  await askWithMenu(page, noteId)
  await expect.poll(() => Boolean(release)).toBe(true)
  // 文字を編集している間に答えが届き、付箋に書くのを待っている
  const note = await centerOf(page, noteId)
  await page.mouse.dblclick(note.x, note.y)
  await expect(page.locator('.canvcode-text-editor')).toBeFocused()
  release!()
  await expect(page.getByText('Claude の答えができました。編集を終えると付箋に書きます')).toBeVisible()
  stop!()
  await expect(page.getByText('Claude に頼むのをやめました')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect.poll(() => finished).toEqual([{ id: 'q-2', body: { status: 'cancelled' } }])
  expect(await answerOf(page, noteId)).toBeNull()
})

// 付箋の右上の角（三角）の画面の位置（ブラウザのウィンドウ基準。角から inset だけ内側。
// 選んでいる付箋では、角から 8px までは選択枠のハンドルが先に当たるので、既定は 10px 内側）
async function cornerOf(page: Page, id: string, inset = 10): Promise<{ x: number; y: number }> {
  const box = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  const at = await page.evaluate(
    ({ id, inset }) => {
      const editor = (window as any).canvcode.editor
      const bounds = editor.index.get(id).worldBounds
      const camera = editor.session.get().camera
      return { x: (bounds.x + bounds.w - camera.x) * camera.zoom - inset, y: (bounds.y - camera.y) * camera.zoom + inset }
    },
    { id, inset },
  )
  return { x: box.x + at.x, y: box.y + at.y }
}

// 答えを持つ付箋にする（Claude に聞かずに）
const giveAnswer = (page: Page, id: string, answer: Record<string, unknown>) =>
  page.evaluate(
    ({ id, answer }) => {
      const editor = (window as any).canvcode.editor
      const node = editor.getNode(id)
      editor.transact('answer', (tx: any) => tx.put({ ...node, meta: { ...node.meta, ai: { contexts: [], answer } } }))
    },
    { id, answer },
  )

// 同じ三角を続けて押す（500ms のうちの 2 回目はダブルクリックとして押さない）
const again = (page: Page) => page.waitForTimeout(550)

const selection = (page: Page) => page.evaluate(() => [...(window as any).canvcode.editor.session.get().selectedIds] as string[])

test('角の三角で、付箋の横に答えのパネルを開く。関連する付箋へ移れる。もう一度押すと閉じ、Esc でも閉じる', async ({ page }) => {
  const noteId = await openApp(page, (route) => route.fulfill({ json: ANSWER }))
  const nearId = await addNote(page, '付箋をインプットとする方向性はよかった', { x: 300, y: 700 })
  await giveAnswer(page, noteId, { ...ANSWER, related: [nearId, 'node:gone'], effort: 'high', question: QUESTION, answeredAt: 1 })
  const corner = await cornerOf(page, noteId)
  await page.mouse.move(corner.x, corner.y)
  await expect.poll(() => page.evaluate(() => (window as any).canvcode.editor.session.get().hoveredAiCorner)).toBe(noteId)
  await page.mouse.click(corner.x, corner.y)
  const popover = page.locator('.answer-popover')
  await expect(popover).toBeVisible()
  await expect(popover).toBeFocused()
  // 付箋は選ばない。付箋の右に出る
  expect(await selection(page)).toEqual([])
  expect((await popover.boundingBox())!.x).toBeGreaterThan(corner.x)
  await expect(popover.locator('.answer-popover-head')).toContainText('回答')
  await expect(popover.locator('.answer-popover-model')).not.toBeEmpty()
  await expect(popover.locator('.answer-view-body strong')).toHaveText('Xcode')
  await expect(popover.locator('.answer-view-body li')).toHaveText('まず App Store から Xcode を入れる')
  // 関連する付箋：消えた付箋は出さない
  await expect(popover.locator('.answer-view-related-note')).toHaveText(['↗ 付箋をインプットとする方向性はよかった'])
  // 答えにフォーカスがある間は、付箋の下の欄を出す
  await expect(page.locator('.ai-note-controls')).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('answer-popover.png') })

  // もう一度押すと閉じる
  await again(page)
  await page.mouse.click(corner.x, corner.y)
  await expect(popover).toHaveCount(0)
  await expect(page.locator('.ai-note-controls')).toHaveCount(0)
  // Esc でも閉じる
  await again(page)
  await page.mouse.click(corner.x, corner.y)
  await expect(popover).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(popover).toHaveCount(0)
  // 外のキャンバスを押しても閉じる
  await again(page)
  await page.mouse.click(corner.x, corner.y)
  await expect(popover).toBeVisible()
  await page.mouse.click(corner.x - 400, corner.y + 200)
  await expect(popover).toHaveCount(0)

  // 関連する付箋を押すと、その付箋へ移って選ぶ（パネルは閉じる）
  await again(page)
  await page.mouse.click(corner.x, corner.y)
  await popover.locator('.answer-view-related-note').click()
  await expect(popover).toHaveCount(0)
  await expect.poll(() => selection(page)).toEqual([nearId])
})

test('縮小しても、三角の当たり判定は画面で 24px あり、答えのパネルが開く', async ({ page }) => {
  const noteId = await openApp(page, (route) => route.fulfill({ json: ANSWER }))
  await giveAnswer(page, noteId, { ...ANSWER, question: QUESTION, answeredAt: 1 })
  await page.evaluate(() => (window as any).canvcode.editor.session.set({ camera: { x: 0, y: 0, zoom: 0.5 } }))
  // 三角はワールドで 22（画面で 11px）だが、角から 13px 内側でも当たる（付箋の短い辺の半分まで）
  const corner = await cornerOf(page, noteId, 13)
  await page.mouse.click(corner.x, corner.y)
  await expect(page.locator('.answer-popover')).toBeVisible()
})

test('答えのパネルの「Canvasに残す」で、答えを書式付きのテキストにして付箋の右に置く。Undo 1 回で消える', async ({ page }) => {
  const noteId = await openApp(page, (route) => route.fulfill({ json: ANSWER }))
  await giveAnswer(page, noteId, { ...ANSWER, question: QUESTION, answeredAt: 1 })
  const before = await nodeTypes(page)
  const corner = await cornerOf(page, noteId)
  await page.mouse.click(corner.x, corner.y)
  await page.locator('.answer-view-keep').click()
  await expect(page.locator('.answer-popover')).toHaveCount(0)
  await expect.poll(() => nodeTypes(page)).toEqual([...before, 'arrow', 'text'].sort())
  const placed = await page.evaluate(() => {
    const editor = (window as any).canvcode.editor
    const id = [...editor.session.get().selectedIds][0] as string
    const node = editor.getNode(id)
    return { type: node.type, text: node.props.paragraphs.map((p: any) => p.runs.map((r: any) => r.text).join('')) }
  })
  expect(placed).toEqual({ type: 'text', text: ['前提：iOS アプリを作る', '', 'Xcode を入れれば、開発環境はほぼ整う。', '', 'まず App Store から Xcode を入れる'] })
  await page.keyboard.press('Control+z')
  await expect.poll(() => nodeTypes(page)).toEqual(before)
})

test('「続けて聞く」で、元の付箋の下に札付きの AI 付箋を置いて書き始め、送ると前の質問と答えを送る', async ({ page }) => {
  const sent: any[] = []
  const FOLLOW = { body: 'Xcode は無料です。', related: [], model: 'claude-sonnet-5-5' }
  const noteId = await openApp(page, async (route) => {
    sent.push(route.request().postDataJSON())
    await route.fulfill({ json: FOLLOW })
  })
  await giveAnswer(page, noteId, { ...ANSWER, question: QUESTION, answeredAt: 1 })
  const corner = await cornerOf(page, noteId)
  await page.mouse.click(corner.x, corner.y)
  await page.locator('.answer-view-continue').click()
  await expect(page.locator('.answer-popover')).toHaveCount(0)
  // 文字の編集が始まっている。付箋の上に前の答えの札、下に欄
  await expect(page.locator('.canvcode-text-editor')).toBeFocused()
  await expect(page.locator('.ai-note-chip')).toContainText('「swiftの開発環境ってどうやって整えたら良いの?」の答え')
  await expect(page.locator('.ai-note-chip button')).toHaveText('↗ 元の付箋')
  await expect(page.locator('.ai-note-controls')).toBeVisible()
  await page.keyboard.type('Xcode は無料？')
  await page.keyboard.press('Control+Enter')
  const followId = await page.evaluate((noteId) => {
    const editor = (window as any).canvcode.editor
    return [...editor.index.nodeIds()].find((id: string) => id !== noteId && editor.getNode(id).meta?.ai?.contexts?.length) as string
  }, noteId)
  await expect.poll(() => answerOf(page, followId)).toMatchObject({ body: 'Xcode は無料です。', question: 'Xcode は無料？' })
  expect(sent[0]).toMatchObject({ question: 'Xcode は無料？', previous: [{ question: QUESTION, answer: ANSWER.body }] })
  // 続きの付箋は元の付箋の下
  const boxes = await page.evaluate(
    ([a, b]) => {
      const editor = (window as any).canvcode.editor
      return [editor.index.get(a).worldBounds, editor.index.get(b).worldBounds]
    },
    [noteId, followId],
  )
  expect(boxes[1].y).toBeGreaterThan(boxes[0].y + boxes[0].h)
  await page.screenshot({ path: test.info().outputPath('follow-up.png') })
  // 札の ↗ で元の付箋へ移り、その答えを開く
  await page.locator('.ai-note-chip button').click()
  await expect(page.locator('.answer-popover')).toBeVisible()
  await expect.poll(() => selection(page)).toEqual([noteId])
})

test('付箋の下の欄は、AI 付箋を選んでいるときだけ出す。アイコンを押して、ほかのノードをクリックすると添える', async ({ page }) => {
  const noteId = await openApp(page, (route) => route.fulfill({ json: ANSWER }))
  const otherId = await addNote(page, '添える付箋', { x: 700, y: 300 })
  await page.evaluate((id) => {
    const editor = (window as any).canvcode.editor
    const node = editor.getNode(id)
    editor.transact('ai', (tx: any) => tx.put({ ...node, meta: { ...node.meta, ai: { contexts: [] } } }))
  }, noteId)
  await expect(page.locator('.ai-note-controls')).toHaveCount(0)
  const note = await centerOf(page, noteId)
  await page.mouse.click(note.x, note.y)
  await expect(page.locator('.ai-note-controls')).toBeVisible()
  await expect(page.locator('.ai-note-attach-count')).toHaveCount(0)
  await page.locator('.ai-note-attach').click()
  await expect(page.locator('.ai-note-picking')).toBeVisible()
  const other = await centerOf(page, otherId)
  await page.mouse.click(other.x, other.y)
  // 添えて、付箋を選び直す
  await expect(page.locator('.ai-note-attach-count')).toHaveText('1')
  await expect.poll(() => selection(page)).toEqual([noteId])
  await page.locator('.ai-note-attach-count').click()
  await expect(page.locator('.ai-note-context')).toContainText('1 個のノード')
  await page.locator('.ai-note-controls').screenshot({ path: test.info().outputPath('ai-note-controls.png') })
  // 何もない所をクリックすると、欄は消える
  await page.mouse.click(note.x - 150, note.y + 350)
  await expect(page.locator('.ai-note-controls')).toHaveCount(0)
})

test('答えを作っている間は、三角のパネルに進み具合と「やめる」を出し、やめられる', async ({ page }) => {
  let release: (() => void) | undefined
  const noteId = await openApp(page, async (route) => {
    await new Promise<void>((resolve) => (release = resolve))
    await route.fulfill({ json: ANSWER }).catch(() => undefined)
  })
  await askWithMenu(page, noteId)
  await expect.poll(() => Boolean(release)).toBe(true)
  await expect.poll(() => page.evaluate((id) => (window as any).canvcode.editor.session.get().answeringIds.has(id), noteId)).toBe(true)
  const corner = await cornerOf(page, noteId)
  await page.mouse.click(corner.x, corner.y)
  const popover = page.locator('.answer-popover')
  await expect(popover.locator('.answer-view-step.current')).toHaveText(/読む/)
  await popover.locator('.answer-view-stop').click()
  await expect(page.getByText('Claude に頼むのをやめました')).toBeVisible()
  await expect.poll(() => page.evaluate((id) => (window as any).canvcode.editor.session.get().answeringIds.has(id), noteId)).toBe(false)
  release!()
  expect(await answerOf(page, noteId)).toBeNull()
})

test('続きの付箋は前の質問と答えを送る。付箋の答えの記録で考えた中身を見て、付箋へ移ると答えが開く', async ({ page }) => {
  const sent: any[] = []
  const FOLLOW = { body: 'Xcode は無料です。', related: [], model: 'claude-sonnet-5-5' }
  const noteId = await openApp(page, async (route) => {
    sent.push(route.request().postDataJSON())
    // NDJSON（進み具合と考えている中身のあとに答え）
    await ndjson(route, [
      { type: 'step', step: 'read' },
      { type: 'thinking', text: '前の答えで Xcode を勧めた。' },
      { type: 'thinking', text: '値段を答える。' },
      { type: 'step', step: 'search' },
      // サーバーが混ぜる、調べている語・読んでいるページ（間に空の行が入る）
      { type: 'thinking', text: '\n\n― Web で調べる：Xcode 値段\n\n\n\n― ページを読む：https://developer.apple.com/xcode/\n\n' },
      { type: 'thinking', text: '無料だとわかった。' },
      { type: 'step', step: 'write' },
      { type: 'answer', answer: FOLLOW },
    ])
  })
  const canvasId = await canvasIdOf(page)
  const turns = [{ question: QUESTION, answer: ANSWER.body }]
  const followId = await addNote(page, 'Xcode は無料？', { x: 300, y: 600 }, { contexts: [{ kind: 'answer', noteId, canvasId, label: 'swiftの開発環境', turns }] })
  const before = await nodeTypes(page)
  const follow = await centerOf(page, followId)
  await page.mouse.click(follow.x, follow.y)
  await page.locator('.ai-note-send').click()

  await expect.poll(() => answerOf(page, followId)).toMatchObject({ body: 'Xcode は無料です。', question: 'Xcode は無料？' })
  expect(sent[0]).toEqual({
    question: 'Xcode は無料？',
    previous: turns,
    candidates: [{ id: noteId, text: QUESTION }],
    source: { noteId: followId, canvasId, label: 'Xcode は無料？' },
  })
  // 答えを書いても AI 付箋のまま（前の答えの札も残る）
  expect(await page.evaluate((id) => (window as any).canvcode.editor.getNode(id).meta.ai.contexts.length, followId)).toBe(1)
  expect(await nodeTypes(page)).toEqual(before)

  // 右上の「Claude」で開く付箋の答えの記録に、回答終了の行。押すと考えた中身だけを見る。「答えへ移る」で、答えを書いた付箋へ移り、答えを開く
  await page.locator('.claude-toggle').click()
  await expect(page.locator('.answer-panel')).toBeVisible()
  const row = page.locator('.answer-row', { hasText: '続き：Xcode は無料？' })
  await expect(row).toContainText('回答終了')
  await row.locator('.answer-row-main').click()
  // 段落と、調べている行のまとまりに分けて出す（間の空の行は詰める）
  await expect(page.locator('.answer-panel .answer-thinking > p')).toHaveText(['前の答えで Xcode を勧めた。値段を答える。', '無料だとわかった。'])
  await expect(page.locator('.answer-panel .answer-thinking-tool > div')).toHaveText(['Web で調べる：Xcode 値段', 'ページを読む：https://developer.apple.com/xcode/'])
  await page.locator('.answer-thinking-head button', { hasText: '← 一覧に戻る' }).click()
  await row.locator('.answer-row-jump').click()
  await expect.poll(() => selection(page)).toEqual([followId])
  await expect(page.locator('.answer-popover .answer-view-body')).toHaveText('Xcode は無料です。')
})
