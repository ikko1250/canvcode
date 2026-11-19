import { expect, test, type Locator, type Page, type Route } from '@playwright/test'

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
  // 答えを持つ付箋の一覧（質問のタブ）。ほかの Canvas のものはない
  await page.route('**/api/claude/questions*', (route) => route.fulfill({ json: { questions: [] } }))
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

test('編集の途中（トランザクションが開いている）なら、「続けて聞く」は断り、パネルを閉じない', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const noteId = await openApp(page, (route) => route.fulfill({ json: ANSWER }))
  await giveAnswer(page, noteId, { ...ANSWER, question: QUESTION, answeredAt: 1 })
  const before = await nodeTypes(page)
  const corner = await cornerOf(page, noteId)
  await page.mouse.click(corner.x, corner.y)
  // ドラッグの途中や、文字の編集をよそへ預けているときのように、トランザクションを開いておく
  await page.evaluate(() => ((window as any).openTx = (window as any).canvcode.editor.begin('ドラッグ')))
  await page.locator('.answer-view-continue').click()
  await expect(page.getByText('編集を終えてから押してください')).toBeVisible()
  await expect(page.locator('.answer-popover')).toBeVisible()
  expect(await nodeTypes(page)).toEqual(before)
  expect(errors).toEqual([])
  // 編集を終えたら押せる
  await page.evaluate(() => (window as any).openTx.cancel())
  await page.locator('.answer-view-continue').click()
  await expect(page.locator('.canvcode-text-editor')).toBeFocused()
  expect(errors).toEqual([])
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

test('角の三角で開いたとき（付箋は選ばない）も、付箋の下の欄のボタンを押せる。欄からほかへフォーカスが移ったら欄を消す', async ({ page }) => {
  const sent: any[] = []
  let release: (() => void) | undefined
  const noteId = await openApp(page, async (route) => {
    sent.push(route.request().postDataJSON())
    await new Promise<void>((resolve) => (release = resolve))
    await route.fulfill({ json: { ...ANSWER, body: '二度目の答え' } })
  })
  await giveAnswer(page, noteId, { ...ANSWER, question: QUESTION, answeredAt: 1 })
  const corner = await cornerOf(page, noteId)
  const popover = page.locator('.answer-popover')
  const controls = page.locator('.ai-note-controls')
  await page.mouse.click(corner.x, corner.y)
  await expect(popover).toBeFocused()
  expect(await selection(page)).toEqual([])
  // モデルの札：押すとフォーカスが欄へ移るが、欄は消えずに、モデルを選ぶ欄が開く。Esc で閉じる
  await controls.locator('.claude-model-button').click()
  await expect(controls.locator('.claude-model-popover')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(controls.locator('.claude-model-popover')).toHaveCount(0)
  await expect(popover).toBeVisible()
  // 欄からパネルへ戻っても、欄は出たまま
  await popover.locator('.answer-popover-head').click()
  await expect(popover).toBeFocused()
  await expect(controls).toBeVisible()
  // 欄からほか（キャンバス）へフォーカスが移ったら、欄を消す（パネルは開いたまま）
  await controls.locator('.claude-model-button').focus()
  await page.locator('.canvas-container > div[tabindex]').focus()
  await expect(controls).toHaveCount(0)
  await expect(popover).toBeVisible()

  // 送信：もう一度聞いて、答えを書き直す。答えを作っている間、送信は押せなくなり（フォーカスは落ちる）、欄は出したまま
  await popover.focus()
  await controls.locator('.ai-note-send').click()
  await expect.poll(() => Boolean(release)).toBe(true)
  await expect(controls.locator('.ai-note-send')).toBeDisabled()
  await page.waitForTimeout(200)
  await expect(controls).toBeVisible()
  release!()
  await expect.poll(() => answerOf(page, noteId)).toMatchObject({ body: '二度目の答え' })
  await expect(controls).toBeVisible()
  expect(sent).toHaveLength(1)

  // 添える所を選ぶ：押すと選ぶ状態になる
  await page.mouse.click(corner.x - 400, corner.y + 200)
  await expect(popover).toHaveCount(0)
  await again(page)
  await page.mouse.click(corner.x, corner.y)
  await expect(popover).toBeFocused()
  await controls.locator('.ai-note-attach').click()
  await expect(controls.locator('.ai-note-picking')).toBeVisible()
})

test('付箋に添えられる所は 5 か所まで。それより多く添えてある付箋は、送らずにわけを出す', async ({ page }) => {
  const sent: any[] = []
  const noteId = await openApp(page, async (route) => {
    sent.push(route.request().postDataJSON())
    await route.fulfill({ json: ANSWER })
  })
  const place = (i: number) => ({ kind: 'canvas', label: `範囲 ${i}`, target: { kind: 'canvas', canvasId: 'canvas:input-test', rect: { x: i * 10, y: 0, w: 5, h: 5 }, nodes: [] } })
  const giveContexts = (count: number) =>
    page.evaluate(
      ({ id, contexts }) => {
        const editor = (window as any).canvcode.editor
        const node = editor.getNode(id)
        editor.transact('ai', (tx: any) => tx.put({ ...node, meta: { ...node.meta, ai: { contexts } } }))
      },
      { id: noteId, contexts: Array.from({ length: count }, (_, i) => place(i)) },
    )
  // 5 か所添えてあれば、もう添えられない（選ぶ状態にしない）
  await giveContexts(5)
  const note = await centerOf(page, noteId)
  await page.mouse.click(note.x, note.y)
  await expect(page.locator('.ai-note-attach-count')).toHaveText('5')
  await page.locator('.ai-note-attach').click()
  await expect(page.getByText('添えられる所は 5 か所までです')).toBeVisible()
  await expect(page.locator('.ai-note-picking')).toHaveCount(0)
  // 前から 6 か所添えてあった付箋は、送らずにわけを出す
  await giveContexts(6)
  await page.locator('.ai-note-send').click()
  await expect(page.getByText('添えた所が多すぎます（5 か所まで）')).toBeVisible()
  expect(sent).toEqual([])
})

// 前の答えを添えた AI 付箋にする（付箋の上に札が出る）
const giveFollowUp = (page: Page, id: string) =>
  page.evaluate((id) => {
    const editor = (window as any).canvcode.editor
    const node = editor.getNode(id)
    const context = { kind: 'answer', noteId: 'node:gone', canvasId: 'canvas:input-test', label: '前の質問', turns: [{ question: '前の質問', answer: '前の答え' }] }
    editor.transact('ai', (tx: any) => tx.put({ ...node, meta: { ...node.meta, ai: { ...node.meta?.ai, contexts: [context] } } }))
  }, id)

const cameraOf = (page: Page) => page.evaluate(() => (window as any).canvcode.editor.session.get().camera as { x: number; y: number; zoom: number })

async function hover(page: Page, locator: Locator): Promise<void> {
  const box = (await locator.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
}

test('付箋の上の札・下の欄の上でも、ホイールでパン、Ctrl+ホイールでズームする（モデルを選ぶ欄の上は除く）。文字を編集している付箋の上でもパンする', async ({ page }) => {
  const noteId = await openApp(page, (route) => route.fulfill({ json: ANSWER }))
  await giveFollowUp(page, noteId)
  const note = await centerOf(page, noteId)
  await page.mouse.click(note.x, note.y)
  const controls = page.locator('.ai-note-controls')
  await expect(controls).toBeVisible()
  // 欄のボタンの上：パン
  await hover(page, controls.locator('.ai-note-attach'))
  let before = await cameraOf(page)
  await page.mouse.wheel(0, 120)
  await expect.poll(async () => (await cameraOf(page)).y).not.toBe(before.y)
  // 札の上：パン
  await hover(page, page.locator('.ai-note-chip'))
  before = await cameraOf(page)
  await page.mouse.wheel(0, 120)
  await expect.poll(async () => (await cameraOf(page)).y).not.toBe(before.y)
  // Ctrl+ホイール（トラックパッドのピンチ）：ズーム
  await hover(page, controls.locator('.ai-note-send'))
  before = await cameraOf(page)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -120)
  await page.keyboard.up('Control')
  await expect.poll(async () => (await cameraOf(page)).zoom).toBeGreaterThan(before.zoom)
  // モデルを選ぶ欄（ダイアログ）の上では、キャンバスを動かさない
  await controls.locator('.claude-model-button').click()
  const picker = controls.locator('.claude-model-popover')
  await expect(picker).toBeVisible()
  await hover(page, picker)
  before = await cameraOf(page)
  await page.mouse.wheel(0, 120)
  await page.waitForTimeout(200)
  expect(await cameraOf(page)).toEqual(before)
  await page.keyboard.press('Escape')

  // 文字を編集している付箋の上：パンする（編集は続ける）
  const editing = await centerOf(page, noteId)
  await page.mouse.dblclick(editing.x, editing.y)
  const textEditor = page.locator('.canvcode-text-editor')
  await expect(textEditor).toBeFocused()
  await hover(page, textEditor)
  before = await cameraOf(page)
  await page.mouse.wheel(0, 120)
  await expect.poll(async () => (await cameraOf(page)).y).not.toBe(before.y)
  await expect(textEditor).toBeFocused()
})

test('付箋の上の札・下の欄・横の答えのパネルは、デザインパネルの下に出る', async ({ page }) => {
  const noteId = await openApp(page, (route) => route.fulfill({ json: ANSWER }))
  // 答えを持たせてから、前の答えを添える（giveAnswer は添えたものを空にする）
  await giveAnswer(page, noteId, { ...ANSWER, question: QUESTION, answeredAt: 1 })
  await giveFollowUp(page, noteId)
  // 答えのパネルを開き、付箋を選んで（デザインパネルが出る）、付箋をデザインパネルの下へ動かす
  const corner = await cornerOf(page, noteId)
  await page.mouse.click(corner.x, corner.y)
  await expect(page.locator('.answer-popover')).toBeVisible()
  await page.evaluate((id) => (window as any).canvcode.editor.setSelection([id]), noteId)
  const panel = page.getByTestId('design-panel')
  await expect(panel).toBeVisible()
  await expect(page.locator('.ai-note-controls')).toBeVisible()
  await page.evaluate((id) => {
    const editor = (window as any).canvcode.editor
    const bounds = editor.index.get(id).worldBounds
    const root = document.querySelector('.canvas-container > div[tabindex]')!.getBoundingClientRect()
    const box = document.querySelector('[data-testid="design-panel"]')!.getBoundingClientRect()
    const { zoom } = editor.session.get().camera
    // 付箋の左上を、デザインパネルの左上から少し内側へ
    editor.session.set({ camera: { x: bounds.x - (box.left + 24 - root.left) / zoom, y: bounds.y - (box.top + 80 - root.top) / zoom, zoom } })
  }, noteId)
  // 重なった所の真ん中で、いちばん上にあるのはデザインパネル
  const covered = (selector: string) =>
    page.evaluate((selector) => {
      const a = document.querySelector(selector)!.getBoundingClientRect()
      const b = document.querySelector('[data-testid="design-panel"]')!.getBoundingClientRect()
      const left = Math.max(a.left, b.left)
      const right = Math.min(a.right, b.right)
      const top = Math.max(a.top, b.top)
      const bottom = Math.min(a.bottom, b.bottom)
      if (right <= left || bottom <= top) return 'no overlap'
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2)
      return hit?.closest('[data-testid="design-panel"]') ? 'panel' : (hit?.className ?? 'nothing')
    }, selector)
  // 欄はボタンのない所をキャンバスに通す（pointer-events: none）ので、ボタンで確かめる
  expect(await covered('.ai-note-controls .ai-note-attach')).toBe('panel')
  expect(await covered('.ai-note-controls .ai-note-send')).toBe('panel')
  expect(await covered('.ai-note-chips')).toBe('panel')
  expect(await covered('.answer-popover')).toBe('panel')
})

test('AI 付箋の文字を編集している間、書式のツールバー（BIUS）は縦に並べて付箋の左に出す（上の札・下の欄と重ならない）。ふつうの付箋では上に横に出す', async ({ page }) => {
  const noteId = await openApp(page, (route) => route.fulfill({ json: ANSWER }))
  await giveFollowUp(page, noteId)
  const otherId = await addNote(page, 'ふつうの付箋', { x: 700, y: 300 })
  const note = await centerOf(page, noteId)
  await page.mouse.dblclick(note.x, note.y)
  await expect(page.locator('.canvcode-text-editor')).toBeFocused()
  const toolbar = page.getByTestId('text-format-toolbar')
  await expect(toolbar).toHaveClass(/vertical/)
  await expect(toolbar).toHaveAttribute('aria-orientation', 'vertical')
  const box = (await toolbar.boundingBox())!
  const noteBox = await page.evaluate((id) => {
    const editor = (window as any).canvcode.editor
    const bounds = editor.index.get(id).worldBounds
    const camera = editor.session.get().camera
    const root = document.querySelector('.canvas-container > div[tabindex]')!.getBoundingClientRect()
    return { x: root.left + (bounds.x - camera.x) * camera.zoom, y: root.top + (bounds.y - camera.y) * camera.zoom }
  }, noteId)
  expect(box.x + box.width).toBeLessThanOrEqual(noteBox.x)
  expect(box.height).toBeGreaterThan(box.width)
  for (const selector of ['.ai-note-chips', '.ai-note-controls']) {
    const other = (await page.locator(selector).boundingBox())!
    const overlaps = box.x < other.x + other.width && other.x < box.x + box.width && box.y < other.y + other.height && other.y < box.y + box.height
    expect(overlaps, selector).toBe(false)
  }
  await page.screenshot({ path: test.info().outputPath('ai-note-format-toolbar.png') })
  await page.keyboard.press('Escape')
  // ふつうの付箋：上に横に出す
  const other = await centerOf(page, otherId)
  await page.mouse.dblclick(other.x, other.y)
  await expect(page.locator('.canvcode-text-editor')).toBeFocused()
  await expect(toolbar).not.toHaveClass(/vertical/)
  const flat = (await toolbar.boundingBox())!
  expect(flat.width).toBeGreaterThan(flat.height)
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

test('質問のタブに、この画面で聞いた質問が「過去の回答」として並ぶ。開くと答えを見て、見た印が付き、「↗ 付箋へ移動」で付箋の答えを開く', async ({ page }) => {
  const sent: any[] = []
  const FOLLOW = { body: 'Xcode は無料です。', related: [], model: 'claude-sonnet-5-5' }
  const noteId = await openApp(page, async (route) => {
    sent.push(route.request().postDataJSON())
    // NDJSON（進み具合と考えている中身のあとに答え）
    await ndjson(route, [
      { type: 'step', step: 'read' },
      { type: 'thinking', text: '前の答えで Xcode を勧めた。' },
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
  // 答えを書いても AI 付箋のまま（前の答えの札も残る）。キャンバスには何も置かない
  expect(await page.evaluate((id) => (window as any).canvcode.editor.getNode(id).meta.ai.contexts.length, followId)).toBe(1)
  expect(await nodeTypes(page)).toEqual(before)

  // 右上の「質問」で質問のタブ。まだ見ていない答えに青い点
  await page.locator('.claude-toggle').click()
  const panel = page.locator('.question-panel')
  await expect(panel).toBeVisible()
  const row = panel.locator('.question-row', { hasText: '「Xcode は無料？」' })
  await expect(row).toHaveClass(/unread/)
  await row.locator('.question-row-main').click()
  await expect(panel.locator('.question-detail-title')).toHaveText('「Xcode は無料？」')
  await expect(panel.locator('.answer-view-body')).toHaveText('Xcode は無料です。')
  await expect(panel.locator('.question-model')).toHaveText('Sonnet 5.5')
  await panel.screenshot({ path: test.info().outputPath('question-detail.png') })
  await panel.locator('.question-back').click()
  await expect(row).not.toHaveClass(/unread/)
  // 「↗ 付箋へ移動」で付箋を選び、付箋の横に答えを開く
  await row.locator('.question-row-main').click()
  await panel.locator('.question-open-note').click()
  await expect.poll(() => selection(page)).toEqual([followId])
  await expect(page.locator('.answer-popover .answer-view-body')).toHaveText('Xcode は無料です。')
})

test('ほかのタブ・Canvas の質問も並ぶ。動作中は進み具合と止めるボタン、ほかの Canvas の答えは「続けて聞く」で、いま開いている Canvas に札付きで置く', async ({ page }) => {
  const running = {
    id: '00000000-0000-0000-0000-000000000001',
    noteId: 'node:far1',
    canvasId: 'canvas:other',
    label: 'この関数の意味は？',
    model: 'claude-opus-5-5',
    effort: 'high',
    status: 'running',
    step: 'search',
    searched: true,
    thinking: '調べている',
    startedAt: Date.now() - 125_000,
  }
  const past = { noteId: 'node:far2', canvasId: 'canvas:other', canvasTitle: '研究ノート', question: 'Tkrzw-Dict の使い方は？', model: 'claude-opus-5-5', answeredAt: Date.now() - 3_600_000 }
  const answer = { body: '辞書を引く。', related: [], model: 'claude-opus-5-5', question: 'Tkrzw-Dict の使い方は？', answeredAt: past.answeredAt }
  await openApp(
    page,
    (route) => route.fulfill({ json: ANSWER }),
    (route) => route.fulfill({ body: `data: ${JSON.stringify({ type: 'snapshot', threads: [], running: [], questions: [running] })}\n\n`, contentType: 'text/event-stream' }),
  )
  const cancels: string[] = []
  await page.route('**/api/claude/questions', (route) => route.fulfill({ json: { questions: [past] } }))
  await page.route('**/api/claude/questions/node*', (route) => route.fulfill({ json: { ...past, ai: { contexts: [], answer }, related: [] } }))
  await page.route('**/api/claude/questions/*/cancel', async (route) => {
    cancels.push(route.request().url().split('/').at(-2)!)
    await route.fulfill({ status: 204 })
  })
  // 右上のボタンに、動いている質問の数
  await expect(page.locator('.claude-toggle')).toContainText('●1')
  await page.locator('.claude-toggle').click()
  const panel = page.locator('.question-panel')
  await expect(panel.getByRole('tab', { name: /質問/ })).toContainText('●1')
  const live = panel.locator('.question-row.running')
  await expect(live).toContainText('「この関数の意味は？」')
  await expect(live.locator('.question-row-meta')).toContainText('2分前')
  await expect(live.locator('.question-row-steps')).toHaveText('✓ 読む → ● 調べる → 書く')
  await panel.screenshot({ path: test.info().outputPath('question-list.png') })
  await live.locator('.question-row-stop').click()
  await expect.poll(() => cancels).toEqual([running.id])

  // ほかの Canvas の答え：サーバーから読んで見せる。「続けて聞く」は、いま開いている Canvas の画面の真ん中に、前の答えの札を添えて置く
  const row = panel.locator('.question-row', { hasText: '「Tkrzw-Dict の使い方は？」' })
  await expect(row).toContainText('研究ノート')
  await row.locator('.question-row-main').click()
  await expect(panel.locator('.answer-view-body')).toHaveText('辞書を引く。')
  await panel.locator('.answer-view-continue').click()
  await expect(page.locator('.canvcode-text-editor')).toBeFocused()
  await expect(page.locator('.ai-note-chip')).toContainText('「Tkrzw-Dict の使い方は？」の答え')
  const placed = await page.evaluate(() => {
    const editor = (window as any).canvcode.editor
    const id = [...editor.index.nodeIds()].find((child: string) => editor.getNode(child).meta?.ai?.contexts?.[0]?.noteId === 'node:far2') as string
    return editor.getNode(id).meta.ai.contexts[0]
  })
  expect(placed).toEqual({ kind: 'answer', noteId: 'node:far2', canvasId: 'canvas:other', label: 'Tkrzw-Dict の使い方は？', turns: [{ question: 'Tkrzw-Dict の使い方は？', answer: '辞書を引く。' }] })
})
