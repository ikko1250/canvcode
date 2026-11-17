import { expect, test, type Page, type Route } from '@playwright/test'

// キャンバスの AI：付箋の右クリックの「Claude に聞く（付箋で答える）」で、答え（サーバーの /api/claude/answer。ここでは差し替え）が
// 段落ごとの付箋とボタンをまとめたフレームになって付箋の下に置かれる（付箋から矢印）。選んでいないボタンをクリックすると、そのフレームが書き直される。
// 書き直す前の答えは版の帯で戻せる。「＋」で続きの質問の付箋（AI モード）を置き、送ると前の答えを踏まえた答えがその下に置かれる

const QUESTION = 'swiftの開発環境ってどうやって整えたら良いの?'
const FIRST = {
  title: 'Swift の開発環境',
  assumptions: ['iOS アプリを作る'],
  paragraphs: ['**Xcode** を入れれば、開発環境はほぼ整う。', 'まず App Store から `Xcode` を入れる。'],
  hints: [
    { label: 'Mac アプリ向けに', prompt: '対象を Mac のアプリにして書き直す' },
    { label: 'もっと簡単な言葉で', prompt: '初めての人にもわかる言葉で書き直す' },
  ],
  model: 'claude-sonnet-5-5',
}
const SECOND = {
  title: 'Swift の開発環境（Mac）',
  assumptions: ['Mac アプリを作る'],
  paragraphs: ['Mac のアプリも、Xcode で作る。'],
  hints: [{ label: 'iOS アプリ向けに', prompt: '対象を iOS のアプリに戻して書き直す' }],
  model: 'claude-sonnet-5-5',
}

