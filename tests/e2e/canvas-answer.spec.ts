import { expect, test, type Locator, type Page, type Route } from '@playwright/test'

// キャンバスの AI：AI 付箋は作業の指示（docs/ai-note-tasks-plan.md）。付箋の右クリックの「Claude に頼む」か AI 付箋の「送信」で、
// 付箋の文を指示にして POST /api/claude/note-tasks（ここでは差し替え）で頼む。近くの付箋を関連する付箋の候補として送り、
// 続きの付箋は添えた前の指示と報告を、前の作業がある付箋はその会話（lastThreadId）を送る。作業の間の様子は SSE（ここでは差し替え）で受け、
// 報告はサーバーが付箋の meta.ai.answer に書く（ここでは、ページの中で書いて代わりにする）。前の Q&A の答え（会話のない答え）も、そのまま読める
// （docs/canvas-answer-panel-plan.md）

const QUESTION = 'swiftの開発環境ってどうやって整えたら良いの?'
const ANSWER = { body: '前提：iOS アプリを作る\n\n**Xcode** を入れれば、開発環境はほぼ整う。\n\n- まず App Store から `Xcode` を入れる', related: [] as string[], model: 'claude-sonnet-5-5' }

async function openApp(page: Page, tasks: (route: Route) => Promise<void>, events?: (route: Route) => Promise<void>): Promise<string> {
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
  await page.route('**/api/claude/note-tasks', tasks)
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

// 付箋の作業のジョブ（サーバーの claude/jobs.ts の Job と同じ形）。会話の id はジョブの id
const THREAD = '11111111-2222-4333-8444-555555555555'
const taskJob = (noteId: string, canvasId: string, extra: Record<string, unknown> = {}) => ({
  id: THREAD,
  threadId: THREAD,
  prompt: QUESTION,
  status: 'running',
  createdAt: Date.now(),
  note: { noteId, canvasId },
  eventCount: 0,
  events: [] as unknown[],
  ...extra,
})
const taskThread = (noteId: string, canvasId: string, extra: Record<string, unknown> = {}) => ({
  threadId: THREAD,
  title: QUESTION,
  createdAt: 0,
  updatedAt: 0,
  jobCount: 1,
  running: true,
  note: { noteId, canvasId },
  noteOnly: true,
  tasks: [],
  permissions: [],
  ...extra,
})

// SSE（/api/claude/events）に流すもの。send した束は、そのときつないでいるすべての SSE に送り、つなぎを閉じる（EventSource はすぐ
// つなぎ直し、次の束を待つ）。開発のサーバーでは StrictMode で ClaudeClient が 2 つでき、それぞれがつなぐので、待っているもの全部に送る
function eventsChannel() {
  const batches: unknown[][] = []
  const waiters = new Set<() => void>()
  return {
    handler: async (route: Route) => {
      // つないだ時点より後に送った束を待つ
      const from = batches.length
      while (batches.length === from) await new Promise<void>((resolve) => waiters.add(resolve))
      const body = `retry: 50\n\n${batches
        .slice(from)
        .flat()
        .map((message) => `data: ${JSON.stringify(message)}\n\n`)
        .join('')}`
      await route.fulfill({ body, contentType: 'text/event-stream', headers: { 'cache-control': 'no-store' } }).catch(() => undefined)
    },
    send(...messages: unknown[]) {
      batches.push(messages)
      for (const wake of [...waiters]) wake()
      waiters.clear()
    },
  }
}

// 作業の報告（サーバーが付箋に書くもの。ページの中で書いて代わりにする。作業の途中の印も消す）
const giveReport = (page: Page, id: string, report: Record<string, unknown>) =>
  page.evaluate(
    ({ id, report }) => {
      const editor = (window as any).canvcode.editor
      const node = editor.getNode(id)
      const { task: _task, ...ai } = node.meta?.ai ?? { contexts: [] }
      editor.transact('report', (tx: any) => tx.put({ ...node, meta: { ...node.meta, ai: { contexts: [], ...ai, answer: report } } }))
    },
    { id, report },
  )
const REPORT = {
  body: '表を **3 列** で置きました。',
  related: [] as string[],
  model: 'claude-sonnet-5-5',
  question: QUESTION,
  answeredAt: 1,
  threadId: THREAD,
  jobId: THREAD,
  status: 'done',
  changes: { canvas: [{ batch: 'ai-111111111111', label: '表を置く', canvasId: 'canvas:input-test' }], files: ['notes/table.md'], commands: [] },
}

// 頼みを受ける差し替え：送ったもの（本文）を sent に足し、その付箋の作業のジョブを返す
const accepting = (sent: any[]) => async (route: Route) => {
  const body = route.request().postDataJSON()
  sent.push(body)
  await route.fulfill({ status: 201, json: { job: taskJob(body.noteId, body.canvasId, { prompt: body.instruction }) } })
}

const blinking = (page: Page, id: string) => page.evaluate((id) => (window as any).canvcode.editor.session.get().answeringIds.has(id) as boolean, id)

const canvasIdOf = (page: Page) => page.evaluate(() => (window as any).canvcode.editor.canvasId as string)

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
  await page.locator('.context-menu button', { hasText: /^Claude に頼む$/ }).click()
}