async function openApp(page: Page, answer: (route: Route) => Promise<void>): Promise<string> {
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
  await page.route('**/api/claude/events', (route) => route.fulfill({ status: 204 }))
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

// 答えのフレーム（Canvas 直下のフレーム。index 番目）の中身：型・文字（付箋）か出す文字（書き直すボタン）。
// 「＋」（左・右）と版の帯は items に入れず、別に返す
const answerFrame = (page: Page, index = 0) =>
  page.evaluate((index) => {
    const editor = (window as any).canvcode.editor
    const frame = editor.index
      .childrenOf(editor.canvasId)
      .map((id: string) => editor.getNode(id))
      .filter((node: any) => node.type === 'frame')[index]
    if (!frame) return null
    const children = editor.index.childrenOf(frame.id).map((id: string) => editor.getNode(id))
    const plain = children.filter((node: any) => node.type !== 'button' || !node.props.action)
    const action = (name: string) => children.filter((node: any) => node.props.action === name).map((node: any) => node.id) as string[]
    return {
      id: frame.id as string,
      name: frame.props.name as string,
      items: plain.map((node: any) =>
        node.type === 'note' ? `note:${node.props.paragraphs.map((p: any) => p.runs.map((r: any) => r.text).join('')).join('/')}` : `${node.type}:${node.props.label}`,
      ) as string[],
      buttons: plain.filter((node: any) => node.type === 'button').map((node: any) => node.id) as string[],
      left: action('ask-left')[0],
      right: action('ask-right')[0],
      bars: action('version'),
    }
  }, index)

// Canvas 直下の矢印の、つながっている先（始まり → 終わり）
const arrowEnds = (page: Page) =>
  page.evaluate(() => {
    const editor = (window as any).canvcode.editor
    return editor.index
      .childrenOf(editor.canvasId)
      .filter((id: string) => editor.getNode(id).type === 'arrow')
      .map((id: string) => {
        const ends = Object.fromEntries(editor.bindingsOfArrow(id).map((b: any) => [b.props.terminal, b.toId]))
        return `${ends.start}->${ends.end}`
      }) as string[]
  })

// 答えは質問の下に置くので、全体が画面に入るように縮めて見る
const zoomOut = (page: Page) => page.evaluate(() => (window as any).canvcode.editor.session.set({ camera: { x: 0, y: 0, zoom: 0.6 } }))

// 付箋に聞いて、最初の答えを置く（全体が見えるように縮める）
async function askFirst(page: Page, noteId: string) {
  const note = await centerOf(page, noteId)
  await page.mouse.click(note.x, note.y)
  await page.mouse.click(note.x, note.y, { button: 'right' })
  await page.locator('.context-menu button', { hasText: 'Claude に聞く（付箋で答える）' }).click()
  await expect.poll(() => answerFrame(page).then((frame) => frame?.buttons.length)).toBe(2)
  await zoomOut(page)
  return (await answerFrame(page))!
}

test('付箋で聞いて、付箋とボタンのフレームで答え、ボタンで書き直し、Undo で戻す', async ({ page }) => {
  const sent: unknown[] = []
  const noteId = await openApp(page, async (route) => {
    sent.push(route.request().postDataJSON())
    await route.fulfill({ json: sent.length === 1 ? FIRST : SECOND })
  })
  const note = await centerOf(page, noteId)
  await page.mouse.click(note.x, note.y)
  await page.mouse.click(note.x, note.y, { button: 'right' })
  await page.locator('.context-menu button', { hasText: 'Claude に聞く（付箋で答える）' }).click()

  await expect.poll(() => answerFrame(page).then((frame) => frame?.items)).toEqual([
    'note:この答えの前提/iOS アプリを作る',
    'note:Xcode を入れれば、開発環境はほぼ整う。',
    'note:まず App Store から Xcode を入れる。',
    'button:Mac アプリ向けに',
    'button:もっと簡単な言葉で',
  ])
  expect(sent[0]).toEqual({ question: QUESTION })
  const frame = (await answerFrame(page))!
  expect(frame.name).toBe('Swift の開発環境')
  // 答えは付箋の下（左をそろえる）。付箋からフレームへ矢印。ボタンの並びの左右に「＋」。版が 1 つなので帯はない
  const boxes = await page.evaluate(
    ([noteId, frameId]) => {
      const editor = (window as any).canvcode.editor
      return { note: editor.index.get(noteId).worldBounds, frame: editor.index.get(frameId).worldBounds }
    },
    [noteId, frame.id],
  )
  expect(boxes.frame.x).toBe(boxes.note.x)
  expect(boxes.frame.y).toBeGreaterThan(boxes.note.y + boxes.note.h)
  expect(await arrowEnds(page)).toEqual([`${noteId}->${frame.id}`])
  expect(frame.left && frame.right).toBeTruthy()
  expect(frame.bars).toEqual([])
  await zoomOut(page)

  // 選んでいないボタンをクリックすると押す（ボタンは選ばれない）
  await page.mouse.click(0, 0)
  const mac = await centerOf(page, frame.buttons[0]!)
  await page.mouse.click(mac.x, mac.y)
  await expect.poll(() => answerFrame(page).then((f) => f?.items)).toEqual(['note:この答えの前提/Mac アプリを作る', 'note:Mac のアプリも、Xcode で作る。', 'button:iOS アプリ向けに'])
  expect(sent[1]).toEqual({
    question: QUESTION,
    current: {
      title: 'Swift の開発環境',
      assumptions: [{ text: 'iOS アプリを作る', edited: false }],
      notes: [
        { text: '**Xcode** を入れれば、開発環境はほぼ整う。', edited: false },
        { text: 'まず App Store から `Xcode` を入れる。', edited: false },
      ],
      buttons: [],
      history: [],
    },
    instruction: '対象を Mac のアプリにして書き直す',
  })
  expect((await answerFrame(page))!.name).toBe('Swift の開発環境（Mac）')

  // 書き直しは Undo 1 回で戻る
  await page.keyboard.press('Control+z')
  await expect.poll(() => answerFrame(page).then((f) => f?.items.length)).toBe(5)
  expect((await answerFrame(page))!.name).toBe('Swift の開発環境')
})

test('版の帯で、書き直す前の答えに戻り、また進む（Claude は呼ばない）。ホバーで説明が出る', async ({ page }) => {
  const sent: unknown[] = []
  const noteId = await openApp(page, async (route) => {
    sent.push(route.request().postDataJSON())
    await route.fulfill({ json: sent.length === 1 ? FIRST : SECOND })
  })
  const frame = await askFirst(page, noteId)
  await page.mouse.click(0, 0)
  const mac = await centerOf(page, frame.buttons[0]!)
  await page.mouse.click(mac.x, mac.y)
  await expect.poll(() => answerFrame(page).then((f) => f?.bars.length)).toBe(2)
  const rewritten = (await answerFrame(page))!
  expect(rewritten.items).toEqual(['note:この答えの前提/Mac アプリを作る', 'note:Mac のアプリも、Xcode で作る。', 'button:iOS アプリ向けに'])

  const back = await centerOf(page, rewritten.bars[0]!)
  await page.mouse.move(back.x, back.y)
  await expect(page.locator('.button-tooltip')).toHaveText('ひとつ前の回答に戻る（「Mac アプリ向けに」を押す前）')
  await page.mouse.click(back.x, back.y)
  await expect.poll(() => answerFrame(page).then((f) => f?.items)).toEqual([
    'note:この答えの前提/iOS アプリを作る',
    'note:Xcode を入れれば、開発環境はほぼ整う。',
    'note:まず App Store から Xcode を入れる。',
    'button:Mac アプリ向けに',
    'button:もっと簡単な言葉で',
  ])
  expect((await answerFrame(page))!.name).toBe('Swift の開発環境')

  const forward = await centerOf(page, (await answerFrame(page))!.bars[1]!)
  await page.mouse.move(forward.x, forward.y)
  await expect(page.locator('.button-tooltip')).toHaveText('ひとつ後の回答に進む（「Mac アプリ向けに」）')
  await page.mouse.click(forward.x, forward.y)
  await expect.poll(() => answerFrame(page).then((f) => f?.name)).toBe('Swift の開発環境（Mac）')
  expect(sent).toHaveLength(2)
})

test('「＋」で続きの質問の付箋を置き、送ると前の答えを踏まえた答えが下に置かれる。Claude のパネルで考えた中身を見て、答えへ移る', async ({ page }) => {
  const sent: any[] = []
  const FOLLOW = { title: 'Xcode の値段', assumptions: [], paragraphs: ['Xcode は無料です。'], hints: [], model: 'claude-sonnet-5-5' }
  const noteId = await openApp(page, async (route) => {
    sent.push(route.request().postDataJSON())
    if (sent.length === 1) return route.fulfill({ json: FIRST })
    // 続きの答えは NDJSON（考えている中身のあとに答え）
    const lines = [
      { type: 'thinking', text: '前の答えで Xcode を勧めた。' },
      { type: 'thinking', text: '値段を答える。' },
      // サーバーが混ぜる、調べている語・読んでいるページ（間に空の行が入る）
      { type: 'thinking', text: '\n\n― Web で調べる：Xcode 値段\n\n\n\n― ページを読む：https://developer.apple.com/xcode/\n\n' },
      { type: 'thinking', text: '無料だとわかった。' },
      { type: 'answer', answer: FOLLOW },
    ]
    await route.fulfill({ body: lines.map((line) => JSON.stringify(line)).join('\n') + '\n', contentType: 'application/x-ndjson' })
  })
  const first = await askFirst(page, noteId)
  await page.mouse.click(0, 0)
  const plus = await centerOf(page, first.right!)
  await page.mouse.move(plus.x, plus.y)
  await expect(page.locator('.button-tooltip')).toHaveText('右に続きの質問を置く')
  await page.mouse.click(plus.x, plus.y)

  // 右に AI モードの付箋が置かれ、文字の編集が始まる。下の欄に、前の答えが添えてある
  await expect(page.locator('.ai-note-controls')).toBeVisible()
  await expect(page.locator('.ai-note-context')).toContainText('続き：Swift の開発環境')
  await page.keyboard.type('Xcode は無料？')
  // 編集を終えてから、欄の並びを確かめる
  await page.keyboard.press('Escape')
  // 添えたものは 2 段目（モデル・送信の段の下）。長い名前でも欄からはみ出さない
  await page.evaluate(() => {
    const editor = (window as any).canvcode.editor
    const id = editor.index.childrenOf(editor.canvasId).find((child: string) => editor.getNode(child).meta?.ai)
    const node = editor.getNode(id)
    const long = { kind: 'answer', frameId: node.meta.ai.contexts[0].frameId, label: '日本の容量市場の主な問題点と、その背景にある制度設計の課題についての長い題' }
    editor.transact('long', (tx: any) => tx.put({ ...node, meta: { ...node.meta, ai: { contexts: [node.meta.ai.contexts[0], long] } } }))
  })
  await expect(page.locator('.ai-note-context')).toHaveCount(2)
  const layout = await page.locator('.ai-note-controls').evaluate((controls) => {
    const box = (selector: string) => controls.querySelector(selector)!.getBoundingClientRect()
    const outer = controls.getBoundingClientRect()
    const chips = [...controls.querySelectorAll('.ai-note-context')].map((chip) => chip.getBoundingClientRect())
    return { sendBottom: box('.ai-note-send').bottom, chipTops: chips.map((chip) => chip.top), overflow: chips.some((chip) => chip.right > outer.right + 0.5), wider: controls.scrollWidth > controls.clientWidth }
  })
  for (const top of layout.chipTops) expect(top).toBeGreaterThan(layout.sendBottom)
  expect(layout.overflow).toBe(false)
  expect(layout.wider).toBe(false)
  await page.locator('.ai-note-controls').screenshot({ path: test.info().outputPath('ai-note-controls.png') })
  await page.evaluate(() => {
    const editor = (window as any).canvcode.editor
    const id = editor.index.childrenOf(editor.canvasId).find((child: string) => editor.getNode(child).meta?.ai)
    const node = editor.getNode(id)
    editor.transact('back', (tx: any) => tx.put({ ...node, meta: { ...node.meta, ai: { contexts: [node.meta.ai.contexts[0]] } } }))
  })
  await page.locator('.ai-note-send').click()

  await expect.poll(() => answerFrame(page, 1).then((frame) => frame?.items)).toEqual(['note:Xcode は無料です。'])
  expect(sent[1]).toEqual({
    question: 'Xcode は無料？',
    previous: [{ question: QUESTION, title: 'Swift の開発環境', paragraphs: ['**Xcode** を入れれば、開発環境はほぼ整う。', 'まず App Store から `Xcode` を入れる。'] }],
  })
  // 送ったら AI モードを解く。矢印は、質問 → 答え、答え → 続きの質問、続きの質問 → 続きの答え
  await expect(page.locator('.ai-note-controls')).toHaveCount(0)
  const second = (await answerFrame(page, 1))!
  const ends = await arrowEnds(page)
  expect(ends).toHaveLength(3)
  expect(ends[0]).toBe(`${noteId}->${first.id}`)
  expect(ends[1]!.startsWith(`${first.id}->`)).toBe(true)
  expect(ends[2]!.endsWith(`->${second.id}`)).toBe(true)

  // 右上の「Claude」で開く付箋の答えのパネル（チャットは出さない）に、回答終了の記録。押すと考えた中身だけを見る。「答えへ移る」で、答えのフレームを選ぶ
  await page.locator('.claude-toggle').click()
  await expect(page.locator('.answer-panel')).toBeVisible()
  await expect(page.locator('.claude-panel')).toBeHidden()
  const row = page.locator('.answer-row', { hasText: '続き：Xcode は無料？' })
  await expect(row).toContainText('回答終了')
  await row.locator('.answer-row-main').click()
  // 段落と、調べている行のまとまりに分けて出す（間の空の行は詰める）
  await expect(page.locator('.answer-thinking > p')).toHaveText(['前の答えで Xcode を勧めた。値段を答える。', '無料だとわかった。'])
  await expect(page.locator('.answer-thinking-tool > div')).toHaveText(['Web で調べる：Xcode 値段', 'ページを読む：https://developer.apple.com/xcode/'])
  await page.locator('.answer-thinking-view').screenshot({ path: test.info().outputPath('answer-thinking.png') })
  await page.locator('.answer-thinking-head button', { hasText: '← 一覧に戻る' }).click()
  await expect(page.locator('.answer-thinking')).toHaveCount(0)
  await row.locator('.answer-row-jump').click()
  await expect.poll(() => page.evaluate(() => [...(window as any).canvcode.editor.session.get().selectedIds])).toEqual([second.id])
})

test('ボタンを押して待っている間にフレームの付箋を書き換えたら、置き換えない', async ({ page }) => {
  let release: (() => void) | undefined
  let calls = 0
  const noteId = await openApp(page, async (route) => {
    calls++
    if (calls === 2) await new Promise<void>((resolve) => (release = resolve))
    await route.fulfill({ json: calls === 1 ? FIRST : SECOND })
  })
  const note = await centerOf(page, noteId)
  await page.mouse.click(note.x, note.y)
  await page.mouse.click(note.x, note.y, { button: 'right' })
  await page.locator('.context-menu button', { hasText: 'Claude に聞く（付箋で答える）' }).click()
  await expect.poll(() => answerFrame(page).then((frame) => frame?.buttons.length)).toBe(2)
  await zoomOut(page)
  const frame = (await answerFrame(page))!
  await page.mouse.click(0, 0)
  const simple = await centerOf(page, frame.buttons[1]!)
  await page.mouse.click(simple.x, simple.y)
  await expect(page.getByText('「もっと簡単な言葉で」で書き直しています')).toBeVisible()
  await expect.poll(() => Boolean(release)).toBe(true)
  await page.evaluate((frameId) => {
    const editor = (window as any).canvcode.editor
    const id = editor.index.childrenOf(frameId).find((child: string) => editor.getNode(child).type === 'note')
    const node = editor.getNode(id)
    editor.transact('edit', (tx: any) => tx.put({ ...node, props: { ...node.props, paragraphs: [{ runs: [{ text: '書き換えた' }] }] } }))
  }, frame.id)
  release!()
  await expect(page.getByText('待っている間にフレームの付箋が変わったので、置き換えませんでした')).toBeVisible()
  expect((await answerFrame(page))!.items[0]).toBe('note:書き換えた')
})