test('付箋で頼むと、付箋の文を指示にして近くの付箋と一緒に送る。作業の間は三角が点滅し、報告（サーバーが書く）は「作業」として読める', async ({ page }) => {
  const sent: any[] = []
  let release: (() => void) | undefined
  let nearId = ''
  const events = eventsChannel()
  const noteId = await openApp(
    page,
    async (route) => {
      sent.push(route.request().postDataJSON())
      await new Promise<void>((resolve) => (release = resolve))
      await route.fulfill({ status: 201, json: { job: taskJob(noteId, 'canvas:input-test') } })
    },
    events.handler,
  )
  nearId = await addNote(page, '近くの付箋', { x: 600, y: 300 })
  const canvasId = await canvasIdOf(page)
  const before = await nodeTypes(page)
  await askWithMenu(page, noteId)

  // 頼んでいる間（応答が来るまで）から、付箋の角の三角が点滅する
  await expect.poll(() => blinking(page, noteId)).toBe(true)
  await expect.poll(() => Boolean(release)).toBe(true)
  expect(sent[0]).toEqual({ noteId, canvasId, instruction: QUESTION, candidates: [{ id: nearId, text: '近くの付箋' }] })
  release!()
  // 作業の間（ジョブが動いている間）も点滅し、パネルに今していることを出す
  events.send(
    { type: 'snapshot', threads: [taskThread(noteId, canvasId)], running: [taskJob(noteId, canvasId, { events: [{ kind: 'tool', name: 'mcp__canvcode__edit_canvas', detail: '表を置く' }], eventCount: 1 })], questions: [] },
  )
  const corner = await cornerOf(page, noteId)
  await page.mouse.click(corner.x, corner.y)
  const popover = page.locator('.answer-popover')
  await expect(popover.locator('.answer-popover-head')).toContainText('作業')
  await expect(popover.locator('.answer-thinking-tool')).toContainText('Canvas を編集：表を置く')
  expect(await blinking(page, noteId)).toBe(true)

  // 作業が終わり、サーバーが報告を書いた
  const { events: _events, ...done } = taskJob(noteId, canvasId, { status: 'done', finishedAt: Date.now() })
  events.send({ type: 'job', job: done, events: [], from: 0, thread: taskThread(noteId, canvasId, { running: false }) })
  await giveReport(page, noteId, REPORT)
  await expect.poll(() => blinking(page, noteId)).toBe(false)
  await expect(popover.locator('.answer-view-body strong')).toHaveText('3 列')
  await expect(popover.locator('.answer-view-changes summary')).toHaveText('変えたもの 2 件')
  await popover.locator('.answer-view-changes summary').click()
  await expect(popover.locator('.answer-view-changes li')).toHaveText(['表を置く', 'notes/table.md'])
  await expect(popover.locator('.answer-view-continue')).toHaveText('続けて頼む')
  await expect(popover.locator('.answer-view-chat')).toHaveText('チャットで続ける')
  await page.screenshot({ path: test.info().outputPath('task-report.png') })
  // 付箋の作業は、キャンバスに何も置かない（置くのは Claude の編集。ここでは差し替えている）
  expect(await nodeTypes(page)).toEqual(before)
})

test('前の作業がある付箋は、その会話を添えて送る。▾ の「前の変更を戻してから送る」は戻すよう頼み、戻せなければわけを出す', async ({ page }) => {
  const sent: any[] = []
  // 1 つ目の応答のジョブは、ほかの付箋のもの（この付箋を作業中にしない）
  const replies = [
    { status: 201, json: { job: taskJob('node:other', 'canvas:other') } },
    { status: 409, json: { error: '前の変更「表を置く」を戻せなかったので、送りませんでした（そのあとに変わっています）', undone: [{ batch: 'ai-2', label: '色を変える' }], failed: { batch: 'ai-1', label: '表を置く', reason: 'Conflict' }, left: [] } },
  ]
  const noteId = await openApp(page, async (route) => {
    sent.push(route.request().postDataJSON())
    await route.fulfill(replies.shift()!)
  })
  // 前の作業の報告（キャンバスの変更が残っている）
  await giveReport(page, noteId, REPORT)
  const note = await centerOf(page, noteId)
  await page.mouse.click(note.x, note.y)
  const controls = page.locator('.ai-note-controls')
  await controls.locator('.ai-note-send').click()
  await expect.poll(() => sent.length).toBe(1)
  expect(sent[0]).toMatchObject({ noteId, instruction: QUESTION, lastThreadId: THREAD })
  expect(sent[0].undo).toBeUndefined()

  // ▾ から、前の変更を戻してから送る（戻せなかった：送らずに、わけと、先に戻したものの数を出す）
  await expect(controls.locator('.ai-note-send-more')).toBeEnabled()
  await controls.locator('.ai-note-send-more').click()
  await page.locator('.ai-note-send-menu').getByRole('menuitem', { name: '前の変更を戻してから送る' }).click()
  await expect.poll(() => sent.length).toBe(2)
  expect(sent[1]).toMatchObject({ noteId, lastThreadId: THREAD, undo: true })
  await expect(page.getByText(/頼めませんでした：前の変更「表を置く」を戻せなかった.*（新しい方の 1 個は戻しました）/)).toBeVisible()
  // 戻した変更（undone）だけの報告なら、▾ は出さない
  await giveReport(page, noteId, { ...REPORT, changes: { canvas: [{ ...REPORT.changes.canvas[0], undone: true }], files: [], commands: [] } })
  await expect(controls.locator('.ai-note-send-more')).toHaveCount(0)
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

test('答えのパネルの本文は 14px。長い答えは高さ 640px まで出し、付箋が下のほうにあって下が詰まっていれば、収まる所まで上にずらす', async ({ page }) => {
  // 高さ 640px のパネルと、その上下の余白が入る高さにする
  await page.setViewportSize({ width: 1000, height: 900 })
  const noteId = await openApp(page, (route) => route.fulfill({ json: ANSWER }))
  const long = Array.from({ length: 40 }, (_, i) => `${i + 1} 段落目の説明です。`).join('\n\n')
  await giveAnswer(page, noteId, { ...ANSWER, body: long, question: QUESTION, answeredAt: 1 })
  const root = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  expect(root.height).toBeGreaterThan(640 + 16)
  // 付箋の上の端を、キャンバスの上から y の所へ動かす
  const noteTopAt = (y: number) =>
    page.evaluate(
      ({ id, y }) => {
        const editor = (window as any).canvcode.editor
        const bounds = editor.index.get(id).worldBounds
        const { zoom } = editor.session.get().camera
        editor.session.set({ camera: { x: bounds.x - 200 / zoom, y: bounds.y - y / zoom, zoom } })
      },
      { id: noteId, y },
    )
  const popover = page.locator('.answer-popover')

  // 下が空いている：パネルの上の端は付箋の上の端に合わせ、高さは 640px
  await noteTopAt(40)
  const corner = await cornerOf(page, noteId)
  await page.mouse.click(corner.x, corner.y)
  await expect(popover).toBeVisible()
  let box = (await popover.boundingBox())!
  expect(box.y).toBeCloseTo(root.y + 40, 0)
  expect(box.height).toBeCloseTo(640, 0)
  // 本文は 14px・行間 1.7（質問のタブと会話は 16px のまま。ui-typography.spec.ts）
  const text = await popover.locator('.answer-view-body p').first().evaluate((el) => {
    const style = getComputedStyle(el)
    return { size: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight) }
  })
  expect(text.size).toBe(14)
  expect(text.lineHeight / text.size).toBeCloseTo(1.7, 2)

  // 付箋をキャンバスの下のほうへ動かす：高さはそのままで、下の端がキャンバスの下の端（から 8px）に来るまで上にずらす
  await noteTopAt(root.height - 120)
  const bottomOf = async () => {
    const box = (await popover.boundingBox())!
    return box.y + box.height
  }
  await expect.poll(bottomOf).toBeCloseTo(root.y + root.height - 8, 0)
  box = (await popover.boundingBox())!
  expect(box.height).toBeCloseTo(640, 0)
  expect(box.y).toBeLessThan(root.y + root.height - 120)
  await page.screenshot({ path: test.info().outputPath('answer-popover-shifted.png') })

  // 新しい短い答え：測り直し、ずらすのは収まるのに要る分だけ
  await giveAnswer(page, noteId, { ...ANSWER, question: QUESTION, answeredAt: 2 })
  await expect.poll(async () => (await popover.boundingBox())!.height).toBeLessThan(400)
  await expect.poll(bottomOf).toBeCloseTo(root.y + root.height - 8, 0)
  // 下が空いていれば、ずらさない
  await noteTopAt(200)
  await expect.poll(async () => (await popover.boundingBox())!.y).toBeCloseTo(root.y + 200, 0)
  await page.screenshot({ path: test.info().outputPath('answer-popover-short.png') })
})

test('下に詰めて出した答えのパネルは、中身が伸びると上にずらし、縮んでも下へは戻さない。キャンバスが低くなったら収め直す', async ({ page }) => {
  const noteId = await openApp(page, (route) => route.fulfill({ json: ANSWER }))
  // 「変えたもの」を持つ短い報告
  await giveReport(page, noteId, REPORT)
  const rootLocator = page.locator('.canvas-container > div[tabindex]')
  let root = (await rootLocator.boundingBox())!
  await page.evaluate(
    ({ id, y }) => {
      const editor = (window as any).canvcode.editor
      const bounds = editor.index.get(id).worldBounds
      const { zoom } = editor.session.get().camera
      editor.session.set({ camera: { x: bounds.x - 200 / zoom, y: bounds.y - y / zoom, zoom } })
    },
    { id: noteId, y: root.height - 120 },
  )
  const corner = await cornerOf(page, noteId)
  await page.mouse.click(corner.x, corner.y)
  const popover = page.locator('.answer-popover')
  await expect(popover).toBeVisible()
  const edges = async () => {
    const box = (await popover.boundingBox())!
    return { top: box.y, bottom: box.y + box.height }
  }
  await expect.poll(async () => (await edges()).bottom).toBeCloseTo(root.y + root.height - 8, 0)
  const closed = await edges()

  // 「変えたもの」を開く：下の端はそのままで、伸びた分だけ上にずらす
  const summary = popover.locator('.answer-view-changes summary')
  await summary.click()
  await expect(popover.locator('.answer-view-changes li').first()).toBeVisible()
  await expect.poll(async () => (await edges()).top).toBeLessThan(closed.top - 10)
  await expect.poll(async () => (await edges()).bottom).toBeCloseTo(root.y + root.height - 8, 0)
  const opened = await edges()
  // 閉じる：上の端はそのまま（下へは戻さない）
  await summary.click()
  await expect(popover.locator('.answer-view-changes li').first()).toBeHidden()
  await expect.poll(async () => (await edges()).bottom).toBeLessThan(opened.bottom - 10)
  expect((await edges()).top).toBeCloseTo(opened.top, 0)

  // キャンバスを低くする：パネルはキャンバスの中に収め直す
  await page.setViewportSize({ width: 1000, height: 500 })
  await expect.poll(async () => (await rootLocator.boundingBox())!.height).toBeLessThan(root.height)
  root = (await rootLocator.boundingBox())!
  await expect.poll(async () => (await edges()).bottom).toBeLessThanOrEqual(root.y + root.height - 8 + 0.5)
  expect((await edges()).top).toBeGreaterThanOrEqual(root.y + 8 - 0.5)
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
  const noteId = await openApp(page, accepting(sent))
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
  await expect.poll(() => sent.length).toBe(1)
  expect(sent[0]).toMatchObject({ noteId: followId, instruction: 'Xcode は無料？', previous: [{ question: QUESTION, answer: ANSWER.body }] })
  // 前の Q&A の答え（会話がない）を続けたので、前の作業の会話は添えない
  expect(sent[0].lastThreadId).toBeUndefined()
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
    const body = route.request().postDataJSON()
    sent.push(body)
    await new Promise<void>((resolve) => (release = resolve))
    await route.fulfill({ status: 201, json: { job: taskJob(body.noteId, body.canvasId) } })
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

  // 送信：もう一度頼む。頼んでいる間と作業の間、送信は押せなくなり（フォーカスは落ちる）、欄は出したまま
  await popover.focus()
  await controls.locator('.ai-note-send').click()
  await expect.poll(() => Boolean(release)).toBe(true)
  await expect(controls.locator('.ai-note-send')).toBeDisabled()
  await page.waitForTimeout(200)
  await expect(controls).toBeVisible()
  release!()
  // 応答が来ても、作業が終わるまでは押せない
  await page.waitForTimeout(200)
  await expect(controls.locator('.ai-note-send')).toBeDisabled()
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
  const noteId = await openApp(page, accepting(sent))
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

test('付箋の上の札・下の欄は、デザインパネルの下に出る。横の答えのパネルは、デザインパネルの左に収める', async ({ page }) => {
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
  // 答えのパネルは、付箋の右に入らないので左に出し、デザインパネルとは重ねない
  expect(await covered('.answer-popover')).toBe('no overlap')
  const popoverBox = (await page.locator('.answer-popover').boundingBox())!
  expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual((await panel.boundingBox())!.x)

  // 付箋をデザインパネルの少し左に戻す：付箋の右に出すとデザインパネルにかかるので、左に出す
  await page.evaluate((id) => {
    const editor = (window as any).canvcode.editor
    const bounds = editor.index.get(id).worldBounds
    const root = document.querySelector('.canvas-container > div[tabindex]')!.getBoundingClientRect()
    const box = document.querySelector('[data-testid="design-panel"]')!.getBoundingClientRect()
    const { zoom } = editor.session.get().camera
    editor.session.set({ camera: { x: bounds.x + bounds.w - (box.left - 100 - root.left) / zoom, y: bounds.y - (box.top + 80 - root.top) / zoom, zoom } })
  }, noteId)
  const panelLeft = (await panel.boundingBox())!.x
  await expect
    .poll(async () => {
      const box = (await page.locator('.answer-popover').boundingBox())!
      return box.x + box.width
    })
    .toBeLessThanOrEqual(panelLeft)
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
  await page.keyboard.press('Escape')

  // AI 付箋が画面の左端にあり、左に場所がない：札と欄（付箋より広い）の右に出し、画面からはみ出さない
  await page.evaluate((id) => {
    const editor = (window as any).canvcode.editor
    const bounds = editor.index.get(id).worldBounds
    editor.session.set({ camera: { x: bounds.x - 10 / 0.5, y: bounds.y - 300 / 0.5, zoom: 0.5 } })
  }, noteId)
  const edge = await centerOf(page, noteId)
  await page.mouse.dblclick(edge.x, edge.y)
  await expect(page.locator('.canvcode-text-editor')).toBeFocused()
  await expect(toolbar).toHaveClass(/vertical/)
  const side = (await toolbar.boundingBox())!
  const viewport = page.viewportSize()!
  expect(side.x + side.width).toBeLessThanOrEqual(viewport.width)
  for (const selector of ['.ai-note-chips', '.ai-note-controls']) {
    const other = (await page.locator(selector).boundingBox())!
    expect(side.x, selector).toBeGreaterThanOrEqual(other.x + other.width)
  }
})

test('作業の間は、三角のパネルに今していることと「止める」を出し、止められる。許可を待っている間は、三角を警告の色にしてそう出す', async ({ page }) => {
  const sent: any[] = []
  const cancels: string[] = []
  const events = eventsChannel()
  const noteId = await openApp(page, accepting(sent), events.handler)
  await page.route('**/api/claude/jobs/*/cancel', async (route) => {
    cancels.push(route.request().url().split('/').at(-2)!)
    await route.fulfill({ json: { job: { ...taskJob(noteId, 'canvas:input-test'), status: 'cancelled' } } })
  })
  const canvasId = await canvasIdOf(page)
  await askWithMenu(page, noteId)
  await expect.poll(() => sent.length).toBe(1)
  const working = taskJob(noteId, canvasId, { events: [{ kind: 'text', text: '表の形を決めます。' }, { kind: 'tool', name: 'Write', detail: 'notes/table.md' }], eventCount: 2 })
  events.send({ type: 'snapshot', threads: [taskThread(noteId, canvasId)], running: [working], questions: [] })
  const corner = await cornerOf(page, noteId)
  await page.mouse.click(corner.x, corner.y)
  const popover = page.locator('.answer-popover')
  await expect(popover.locator('.answer-view-step.current')).toHaveText('● ファイルを書いています…')
  await expect(popover.locator('.answer-thinking p')).toHaveText('表の形を決めます。')
  await expect(popover.locator('.answer-thinking-tool')).toContainText('notes/table.md')

  // 許可を待っている：三角を警告の色にし、パネルにそう出す
  const permission = { id: 'p1', jobId: THREAD, name: 'Bash', detail: 'npm test', createdAt: Date.now(), expiresAt: Date.now() + 600_000 }
  events.send({ type: 'snapshot', threads: [taskThread(noteId, canvasId, { permissions: [permission] })], running: [working], questions: [] })
  await expect.poll(() => page.evaluate((id) => (window as any).canvcode.editor.session.get().askingIds.has(id), noteId)).toBe(true)
  await expect(popover.locator('.answer-view-step.current')).toContainText('許可を待っています')

  await popover.locator('.answer-view-stop').click()
  await expect.poll(() => cancels).toEqual([THREAD])
})

test('作業のタブに、報告を持つ付箋が「過去の作業」として並ぶ。開くと報告を見て、見た印が付き、「チャットで続ける」でその作業の会話を開く', async ({ page }) => {
  const noteId = await openApp(page, accepting([]))
  const canvasId = await canvasIdOf(page)
  // その作業の会話（会話の一覧には出ていない。「チャットで続ける」で読む）
  await page.route(`**/api/claude/threads/${THREAD}`, (route) =>
    route.fulfill({ json: { thread: taskThread(noteId, canvasId, { running: false }), jobs: [{ ...taskJob(noteId, canvasId, { status: 'done' }), events: [{ kind: 'text', text: '表を 3 列で置きました。' }] }], questions: [] } }),
  )
  await giveReport(page, noteId, { ...REPORT, model: 'claude-sonnet-5-5' })

  // 右上の「作業」で作業のタブ。まだ見ていない報告に青い点
  await expect(page.locator('.claude-toggle')).toContainText('作業')
  await page.locator('.claude-toggle').click()
  const panel = page.locator('.question-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('tab', { name: /作業/ })).toHaveAttribute('aria-selected', 'true')
  await expect(panel.locator('.question-section-title')).toHaveText(['過去の作業'])
  const row = panel.locator('.question-row', { hasText: `「${QUESTION}」` })
  await expect(row).toHaveClass(/unread/)
  await row.locator('.question-row-main').click()
  await expect(panel.locator('.answer-view-body strong')).toHaveText('3 列')
  await expect(panel.locator('.question-model')).toHaveText('Sonnet 5.5')
  await panel.screenshot({ path: test.info().outputPath('task-detail.png') })
  await panel.locator('.question-back').click()
  await expect(row).not.toHaveClass(/unread/)
  // 「↗ 付箋へ移動」で付箋を選び、付箋の横に報告を開く
  await row.locator('.question-row-main').click()
  await panel.locator('.question-open-note').click()
  await expect.poll(() => selection(page)).toEqual([noteId])
  await expect(page.locator('.answer-popover .answer-view-body strong')).toHaveText('3 列')
  // 「チャットで続ける」：会話のタブを開き、その作業の会話を選ぶ（会話の一覧になくても読む）
  await page.locator('.answer-popover .answer-view-chat').click()
  await expect(page.locator('.answer-popover')).toHaveCount(0)
  await expect(page.locator('.claude-panel')).toBeVisible()
  await expect(page.locator('.claude-panel .claude-text').last()).toHaveText('表を 3 列で置きました。')
})

test('ほかのタブ・Canvas の作業も並ぶ。動作中は今していることと止めるボタン、許可のカード。ほかの Canvas の答えは「続けて聞く」で、いま開いている Canvas に札付きで置く', async ({ page }) => {
  const running = taskJob('node:far1', 'canvas:other', {
    prompt: 'この関数を図にして',
    model: 'claude-opus-5-5',
    effort: 'high',
    createdAt: Date.now() - 125_000,
    events: [{ kind: 'tool', name: 'WebSearch', detail: 'Tkrzw' }],
    eventCount: 1,
  })
  const permission = { id: 'p1', jobId: THREAD, name: 'Bash', detail: 'npm run build', createdAt: Date.now(), expiresAt: Date.now() + 600_000 }
  const past = { noteId: 'node:far2', canvasId: 'canvas:other', canvasTitle: '研究ノート', question: 'Tkrzw-Dict の使い方は？', model: 'claude-opus-5-5', answeredAt: Date.now() - 3_600_000 }
  const answer = { body: '辞書を引く。', related: [], model: 'claude-opus-5-5', question: 'Tkrzw-Dict の使い方は？', answeredAt: past.answeredAt }
  const events = eventsChannel()
  await openApp(page, accepting([]), events.handler)
  events.send({ type: 'snapshot', threads: [taskThread('node:far1', 'canvas:other', { permissions: [permission] })], running: [running], questions: [] })
  const cancels: string[] = []
  const answers: unknown[] = []
  await page.route('**/api/claude/questions', (route) => route.fulfill({ json: { questions: [past] } }))
  await page.route('**/api/claude/questions/node*', (route) => route.fulfill({ json: { ...past, ai: { contexts: [], answer }, related: [] } }))
  await page.route('**/api/claude/jobs/*/cancel', async (route) => {
    cancels.push(route.request().url().split('/').at(-2)!)
    await route.fulfill({ json: { job: { ...running, status: 'cancelled' } } })
  })
  await page.route(`**/api/claude/threads/${THREAD}/permissions/p1`, async (route) => {
    answers.push(route.request().postDataJSON())
    await route.fulfill({ status: 204 })
  })
  // 右上のボタンに、動いている作業の数
  await expect(page.locator('.claude-toggle')).toContainText('●1')
  await page.locator('.claude-toggle').click()
  const panel = page.locator('.question-panel')
  await expect(panel.getByRole('tab', { name: /作業/ })).toContainText('●1')
  // 許可のカード（［断る］が先）。許可すると、サーバーに答える
  const card = panel.locator('.claude-permission')
  await expect(card.locator('.claude-permission-detail')).toHaveText('npm run build')
  await expect(card.locator('.claude-permission-actions button')).toHaveText(['断る', '許可する'])
  await card.locator('.claude-allow').click()
  await expect.poll(() => answers).toEqual([{ decision: 'allow' }])
  const live = panel.locator('.question-row.running')
  await expect(live).toContainText('「この関数を図にして」')
  await expect(live.locator('.question-row-meta')).toContainText('2分前')
  await expect(live.locator('.question-row-steps')).toHaveText('許可を待っています')
  await panel.screenshot({ path: test.info().outputPath('task-list.png') })
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
