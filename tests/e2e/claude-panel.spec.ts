import { expect, test, type Locator, type Page } from '@playwright/test'

// Claude のパネルの回答を選んでコピーしても、キャンバスで選んでいるノードのコピーに横取りされない。
// パネルの中のキー（Delete・矢印・Ctrl+A・Esc）は、キャンバスのショートカットに渡らない。
// バックグラウンドの作業が並び、1 つずつ・まるごと止められる。
// 画面で許可を待っている問い合わせが並び、JSON で答えられ、閉じたパネルの Claude のボタンに印が出る。
// 右上の「質問」と C で開くのは質問のタブで、会話は上の「会話」のタブ（か、もう一度 C）で開く（MAI-91・docs/canvas-answer-panel-plan.md）

// claude は、会話 t1 に足すもの（バックグラウンドの作業・待っている問い合わせ・ジョブ）。events は /api/claude/events の差し替え。
// open が true なら、右上の「質問」で質問のタブを開き、「会話」のタブに移って返す。false なら、パネルを開かずに返す（C で開くのを確かめる）
async function openApp(
  page: Page,
  claude: { tasks?: object[]; permissions?: object[]; jobs?: object[]; events?: Parameters<Page['route']>[1] } = {},
  { open = true }: { open?: boolean } = {},
) {
  await page.goto('/canvas-input-test.html?kind=markdown&sizing=auto')
  await page.waitForFunction(() => Boolean((window as any).canvasInputFixture))
  // カードのほかに付箋を 1 つ置く（Ctrl+A でキャンバスのノードを全部選んだら、わかるように）
  const records = await page.evaluate(() => {
    const fixture = (window as any).canvasInputFixture
    fixture.startNote(700, 500, 'note')
    return [...fixture.editor.workspace.store.values()]
  })
  const file = { id: 'file:input-test', kind: 'markdown', title: 'Input test', path: 'test.md', size: 100, mtime: 0, hash: 'test', missing: false }
  const now = Date.now()
  const thread = { threadId: 't1', title: 'hello', createdAt: now, updatedAt: now, jobCount: 1, running: false, tasks: claude.tasks ?? [], permissions: claude.permissions ?? [] }
  const job = { id: 'j1', threadId: 't1', prompt: 'question', status: 'done', createdAt: now, eventCount: 1, events: [{ kind: 'text', text: 'Answer from Claude' }] }
  await page.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: 'canvas:input-test', rev: 0, records } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [file] } }))
  await page.route('**/api/files/file%3Ainput-test/content', (route) => route.fulfill({ body: '# Card', headers: { etag: '"test"' } }))
  await page.route('**/api/claude/threads', (route) => route.fulfill({ json: { threads: [thread] } }))
  await page.route('**/api/claude/threads/t1', (route) => route.fulfill({ json: { jobs: [job, ...(claude.jobs ?? [])] } }))
  await page.route('**/api/claude/events', claude.events ?? ((route) => route.fulfill({ status: 204 })))
  await page.route('**/api/claude/questions*', (route) => route.fulfill({ json: { questions: [] } }))
  await page.goto('/')
  const root = page.locator('.canvas-container > div[tabindex]')
  await expect(root).toBeVisible()
  expect(await page.evaluate(() => (window as any).canvcode.editor.index.allIds().length)).toBeGreaterThan(1)
  // カード（ワールドの (80, 70) から）を選ぶ
  const rect = (await root.boundingBox())!
  await page.mouse.click(rect.x + 140, rect.y + 140)
  await expect.poll(() => selectedIds(page)).toHaveLength(1)
  if (open) {
    await openChat(page)
    await expect(page.locator('.claude-text').first()).toHaveText('Answer from Claude')
  } else {
    // Claude を使える（会話の一覧を読めた）と、右上のボタンが出る
    await expect(page.locator('.claude-toggle')).toBeVisible()
  }
  // キャンバスの copy の処理（window で受ける）が既定の動作を止めたかを記録する
  await page.evaluate(() => {
    ;(window as any).copyPrevented = []
    window.addEventListener('copy', (e) => (window as any).copyPrevented.push(e.defaultPrevented))
  })
  return root
}

const panel = (page: Page) => page.locator('.claude-panel')
const answerPanel = (page: Page) => page.locator('.question-panel')

// 右上の「質問」で質問のタブを開き、「会話」のタブに移る
async function openChat(page: Page) {
  await page.locator('.claude-toggle').click()
  await expect(answerPanel(page)).toBeVisible()
  await expect(panel(page)).toBeHidden()
  await answerPanel(page).getByRole('tab', { name: '会話' }).click()
  await expect(panel(page)).toBeVisible()
  await expect(answerPanel(page)).toBeHidden()
}
const promptBox = (page: Page) => page.locator('.claude-compose textarea')
// 押したキーの処理と描き直しが済むのを待つ（開かないことを確かめる前に）
const settle = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))

// openApp で置いた付箋の真ん中（画面の座標）
async function noteCenter(page: Page) {
  const box = (await page.locator('.canvas-container > div[tabindex]').boundingBox())!
  const at = await page.evaluate(() => {
    const editor = (window as any).canvcode.editor
    const id = editor.index.allIds().find((id: string) => editor.getNode(id)?.type === 'note')
    const bounds = editor.index.get(id).worldBounds
    const camera = editor.session.get().camera
    return { x: (bounds.x + bounds.w / 2 - camera.x) * camera.zoom, y: (bounds.y + bounds.h / 2 - camera.y) * camera.zoom }
  })
  return { x: box.x + at.x, y: box.y + at.y }
}

const selectedIds = (page: Page) => page.evaluate(() => [...(window as any).canvcode.editor.session.get().selectedIds] as string[])
const copyPrevented = (page: Page) => page.evaluate(() => (window as any).copyPrevented as boolean[])
const textSelection = (page: Page) => page.evaluate(() => document.getSelection()?.toString().trim())

test('copies the selected answer text instead of the selected canvas node', async ({ page, context, browserName }) => {
  await openApp(page)
  await page.locator('.claude-text').click({ clickCount: 3 })
  expect(await textSelection(page)).toBe('Answer from Claude')
  await page.keyboard.press('ControlOrMeta+c')
  expect(await copyPrevented(page)).toEqual([false])
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    expect((await page.evaluate(() => navigator.clipboard.readText())).trim()).toBe('Answer from Claude')
  }
})

test('copies the canvas node again after clicking the canvas with answer text selected', async ({ page }) => {
  const root = await openApp(page)
  await page.locator('.claude-text').click({ clickCount: 3 })
  const rect = (await root.boundingBox())!
  await page.mouse.click(rect.x + 140, rect.y + 140)
  // パネルで選んだ文字は外れる
  expect(await textSelection(page)).toBe('')
  await page.keyboard.press('ControlOrMeta+c')
  expect(await copyPrevented(page)).toEqual([true])
})

test('copies the canvas node when the canvas gets focus without a click, even if answer text is still selected', async ({ page }) => {
  await openApp(page)
  await page.locator('.claude-text').click({ clickCount: 3 })
  // Tab やアプリの処理（view.root.focus()）でフォーカスが移ったとき。Chromium と Firefox では、選んだ文字が残る
  // （WebKit は、フォーカスが移ると外す）
  await page.evaluate(() => (window as any).canvcode.view.root.focus())
  await page.keyboard.press('ControlOrMeta+c')
  expect(await copyPrevented(page)).toEqual([true])
})

test('leaves the copy to the browser when text outside the canvas is selected and the canvas has no focus', async ({ page }) => {
  await openApp(page)
  // パネルの外（data-own-keys のない所）の文字
  await page.evaluate(() => {
    const p = document.createElement('p')
    p.textContent = 'Outside text'
    document.body.append(p)
    ;(document.activeElement as HTMLElement | null)?.blur()
    document.getSelection()!.selectAllChildren(p)
  })
  await page.keyboard.press('ControlOrMeta+c')
  expect(await copyPrevented(page)).toEqual([false])
})

test('keys pressed in the panel do not reach the canvas shortcuts', async ({ page }) => {
  await openApp(page)
  const [id] = await selectedIds(page)
  const nodeOf = () => page.evaluate((id) => (window as any).canvcode.editor.getNode(id), id)
  const before = await nodeOf()
  await page.locator('.claude-text').click({ clickCount: 3 })
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Delete')
  await page.keyboard.press('Backspace')
  expect(await nodeOf()).toEqual(before)
  // Ctrl+A は、キャンバスのノードを全部選ぶのではなく、会話の欄の文字を選ぶ
  await page.locator('.claude-log').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('ControlOrMeta+a')
  expect(await selectedIds(page)).toEqual([id])
  // 改行の数はブラウザで違う。答えの下の操作（コピー・モデルの札）も入る
  expect(await textSelection(page)).toMatch(/^question\s+Answer from Claude\s/)
})

test('the focus ring of the prompt box goes around the whole composer card, and 質問 mode thickens its border (claude-chat-tab-plan 4)', async ({ page }) => {
  await openApp(page)
  const ring = (selector: string) =>
    page.locator(selector).evaluate((el) => {
      const style = getComputedStyle(el)
      return { outline: `${style.outlineStyle} ${style.outlineWidth}`, border: `${style.borderTopWidth} ${style.borderTopColor}` }
    })
  await promptBox(page).click()
  // 文の欄そのものには出さず、札・ボタンと一緒に囲む外側に、DADS のフォーカスの枠を出す
  expect((await ring('.claude-compose textarea')).outline).toMatch(/^none /)
  expect((await ring('.claude-compose')).outline).toBe('solid 4px')
  const chat = await ring('.claude-compose')
  // 「質問」にすると、枠が主な色の 2px になる（会話に入らないことが分かるように）
  await page.getByRole('radio', { name: '質問' }).click()
  await promptBox(page).click()
  const question = await ring('.claude-compose')
  expect(chat.border).toMatch(/^1px /)
  expect(question.border).toMatch(/^2px /)
  expect(question.border).not.toBe(chat.border.replace(/^1px/, '2px'))
  // フォーカスを外すと、枠は消える
  await page.locator('.claude-log').click({ position: { x: 5, y: 5 } })
  expect((await ring('.claude-compose')).outline).toMatch(/^none /)
})

test('arrow keys move the caret in the prompt box without moving the canvas node', async ({ page }) => {
  await openApp(page)
  const [id] = await selectedIds(page)
  const nodeOf = () => page.evaluate((id) => (window as any).canvcode.editor.getNode(id), id)
  const before = await nodeOf()
  const input = page.locator('.claude-compose textarea')
  await input.click()
  await page.keyboard.type('abc')
  await page.keyboard.press('Enter')
  await page.keyboard.type('def')
  const caret = () => input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)
  expect(await caret()).toBe(7)
  await page.keyboard.press('ArrowLeft')
  expect(await caret()).toBe(6)
  await page.keyboard.press('ArrowUp')
  expect(await caret()).toBe(2)
  await page.keyboard.press('ArrowRight')
  expect(await caret()).toBe(3)
  await page.keyboard.press('ArrowDown')
  expect(await caret()).toBe(7)
  await expect(input).toHaveValue('abc\ndef')
  expect(await nodeOf()).toEqual(before)
})

test('Escape closes the panel after clicking the conversation', async ({ page }) => {
  await openApp(page)
  await page.locator('.claude-log').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Escape')
  await expect(page.locator('.claude-panel')).toHaveCount(0)
  // キャンバスの選択はそのまま（Esc はキャンバスに渡らない）
  expect(await selectedIds(page)).toHaveLength(1)
})

test('lists background tasks, stops one or all of them, and shows the turn Claude continued on its own', async ({ page }) => {
  const now = Date.now()
  await openApp(page, {
    tasks: [
      { id: 'ag1', description: '論文を探す', type: 'local_agent' },
      { id: 'b2', description: 'ping 90 times', type: 'local_bash' },
    ],
    jobs: [
      {
        id: 'j2',
        threadId: 't1',
        prompt: 'バックグラウンドの作業「見張り」が終わりました',
        origin: 'background',
        status: 'done',
        createdAt: now + 60_000,
        eventCount: 2,
        events: [
          { kind: 'task', status: 'completed', description: '見張り' },
          { kind: 'text', text: '続きを書きました' },
        ],
      },
    ],
  })
  const stops: string[] = []
  await page.route('**/api/claude/threads/t1/**', (route) => {
    stops.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    return route.fulfill({ status: 204 })
  })

  // 作業が終わって Claude が続けたジョブは、吹き出しでなく小さく出る
  await expect(page.locator('.claude-wake')).toHaveText('バックグラウンドの作業「見張り」が終わりました。Claude が続けました')
  await expect(page.locator('.claude-prompt')).toHaveCount(1)
  // 作業の知らせは「▸ 作業 1件」にたたみ、押すと開く
  await expect(page.locator('.claude-tools-toggle')).toHaveText('▸ 作業 1件')
  await expect(page.locator('.claude-tool.task')).toHaveCount(0)
  await page.locator('.claude-tools-toggle').click()
  await expect(page.locator('.claude-tool.task')).toHaveText('終わりました：見張り')

  // 作業は「⚙ 動作中の作業 2件 ▾」の 1 行。押すと一覧。作業があるあいだは、消せないが送れる
  await expect(page.locator('.claude-tasks-title')).toHaveText('⚙ 動作中の作業 2件')
  await expect(page.locator('.claude-task-name')).toHaveCount(0)
  await page.locator('.claude-tasks-toggle').click()
  await expect(page.locator('.claude-task-name')).toHaveText(['サブエージェント：論文を探す', 'コマンド：ping 90 times'])
  await expect(page.locator('.claude-toggle')).toHaveClass(/running/)
  await page.getByRole('button', { name: 'この会話のメニュー' }).click()
  await expect(page.getByRole('menuitem', { name: 'この会話を消す' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menuitem')).toHaveCount(0)
  await expect(panel(page)).toBeVisible()
  await page.locator('.claude-compose textarea').fill('その間に')
  await expect(page.locator('.claude-send')).toBeEnabled()

  await page.locator('.claude-task').first().getByRole('button', { name: '止める' }).click()
  await expect.poll(() => stops).toEqual(['POST /api/claude/threads/t1/tasks/ag1/stop'])

  // 「全部止める」は 2 回押す
  await page.getByRole('button', { name: '全部止める' }).click()
  await expect(page.getByRole('button', { name: '本当に全部止める' })).toBeVisible()
  expect(stops).toHaveLength(1)
  await page.getByRole('button', { name: '本当に全部止める' }).click()
  await expect.poll(() => stops).toEqual(['POST /api/claude/threads/t1/tasks/ag1/stop', 'POST /api/claude/threads/t1/stop'])
})

test('shows the questions waiting for an answer, answers them with JSON, and marks the Claude button', async ({ page }) => {
  const now = Date.now()
  const build = 'rm -rf build && npm run build -- --mode production && echo "ビルドし直しました"'
  const first = { id: 'p1', jobId: 'j3', name: 'Bash', detail: build, description: 'ビルドし直す', createdAt: now, expiresAt: now + 9.5 * 60_000 }
  const second = {
    id: 'p2',
    name: 'Bash',
    detail: 'git push origin main',
    agent: 'リリースを確かめる',
    reason: 'ワークスペースの設定（permissions.ask）で、尋ねると決めてあります',
    createdAt: now,
    expiresAt: now + 30_000,
  }
  // 1 つ目に答えたら、SSE で 1 つ目のない会話を届ける（2 回目からの接続は 204）
  let answered!: () => void
  const firstAnswered = new Promise<void>((resolve) => (answered = resolve))
  let connections = 0
  const answers: { url: string; type: string | undefined; body: string | null }[] = []
  await openApp(page, {
    permissions: [first, second],
    jobs: [
      {
        id: 'j3',
        threadId: 't1',
        prompt: 'ビルドして',
        status: 'running',
        createdAt: now + 1000,
        eventCount: 1,
        events: [{ kind: 'ask', id: 'p1', name: 'Bash', detail: build }],
      },
    ],
    events: async (route) => {
      if (connections++ > 0) return route.fulfill({ status: 204 })
      await firstAnswered
      const thread = { threadId: 't1', title: 'hello', createdAt: now, updatedAt: now + 2000, jobCount: 2, running: true, tasks: [], permissions: [second] }
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: `retry: 600000\ndata: ${JSON.stringify({ type: 'thread', thread })}\n\n` })
    },
  })
  await page.route('**/api/claude/threads/t1/permissions/*', (route) => {
    const request = route.request()
    answers.push({ url: new URL(request.url()).pathname, type: request.headers()['content-type'], body: request.postData() })
    if (answers.length === 1) answered()
    return route.fulfill({ status: 204 })
  })

  // 見出しの帯は出さず、数は読み上げの名前に入れる（1 つずつ警告の色のカード）
  const list = page.locator('.claude-permissions')
  await expect(page.getByRole('region', { name: '許可を待っています（2）' })).toBeVisible()
  const items = list.locator('.claude-permission')
  // コマンドは切らずに全部出す。説明・サブエージェント・わけ・残りの時間
  await expect(items.nth(0).locator('.claude-permission-detail')).toHaveText(build)
  await expect(items.nth(0)).toContainText('コマンドを実行')
  await expect(items.nth(0)).toContainText('ビルドし直す')
  await expect(items.nth(0).locator('.claude-permission-left')).toHaveText('あと 10 分で断ります')
  await expect(items.nth(1)).toContainText('サブエージェント「リリースを確かめる」から')
  await expect(items.nth(1)).toContainText('permissions.ask')
  await expect(items.nth(1).locator('.claude-permission-left')).toHaveText(/^あと \d+ 秒で断ります$/)
  // 許可のボタンにはフォーカスを置かない（1 つのキーで許可させない）
  expect(await page.evaluate(() => document.activeElement?.classList.contains('claude-allow') ?? false)).toBe(false)
  // ジョブの中の出来事と、待っているあいだの言葉。会話の一覧と Claude のボタンにも印
  // 動いているジョブの最後のまとまりは、たたんでも最後の 1 行を出す
  await expect(page.locator('.claude-tool.ask')).toContainText('許可を求めました：')
  await expect(page.locator('.claude-status.running')).toContainText('許可を待っています…')
  await page.locator('.claude-thread-button').click()
  await expect(page.getByRole('option', { name: /hello/ })).toContainText('許可待ち')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await expect(page.locator('.claude-toggle')).toHaveClass(/waiting/)

  await items.nth(0).getByRole('button', { name: '許可する' }).click()
  await expect.poll(() => answers).toEqual([{ url: '/api/claude/threads/t1/permissions/p1', type: 'application/json', body: '{"decision":"allow"}' }])
  // SSE で一覧が変わると、答えたものが消える
  await expect(page.getByRole('region', { name: '許可を待っています（1）' })).toBeVisible()
  await items.nth(0).getByRole('button', { name: '断る' }).click()
  await expect.poll(() => answers.map((answer) => answer.body)).toEqual(['{"decision":"allow"}', '{"decision":"deny"}'])
  await expect(items.nth(0).getByRole('button', { name: '断る' })).toBeDisabled()

  // パネルを閉じても、Claude のボタンに印が残る
  await page.locator('.claude-log').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Escape')
  await expect(page.locator('.claude-panel')).toHaveCount(0)
  await expect(page.locator('.claude-toggle')).toHaveClass(/waiting/)
})

test('shows how each question ended in the job, and one left unanswered when the job ended', async ({ page }) => {
  const now = Date.now()
  await openApp(page, {
    jobs: [
      {
        id: 'j4',
        threadId: 't1',
        prompt: 'いろいろ',
        status: 'failed',
        createdAt: now + 1000,
        eventCount: 6,
        events: [
          { kind: 'ask', id: 'q1', name: 'Bash', detail: 'make' },
          { kind: 'answer', id: 'q1', result: 'allowed' },
          { kind: 'ask', id: 'q2', name: 'Bash', detail: 'make clean', agent: '片付ける' },
          { kind: 'answer', id: 'q2', result: 'expired' },
          { kind: 'ask', id: 'q3', name: 'Bash', detail: 'make install' },
          { kind: 'error', message: 'サーバーが止まったので途切れました' },
        ],
      },
    ],
  })
  // 許可の出来事は「▸ 動かした 3件（1 件は断った）」にたたむ（誤りは、たたまない）
  await expect(page.locator('.claude-tools-toggle').last()).toHaveText('▸ 動かした 3件（1 件は断った）')
  await page.locator('.claude-tools-toggle').last().click()
  await expect(page.locator('.claude-tool.answer')).toHaveText(['許可しました', '時間切れで断りました'])
  await expect(page.locator('.claude-tool.ask')).toHaveText([
    '許可を求めました：make',
    '許可を求めました（サブエージェント「片付ける」）：make clean',
    '許可を求めました：make install（答えないまま途切れました）',
  ])
  await expect(page.locator('.claude-permissions')).toHaveCount(0)
  await expect(page.locator('.claude-toggle')).not.toHaveClass(/waiting/)
})

test('C on the canvas opens the answers panel, and C again opens the chat with the empty prompt box focused (MAI-91)', async ({ page }) => {
  await openApp(page, {}, { open: false })
  await expect(panel(page)).toHaveCount(0)
  await expect(answerPanel(page)).toHaveCount(0)
  await page.keyboard.press('c')
  await expect(answerPanel(page)).toBeVisible()
  await expect(answerPanel(page)).toBeFocused()
  await expect(panel(page)).toBeHidden()
  await page.keyboard.press('c')
  await expect(panel(page)).toBeVisible()
  await expect(answerPanel(page)).toBeHidden()
  await expect(promptBox(page)).toBeFocused()
  // 押した c は入力欄に入らない。選んでいる所は添えない（添えるのは Ctrl+Alt+Enter）
  await expect(promptBox(page)).toHaveValue('')
  await expect(page.locator('.claude-attachment')).toHaveCount(0)
  expect(await selectedIds(page)).toHaveLength(1)
})

test('C with the panel open moves the focus back to the prompt box and keeps what was written (MAI-91)', async ({ page }) => {
  const root = await openApp(page)
  await promptBox(page).fill('途中まで書いた')
  const rect = (await root.boundingBox())!
  await page.mouse.click(rect.x + 140, rect.y + 140)
  await expect(promptBox(page)).not.toBeFocused()
  await page.keyboard.press('c')
  // 閉じない
  await expect(panel(page)).toBeVisible()
  await expect(promptBox(page)).toBeFocused()
  await expect(promptBox(page)).toHaveValue('途中まで書いた')
})

test('holding C opens the answers panel only, and the chat opened by the next C gets no c typed (MAI-91)', async ({ page }) => {
  await openApp(page, {}, { open: false })
  await page.keyboard.down('c')
  await expect(answerPanel(page)).toBeFocused()
  // キーリピート（repeat の keydown）では、チャットに移らない
  await page.keyboard.down('c')
  await page.keyboard.down('c')
  await page.keyboard.up('c')
  await expect(answerPanel(page)).toBeVisible()
  await expect(panel(page)).toBeHidden()
  // 離してから押すとチャットに移る。押し続けても、キーリピート（フォーカスを移した入力欄に届く）は入らない
  await page.keyboard.down('c')
  await expect(promptBox(page)).toBeFocused()
  await page.keyboard.down('c')
  await page.keyboard.down('c')
  await page.keyboard.up('c')
  await expect(promptBox(page)).toHaveValue('')
  // 離したあとに入力欄で押せば、押し続けても文字になる
  await page.keyboard.press('c')
  await page.keyboard.down('c')
  await page.keyboard.down('c')
  await page.keyboard.up('c')
  await expect(promptBox(page)).toHaveValue('ccc')
})

test('C in the prompt box is just a letter (MAI-91)', async ({ page }) => {
  await openApp(page)
  await promptBox(page).click()
  await page.keyboard.type('cC')
  await expect(promptBox(page)).toHaveValue('cC')
  await expect(promptBox(page)).toBeFocused()
})

test('C with Ctrl, Meta or Shift does not open the panel (MAI-91)', async ({ page }) => {
  await openApp(page, {}, { open: false })
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Meta+c')
  await page.keyboard.press('Shift+C')
  await settle(page)
  await expect(panel(page)).toHaveCount(0)
  await expect(answerPanel(page)).toHaveCount(0)
})

test('C is typed as a letter while editing a note or a card, without opening the panel (MAI-91)', async ({ page }) => {
  const root = await openApp(page, {}, { open: false })
  // 付箋の文字の編集
  const note = await noteCenter(page)
  await page.mouse.dblclick(note.x, note.y)
  const textEditor = page.locator('.canvcode-text-editor')
  await expect(textEditor).toBeFocused()
  await page.keyboard.press('c')
  await expect(textEditor).toContainText('c')
  await settle(page)
  await expect(panel(page)).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(textEditor).toHaveCount(0)

  // カードのその場の編集（CodeMirror）
  const rect = (await root.boundingBox())!
  await page.mouse.dblclick(rect.x + 140, rect.y + 140)
  const content = page.locator('.canvcode-document-editor .cm-content')
  await expect(content).toBeFocused()
  await expect(content).toContainText('Card')
  await page.keyboard.press('c')
  await expect(content).toContainText('c')
  await settle(page)
  await expect(panel(page)).toHaveCount(0)
})

test('C does nothing in the fullscreen file editor (MAI-91)', async ({ page }) => {
  await openApp(page, {}, { open: false })
  await page.getByRole('button', { name: '☰' }).click()
  await page.locator('.sidebar-title', { hasText: 'Input test' }).click()
  const content = page.locator('.file-editor .cm-content')
  await expect(content).toBeFocused()
  await expect(content).toContainText('Card')
  await page.keyboard.press('c')
  await expect(content).toContainText('c')
  // 入力欄の外（フォーカスのない所）で押しても開かない
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('c')
  await settle(page)
  await expect(panel(page)).toHaveCount(0)
  await expect(page.locator('.file-editor')).toBeVisible()
})

test('chooses the model and effort next to the send button, per thread (MAI-106)', async ({ page }) => {
  const catalog = {
    models: [
      { value: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { value: 'claude-opus-4-6', label: 'Opus 4.6', efforts: ['low', 'medium', 'high', 'max'] },
      { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', efforts: [] },
    ],
    default: { value: 'opus', label: 'Opus 5.5' },
    fromClaude: true,
  }
  await page.route('**/api/claude/models', (route) => route.fulfill({ json: catalog }))
  const sent: Record<string, unknown>[] = []
  await page.route('**/api/claude/jobs', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    sent.push(body)
    const job = {
      id: `j${sent.length + 1}`,
      threadId: (body.threadId as string | undefined) ?? `00000000-0000-4000-8000-00000000000${sent.length}`,
      prompt: body.prompt,
      status: 'done',
      createdAt: Date.now(),
      durationMs: 1200,
      costUsd: 0.45,
      ...(body.model ? { model: body.model } : {}),
      ...(body.effort ? { effort: body.effort } : {}),
      eventCount: 1,
      events: [{ kind: 'text', text: 'ok' }],
    }
    await route.fulfill({ status: 201, json: { job } })
  })
  await openApp(page)
  const button = page.locator('.claude-model-button')
  const popover = page.locator('.claude-model-popover')
  const modelSlider = popover.getByRole('slider', { name: 'Model' })
  const effortSlider = popover.getByRole('slider', { name: 'Effort' })
  // 会話 t1 は既定で頼んだもの。既定で動くモデルの名前を添える
  await expect(button).toHaveText('既定（Opus 5.5）')

  // 押すと上に開く。Model の段は系統ごとの最新版（この一覧では Haiku 4.5・Opus 5.5 の 2 段）で、既定なら既定で動くモデルの段。
  // Effort が既定ならつまみを出さない
  await button.click()
  await expect(popover).toBeVisible()
  await expect(modelSlider).toHaveAttribute('aria-valuemax', '1')
  await expect(modelSlider).toHaveAttribute('aria-valuenow', '1')
  await expect(modelSlider).toHaveAttribute('aria-valuetext', '既定（Opus 5.5）')
  await expect(effortSlider).toHaveAttribute('aria-valuetext', '既定')
  await expect(effortSlider.locator('.claude-stops-knob')).toHaveCount(0)

  // 古いバージョンは「Model ›」で開く一覧から選ぶ（系統ごとにまとめ、新しいものが先）。選ぶとスライダーに戻り、その系統の段に置く
  await popover.getByRole('button', { name: /^Model/ }).click()
  await expect(popover.getByRole('radio')).toHaveText([/^既定（Opus 5\.5）/, 'Haiku 4.5', 'Opus 5.5', 'Opus 4.6'])
  await expect(popover.getByRole('radio', { checked: true })).toBeFocused()
  await popover.getByRole('radio', { name: 'Opus 4.6' }).click()
  await expect(modelSlider).toHaveAttribute('aria-valuetext', 'Opus 4.6')
  await expect(modelSlider).toHaveAttribute('aria-valuenow', '1')
  await expect(popover.getByRole('button', { name: /^Model/ })).toBeFocused()
  // Effort の段は、そのモデルで選べるものだけ。段を押して選ぶ
  await expect(effortSlider).toHaveAttribute('aria-valuemax', '3')
  await clickStop(effortSlider, 2, 4)
  await expect(effortSlider).toHaveAttribute('aria-valuetext', 'High')
  await expect(button).toHaveText('Opus 4.6 · High')
  // 効かないモデルでは effort を選べない（選んでいた effort は既定に戻る）
  await clickStop(modelSlider, 0, 2)
  await expect(effortSlider).toHaveAttribute('aria-disabled', 'true')
  await expect(effortSlider).toHaveAttribute('aria-valuetext', 'なし')
  await expect(button).toHaveText('Haiku 4.5')
  // キーでも選べる（→ で右の段：Opus の最新版）
  await modelSlider.focus()
  await page.keyboard.press('ArrowRight')
  await expect(button).toHaveText('Opus 5.5')
  // つまみを引いて選ぶ（左端から右端へ引くと Max。← で 1 つ戻して XHigh）
  const box = (await effortSlider.boundingBox())!
  await page.mouse.move(box.x + 17, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 17, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect(effortSlider).toHaveAttribute('aria-valuetext', 'Max')
  await page.keyboard.press('ArrowLeft')
  await expect(button).toHaveText('Opus 5.5 · XHigh')
  // 一覧で Esc を押すと、まずスライダーに戻る
  await popover.getByRole('button', { name: /^Model/ }).click()
  await page.keyboard.press('Escape')
  await expect(modelSlider).toBeVisible()
  // Esc は欄だけを閉じる（パネルは閉じない）
  await page.keyboard.press('Escape')
  await expect(popover).toHaveCount(0)
  await expect(panel(page)).toBeVisible()
  await expect(button).toBeFocused()

  // 送ると、選んだモデルと effort で頼み、終わった行に添える
  await promptBox(page).fill('続き')
  await page.getByRole('button', { name: '送る' }).click()
  await expect.poll(() => sent.length).toBe(1)
  expect(sent[0]).toMatchObject({ prompt: '続き', threadId: 't1', model: 'opus', effort: 'xhigh' })
  // 答えの右に、頼んだモデルと effort の札。かかった時間と費用はツールチップ
  await expect(page.locator('.claude-answer-model').last()).toHaveText('Opus 5.5 · XHigh')
  await expect(page.locator('.claude-answer-model').last()).toHaveAttribute('title', '1.2 秒・$0.45')

  // 新しい会話は、最後に選んだ値から始める（ブラウザに覚える）
  await page.getByRole('button', { name: '新しい会話' }).click()
  await expect(button).toHaveText('Opus 5.5 · XHigh')
  await button.click()
  // 「既定に戻す」で、モデルも effort も既定に（既定なら出さない）
  await popover.getByRole('button', { name: '既定に戻す' }).click()
  await expect(button).toHaveText('既定（Opus 5.5）')
  await expect(popover.getByRole('button', { name: '既定に戻す' })).toHaveCount(0)
  // 欄の外を押すと閉じる
  await page.locator('.claude-log').click({ position: { x: 10, y: 10 } })
  await expect(popover).toHaveCount(0)
  await promptBox(page).fill('新しく')
  await page.getByRole('button', { name: '送る' }).click()
  await expect.poll(() => sent.length).toBe(2)
  expect(sent[1]).not.toHaveProperty('model')
  expect(sent[1]).not.toHaveProperty('effort')
  await expect(page.locator('.claude-answer-model').last()).toHaveText('既定（Opus 5.5）')
  await expect(page.locator('.claude-answer-model').last()).toHaveAttribute('title', '1.2 秒・$0.45')
})

test('restores the model and effort of a thread when it is opened again (MAI-106)', async ({ page }) => {
  await page.route('**/api/claude/models', (route) =>
    route.fulfill({ json: { models: [{ value: 'claude-opus-4-6', label: 'Opus 4.6', efforts: ['low', 'high'] }], default: {}, fromClaude: false } }),
  )
  await openApp(page)
  // 前の会話 t2 は Opus 4.6・Low で頼んだもの（あとから足した差し替えが先に当たるので、読み直すと一覧に出る）
  const now = Date.now()
  const t1 = { threadId: 't1', title: 'hello', createdAt: now, updatedAt: now, jobCount: 1, running: false, tasks: [], permissions: [] }
  const t2 = { threadId: 't2', title: 'older', createdAt: now - 60_000, updatedAt: now - 60_000, jobCount: 1, running: false, model: 'claude-opus-4-6', effort: 'low' }
  await page.route('**/api/claude/threads', (route) => route.fulfill({ json: { threads: [t1, t2] } }))
  await page.route('**/api/claude/threads/t2', (route) => route.fulfill({ json: { jobs: [] } }))
  await page.reload()
  await openChat(page)
  await page.locator('.claude-thread-button').click()
  await page.getByRole('option', { name: 'older' }).click()
  await expect(page.locator('.claude-thread-name')).toHaveText('older')
  await expect(page.locator('.claude-model-button')).toHaveText('Opus 4.6 · Low')
  await page.locator('.claude-thread-button').click()
  await page.getByRole('option', { name: 'hello' }).click()
  // 既定で動くモデルがわからなければ「既定」だけ
  await expect(page.locator('.claude-model-button')).toHaveText('既定')
  // 一覧を Claude Code に聞けなかったときは、そう書く。既定で動くモデルの段がわからなければ、つまみを出さない
  await page.locator('.claude-model-button').click()
  await expect(page.locator('.claude-model-note')).toContainText('聞けなかった')
  const modelSlider = page.getByRole('slider', { name: 'Model' })
  await expect(modelSlider).toHaveAttribute('aria-valuetext', '既定')
  await expect(modelSlider.locator('.claude-stops-knob')).toHaveCount(0)
})

// 選ぶ欄のスライダーの段を押す（段の中心は、両端からつまみの半分の 17px 内側に等しく並ぶ）
async function clickStop(slider: Locator, index: number, count: number) {
  const box = (await slider.boundingBox())!
  const x = 17 + (box.width - 34) * (count <= 1 ? 0 : index / (count - 1))
  await slider.click({ position: { x, y: box.height / 2 } })
}

// 全画面のエディタを開く（サイドバーから）
async function openFileEditor(page: Page) {
  // サイドバーが閉じていれば開く
  if (await page.getByRole('button', { name: '☰' }).isVisible()) await page.getByRole('button', { name: '☰' }).click()
  await page.locator('.sidebar-title', { hasText: 'Input test' }).click()
  await expect(page.locator('.file-editor .cm-content')).toBeFocused()
}

// 点の上にあるのが Claude のパネルか（ほかのものの裏に隠れていないか）
async function panelOnTop(page: Page) {
  const box = (await panel(page).boundingBox())!
  return page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.claude-panel')), {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  })
}

const editorView = (page: Page, label: string) => page.locator('.file-editor-modes button', { hasText: new RegExp(`^${label}$`) })

test('shows the panel in place of the preview in the fullscreen file editor (MAI-102)', async ({ page }) => {
  await openApp(page, {}, { open: false })
  await page.route('**/api/refs', (route) => route.fulfill({ status: 200, json: {} }))
  await openFileEditor(page)
  await expect(panel(page)).toHaveCount(0)
  await expect(page.locator('.file-editor-preview')).toBeVisible()

  // 「Claude に頼む」で、選んでいる行を添えて右半分に出す（エディタの裏に隠れない）
  await page.getByRole('button', { name: 'Claude に頼む', exact: true }).click()
  await expect(panel(page)).toBeVisible()
  expect(await panelOnTop(page)).toBe(true)
  await expect(editorView(page, 'Claude')).toHaveClass('active')
  await expect(page.locator('.file-editor-preview')).toBeHidden()
  await expect(page.locator('.claude-attachment')).toContainText('Input test の 1〜1 行')
  await expect(promptBox(page)).toBeFocused()
  const editorBox = (await page.locator('.file-editor-body').boundingBox())!
  const panelBox = (await panel(page).boundingBox())!
  expect(Math.abs(panelBox.x - (editorBox.x + editorBox.width / 2))).toBeLessThan(2)
  expect(Math.abs(panelBox.x + panelBox.width - (editorBox.x + editorBox.width))).toBeLessThan(2)
  expect(Math.abs(panelBox.y - editorBox.y)).toBeLessThan(2)

  // プレビューに切り替えるとパネルを隠し（閉じない）、Claude に戻すと書きかけの文が残っている
  await promptBox(page).fill('draft text')
  await editorView(page, 'プレビュー').click()
  await expect(panel(page)).toBeHidden()
  await expect(page.locator('.file-editor-preview')).toBeVisible()
  await editorView(page, 'Claude').click()
  await expect(panel(page)).toBeVisible()
  await expect(promptBox(page)).toHaveValue('draft text')
  await expect(promptBox(page)).toBeFocused()

  // Esc はパネルを閉じ、エディタは閉じない。前の表示（プレビュー）に戻る
  await page.keyboard.press('Escape')
  await expect(panel(page)).toHaveCount(0)
  await expect(page.locator('.file-editor')).toBeVisible()
  await expect(editorView(page, 'プレビュー')).toHaveClass('active')

  // 表示の「Claude」で開ける。Ctrl+Enter は送るキーなので、エディタを閉じない
  await editorView(page, 'Claude').click()
  await expect(panel(page)).toBeVisible()
  await expect(promptBox(page)).toBeFocused()
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(page.locator('.file-editor')).toBeVisible()
})

test('moves the panel between the canvas and the file editor without closing it (MAI-102)', async ({ page }) => {
  await openApp(page)
  await page.route('**/api/refs', (route) => route.fulfill({ status: 200, json: {} }))
  await promptBox(page).fill('kept')
  // パネルを開いたままエディタを開くと、右半分に出る
  await openFileEditor(page)
  await expect(panel(page)).toBeVisible()
  expect(await panelOnTop(page)).toBe(true)
  await expect(editorView(page, 'Claude')).toHaveClass('active')
  await expect(promptBox(page)).toHaveValue('kept')

  // 「選んでいる所を添える」と Ctrl+Alt+Enter は、エディタで選んでいる行を添える（エディタは閉じない）
  await page.getByRole('button', { name: '選んでいる所を添える' }).click()
  await expect(page.locator('.claude-attachment')).toContainText('Input test の 1〜1 行')
  await page.locator('.claude-attachment button').click()
  await page.locator('.file-editor .cm-content').click()
  await page.keyboard.press('ControlOrMeta+Alt+Enter')
  await expect(page.locator('.claude-attachment')).toContainText('Input test の 1〜1 行')
  await expect(page.locator('.file-editor')).toBeVisible()

  // エディタを閉じると、キャンバスの右に戻る
  await page.locator('.file-editor-close').click()
  await expect(page.locator('.file-editor')).toHaveCount(0)
  await expect(panel(page)).toBeVisible()
  expect(await panelOnTop(page)).toBe(true)
  const viewport = page.viewportSize()!
  const box = (await panel(page).boundingBox())!
  expect(Math.abs(box.x + box.width - viewport.width)).toBeLessThan(2)
  expect(Math.round(box.width)).toBe(381)
  await expect(promptBox(page)).toHaveValue('kept')
})

test('keeps the scroll of the conversation, and the keys of the panel, when the panel moves into the file editor (MAI-102)', async ({ page }) => {
  const now = Date.now()
  // 会話の欄がスクロールするほどの長さ
  const jobs = Array.from({ length: 30 }, (_, i) => ({
    id: `k${i}`, threadId: 't1', prompt: `質問 ${i}`, status: 'done', createdAt: now + 60_000 + i, eventCount: 1, events: [{ kind: 'text', text: `答え ${i}\n\n${'長い答え。'.repeat(20)}` }],
  }))
  await openApp(page, { jobs })
  await page.route('**/api/refs', (route) => route.fulfill({ status: 200, json: {} }))
  const log = page.locator('.claude-log')
  // 途中まで読み返した位置
  await log.evaluate((el) => {
    el.scrollTop = 300
    el.dispatchEvent(new Event('scroll'))
  })
  await openFileEditor(page)
  await expect(panel(page)).toBeVisible()
  await expect.poll(() => log.evaluate((el) => el.scrollTop)).toBe(300)
  // プレビューに切り替えて戻しても、閉じても同じ所
  await editorView(page, 'プレビュー').click()
  await editorView(page, 'Claude').click()
  await expect.poll(() => log.evaluate((el) => el.scrollTop)).toBe(300)

  // パネルの中のボタンの上の Ctrl+Enter では、エディタを閉じない
  await page.getByRole('button', { name: '新しい会話' }).focus()
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(page.locator('.file-editor')).toBeVisible()

  // プレビューで隠したまま、ブラウザの「戻る」で閉じても、次に開くときは右半分に出る
  await editorView(page, 'プレビュー').click()
  await expect(panel(page)).toBeHidden()
  await page.goBack()
  await expect(page.locator('.file-editor')).toHaveCount(0)
  await expect(panel(page)).toBeVisible()
  await openFileEditor(page)
  await expect(panel(page)).toBeVisible()
  expect(await panelOnTop(page)).toBe(true)
})

test('the Claude button opens the answers panel, and the chat is one more step (it keeps what was written)', async ({ page }) => {
  await openApp(page, {}, { open: false })
  await page.route('**/api/refs', (route) => route.fulfill({ status: 200, json: { refId: 'ref:TEST000001' } }))
  // 右上の「質問」では、質問のタブだけ（まだ質問がなければ、聞き方を書く）
  await expect(page.locator('.claude-toggle')).toHaveText('作業')
  await page.locator('.claude-toggle').click()
  await expect(answerPanel(page)).toBeVisible()
  await expect(answerPanel(page)).toContainText('付箋の作業は、まだありません')
  await expect(answerPanel(page).getByRole('tab', { name: '作業' })).toHaveAttribute('aria-selected', 'true')
  await expect(panel(page)).toBeHidden()
  const viewport = page.viewportSize()!
  const box = (await answerPanel(page).boundingBox())!
  expect(Math.abs(box.x + box.width - viewport.width)).toBeLessThan(2)

  // 「会話」のタブで会話。「質問」のタブに戻っても、書きかけの文は残る
  await answerPanel(page).getByRole('tab', { name: '会話' }).click()
  await expect(panel(page)).toBeVisible()
  await expect(promptBox(page)).toBeFocused()
  await promptBox(page).fill('書きかけ')
  await panel(page).getByRole('tab', { name: '作業' }).click()
  await expect(answerPanel(page)).toBeVisible()
  await expect(answerPanel(page)).toBeFocused()
  await expect(panel(page)).toBeHidden()
  await answerPanel(page).getByRole('tab', { name: '会話' }).click()
  await expect(promptBox(page)).toBeFocused()
  await expect(promptBox(page)).toHaveValue('書きかけ')

  // 右上の「質問」で閉じ、もう一度押すと、また質問のタブから
  await page.locator('.claude-toggle').click()
  await expect(panel(page)).toHaveCount(0)
  await expect(answerPanel(page)).toHaveCount(0)
  await page.locator('.claude-toggle').click()
  await expect(answerPanel(page)).toBeVisible()
  await expect(panel(page)).toBeHidden()
  // 質問のタブの Esc で閉じる
  await page.keyboard.press('Escape')
  await expect(answerPanel(page)).toHaveCount(0)

  // 選んでいる所を添えて頼む（Ctrl+Alt+Enter）と、チャットを直接開く
  await page.keyboard.press('ControlOrMeta+Alt+Enter')
  await expect(panel(page)).toBeVisible()
  await expect(answerPanel(page)).toBeHidden()
  await expect(page.locator('.claude-attachment')).toBeVisible()
})

test('the file editor shows the chat directly, without the answers panel (MAI-102)', async ({ page }) => {
  await openApp(page, {}, { open: false })
  await page.route('**/api/refs', (route) => route.fulfill({ status: 200, json: {} }))
  // キャンバスで質問のタブを開いたままエディタを開いても、右半分には出さない（プレビューのまま）
  await page.locator('.claude-toggle').click()
  await expect(answerPanel(page)).toBeVisible()
  await openFileEditor(page)
  await expect(answerPanel(page)).toBeHidden()
  await expect(panel(page)).toBeHidden()
  await expect(page.locator('.file-editor-preview')).toBeVisible()

  // 表示の「Claude」は、チャットを直接出す（「会話｜質問」のタブはない）
  await editorView(page, 'Claude').click()
  await expect(panel(page)).toBeVisible()
  expect(await panelOnTop(page)).toBe(true)
  await expect(promptBox(page)).toBeFocused()
  await expect(panel(page).getByRole('tab')).toHaveCount(0)
  await expect(answerPanel(page)).toBeHidden()

  // エディタを閉じると、チャットのままキャンバスの右に戻り、「質問」のタブに移れる
  await page.locator('.file-editor-close').click()
  await expect(page.locator('.file-editor')).toHaveCount(0)
  await expect(panel(page)).toBeVisible()
  await panel(page).getByRole('tab', { name: '作業' }).click()
  await expect(answerPanel(page)).toBeVisible()
  await expect(panel(page)).toBeHidden()
})

test('keeps the panel within the right half of the file editor when the conversation has long lines (MAI-102)', async ({ page }) => {
  const now = Date.now()
  // 折り返せない長い行：ツールの行（1 行にして、はみ出す分を省略記号で切る）と、コードブロック（その中で横にスクロールする）。
  // パネルの幅が決まっていないと、パネルがこの行の幅まで広がり、右半分からはみ出した所（送るボタン）が切れていた
  const command = `npx playwright test ${'tests/e2e/claude-panel.spec.ts '.repeat(8)}--project=chromium`
  const code = `const line = "${'abcdefghij'.repeat(20)}"`
  // 長いエラー（区切れない語）は折り返す
  const error = `ENOENT: ${'/very/long/path'.repeat(20)}`
  const events = [
    { kind: 'tool', name: 'Bash', detail: command },
    { kind: 'text', text: '```\n' + code + '\n```' },
    { kind: 'error', message: error },
  ]
  const jobs = [{ id: 'k1', threadId: 't1', prompt: 'long lines', status: 'done', createdAt: now + 60_000, eventCount: events.length, events }]
  await openApp(page, { jobs }, { open: false })
  await page.route('**/api/refs', (route) => route.fulfill({ status: 200, json: {} }))
  await openFileEditor(page)
  await page.getByRole('button', { name: 'Claude に頼む', exact: true }).click()
  await expect(panel(page)).toBeVisible()
  // たたんだ作業を開く
  await page.locator('.claude-tools-toggle').click()
  await expect(page.locator('.claude-tool-detail')).toHaveText(command)

  // パネルは右半分に収まる
  const editorBox = (await page.locator('.file-editor-body').boundingBox())!
  const panelBox = (await panel(page).boundingBox())!
  expect(Math.abs(panelBox.x - (editorBox.x + editorBox.width / 2))).toBeLessThan(2)
  expect(Math.abs(panelBox.x + panelBox.width - (editorBox.x + editorBox.width))).toBeLessThan(2)

  // 送るボタンは切れずに見えていて、押せる（真ん中の点の上にあるのが送るボタン）
  await promptBox(page).fill('question')
  const send = page.locator('.claude-send')
  await expect(send).toBeInViewport({ ratio: 1 })
  const sendBox = (await send.boundingBox())!
  expect(sendBox.x + sendBox.width).toBeLessThanOrEqual(editorBox.x + editorBox.width)
  expect(
    await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.claude-send')), {
      x: sendBox.x + sendBox.width / 2,
      y: sendBox.y + sendBox.height / 2,
    }),
  ).toBe(true)

  // 長い行は、パネルの中で切れる（ツールの行）か、スクロールする（コードブロック）
  expect(await page.locator('.claude-tool').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  expect(await page.locator('.claude-text pre').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  await expect(page.locator('.claude-error')).toHaveText(error)
  // 会話の欄そのものは、横にスクロールしない
  expect(await page.locator('.claude-log').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
})

test('shows the whole model popover when the right half of the file editor is narrow (MAI-102)', async ({ page }) => {
  // 右半分（365px）が、選ぶ欄（326px）とその右の送るボタンの分より狭い。選ぶ欄はパネルの左へはみ出して開く
  await page.setViewportSize({ width: 730, height: 720 })
  const catalog = {
    models: [{ value: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }],
    default: { value: 'opus', label: 'Opus 5.5' },
    fromClaude: true,
  }
  await page.route('**/api/claude/models', (route) => route.fulfill({ json: catalog }))
  await openApp(page, {}, { open: false })
  await page.route('**/api/refs', (route) => route.fulfill({ status: 200, json: {} }))
  await openFileEditor(page)
  await page.getByRole('button', { name: 'Claude に頼む', exact: true }).click()
  await expect(panel(page)).toBeVisible()

  await page.locator('.claude-model-button').click()
  const popover = page.locator('.claude-model-popover')
  await expect(popover).toBeVisible()
  const popoverBox = (await popover.boundingBox())!
  const panelBox = (await panel(page).boundingBox())!
  expect(popoverBox.x).toBeLessThan(panelBox.x)
  // 選ぶ欄の左の端は切れずに見えていて、押せる（もとは右半分の外が切れ、「Model ›」の左を押すとエディタに入っていた）
  await expect(popover).toBeInViewport({ ratio: 1 })
  expect(
    await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.claude-model-popover')), {
      x: popoverBox.x + 4,
      y: popoverBox.y + popoverBox.height / 2,
    }),
  ).toBe(true)
})

test('cuts an answer of the chat into an AI note, sends the chat answer with it, and the chip goes back to the job (claude-chat-tab-plan 5)', async ({ page }) => {
  await openApp(page)
  const asked: Record<string, unknown>[] = []
  // 付箋の作業を頼む（docs/ai-note-tasks-plan.md）
  await page.route('**/api/claude/note-tasks', (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    asked.push(body)
    const id = '11111111-2222-4333-8444-555555555555'
    const job = { id, threadId: id, prompt: body.instruction, status: 'done', createdAt: 0, note: { noteId: body.noteId, canvasId: body.canvasId }, eventCount: 0, events: [] }
    return route.fulfill({ status: 201, json: { job } })
  })
  const before = await page.evaluate(() => (window as any).canvcode.editor.index.allIds().length)

  // 答えにマウスを乗せると「📌 付箋に切り出す」「コピー」が出る
  const actions = page.locator('.claude-answer-actions').first()
  await expect(actions).toHaveCSS('opacity', '0')
  await page.locator('.claude-job').first().hover()
  await expect(actions).toHaveCSS('opacity', '1')
  await actions.getByRole('button', { name: '📌 付箋に切り出す' }).click()

  // 画面の真ん中に、会話の札を添えた AI 付箋を置き、文字の編集を始める（会話には何も足さない）
  const placed = await page.evaluate((count) => {
    const editor = (window as any).canvcode.editor
    const ids: string[] = editor.index.allIds()
    if (ids.length !== count + 1) return null
    const id = ids.find((id) => editor.getNode(id)?.meta?.ai)
    return { id, ai: editor.getNode(id).meta.ai, editing: editor.session.get().editingId }
  }, before)
  expect(placed).toMatchObject({
    ai: { contexts: [{ kind: 'chat', threadId: 't1', jobId: 'j1', label: '会話「hello」の答え', turns: [{ question: 'question', answer: 'Answer from Claude' }] }] },
  })
  expect(placed!.editing).toBe(placed!.id)
  await expect(page.locator('.claude-prompt')).toHaveCount(1)
  await expect(page.locator('.ai-note-chip.chat')).toContainText('💬 会話「hello」の答え')

  // 書いて Ctrl+Enter で送ると、前の答えとして会話の答えを渡す
  await page.keyboard.type('つまりどういうこと？')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect.poll(() => asked.length).toBe(1)
  expect(asked[0]).toMatchObject({ instruction: 'つまりどういうこと？', previous: [{ question: 'question', answer: 'Answer from Claude' }] })

  // 作業のタブに移ってから、札の ↗ で会話のそのジョブへ戻る（少しのあいだ色が付く）
  await panel(page).getByRole('tab', { name: '作業' }).click()
  await expect(panel(page)).toBeHidden()
  await page.locator('.ai-note-chip.chat').getByRole('button', { name: '↗ 会話へ' }).click()
  await expect(panel(page)).toBeVisible()
  await expect(page.locator('.claude-job[data-job-id="j1"]')).toHaveClass(/highlighted/)
  await expect(page.locator('.claude-job[data-job-id="j1"]')).not.toHaveClass(/highlighted/, { timeout: 5000 })
})

// openApp で置いた付箋を、答えを持つ AI 付箋にする。付箋の id を返す
async function answerTheNote(page: Page, question: string, body: string) {
  return page.evaluate(
    ({ question, body }) => {
      const editor = (window as any).canvcode.editor
      const id = editor.index.allIds().find((id: string) => editor.getNode(id)?.type === 'note')
      editor.transact('answer', (tx: any) => {
        const node = editor.getNode(id)
        tx.put({ ...node, meta: { ...node.meta, ai: { contexts: [], answer: { body, related: [], model: 'claude-sonnet-5-5', question, answeredAt: Date.now() } } } })
      })
      return id as string
    },
    { question, body },
  )
}

test('continues a question asked with a note in the chat: the chip waits above the prompt box and goes with the next prompt (claude-chat-tab-plan 6)', async ({ page }) => {
  await openApp(page)
  const noteId = await answerTheNote(page, 'コンテキストとは？', '答えの本文')
  const sent: Record<string, unknown>[] = []
  await page.route('**/api/claude/jobs', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    sent.push(body)
    const job = { id: 'j2', threadId: 't1', prompt: body.prompt, imports: body.imports, status: 'done', createdAt: Date.now(), eventCount: 1, events: [{ kind: 'text', text: 'わかりました' }] }
    await route.fulfill({ status: 201, json: { job } })
  })

  // 質問のタブで答えを開き、「会話で続ける」→「いまの会話「hello」に入れる」
  await panel(page).getByRole('tab', { name: '作業' }).click()
  await answerPanel(page).locator('.question-row-main', { hasText: 'コンテキストとは？' }).click()
  await answerPanel(page).getByRole('button', { name: '会話で続ける' }).click()
  const menu = answerPanel(page).getByRole('menu')
  await expect(menu.getByRole('menuitem')).toHaveText(['いまの会話「hello」に入れる', '新しい会話にする'])
  // Esc はメニューだけを閉じる
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(answerPanel(page)).toBeVisible()
  await answerPanel(page).getByRole('button', { name: '会話で続ける' }).click()
  await menu.getByRole('menuitem', { name: 'いまの会話「hello」に入れる' }).click()

  // 会話のタブに移り、入力欄の上に札を置いて、入力欄にフォーカスする（取り込むだけでは送らない）
  await expect(panel(page)).toBeVisible()
  await expect(page.locator('.claude-import-chip')).toHaveText(/付箋の質問を取り込みます「コンテキストとは？」/)
  await expect(promptBox(page)).toBeFocused()
  await expect(page.locator('.claude-send')).toBeDisabled()
  expect(sent).toEqual([])

  // 次に送る文と一緒に渡す。頼んだ文（吹き出し）はユーザーが書いた文だけで、その上にカードが出る
  await page.keyboard.type('もっと詳しく')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect.poll(() => sent.length).toBe(1)
  expect(sent[0]).toMatchObject({
    prompt: 'もっと詳しく',
    threadId: 't1',
    imports: [{ label: 'コンテキストとは？', question: 'コンテキストとは？', answer: '答えの本文', noteId, canvasId: 'canvas:input-test' }],
  })
  await expect(page.locator('.claude-import-chip')).toHaveCount(0)
  const card = page.locator('.claude-job[data-job-id="j2"] .claude-import-card')
  await expect(card).toContainText('付箋の質問を取り込みました「コンテキストとは？」とその答え')
  await expect(page.locator('.claude-job[data-job-id="j2"] .claude-prompt-text')).toHaveText('もっと詳しく')

  // 閉じて開き直しても、使った札は戻らない（もう一度取り込まない）
  await page.locator('.claude-log').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Escape')
  await expect(panel(page)).toHaveCount(0)
  await openChat(page)
  await expect(page.locator('.claude-job[data-job-id="j2"]')).toBeVisible()
  await expect(page.locator('.claude-import-chip')).toHaveCount(0)

  // カードの ↗ で、付箋の横に答えを開く
  await card.getByRole('button', { name: '↗ 付箋へ' }).click()
  await expect(page.locator('.answer-popover')).toBeVisible()
  await expect(page.locator('.answer-popover')).toContainText('答えの本文')
})

test('asks one question from the prompt box without adding it to the chat, shows the answer in the chat, keeps the 質問 mode, and cuts it to a note (docs/ai-note-tasks-plan.md の E)', async ({ page }) => {
  await openApp(page)
  const id = '00000000-0000-4000-8000-0000000000a1'
  const asked: Record<string, unknown>[] = []
  const now = Date.now()
  const stored = { id, threadId: 't1', question: 'コンテキストとは？', previous: [{ question: 'question', answer: 'Answer from Claude' }], body: '**会話の外**の答え', model: 'claude-sonnet-5-5', effort: 'medium', status: 'done', createdAt: now + 1000, answeredAt: now + 2000 }
  let answered = false
  await page.route('**/api/claude/answer', (route) => {
    asked.push(route.request().postDataJSON() as Record<string, unknown>)
    answered = true
    const lines = [{ type: 'start', id, threadId: 't1' }, { type: 'answer', answer: { body: stored.body, related: [], model: stored.model } }]
    return route.fulfill({ body: lines.map((line) => JSON.stringify(line)).join('\n') + '\n', contentType: 'application/x-ndjson' })
  })
  await page.route('**/api/claude/threads/t1', (route) =>
    route.fulfill({ json: { jobs: [{ id: 'j1', threadId: 't1', prompt: 'question', status: 'done', createdAt: now, eventCount: 1, events: [{ kind: 'text', text: 'Answer from Claude' }] }], questions: answered ? [stored] : [] } }),
  )
  await page.route('**/api/claude/questions?*', (route) => route.fulfill({ json: { questions: [] } }))
  await page.route('**/api/claude/questions', (route) =>
    route.fulfill({ json: { questions: answered ? [{ kind: 'chat', id, threadId: 't1', threadTitle: 'hello', question: 'コンテキストとは？', model: stored.model, effort: 'medium', answeredAt: stored.answeredAt }] : [] } }),
  )

  // 「質問」にすると、入力欄の言い方が変わる
  const mode = page.getByRole('radiogroup', { name: '送り方' })
  await expect(mode.getByRole('radio', { name: '会話' })).toHaveAttribute('aria-checked', 'true')
  await mode.getByRole('radio', { name: '質問' }).click()
  await expect(promptBox(page)).toHaveAttribute('placeholder', 'この 1 つだけ、会話に入れずに聞く…')
  await promptBox(page).fill('コンテキストとは？')
  await page.getByRole('button', { name: '送る' }).click()

  // 会話の最後の答えを前の答えとして添え、見ている Canvas（Claude がキャンバスを読むため）も送って頼む。送っても「質問」のまま
  await expect.poll(() => asked.length).toBe(1)
  expect(asked[0]).toMatchObject({ question: 'コンテキストとは？', previous: [{ question: 'question', answer: 'Answer from Claude' }], source: { kind: 'chat', threadId: 't1', label: 'コンテキストとは？' } })
  expect(asked[0]!.canvasId).toBe(await page.evaluate(() => (window as any).canvcode.editor.canvasId as string))
  expect(asked[0]).not.toHaveProperty('candidates')
  await expect(mode.getByRole('radio', { name: '質問' })).toHaveAttribute('aria-checked', 'true')
  await expect(promptBox(page)).toHaveValue('')

  // 会話の欄に、「質問」の印の吹き出しと、答えをそのまま出す（会話のジョブは増えない）
  const item = page.locator(`.claude-question[data-question-id="${id}"]`)
  await expect(item.locator('.claude-prompt.question .claude-prompt-tag')).toHaveText('質問')
  await expect(item.locator('.claude-prompt-text')).toHaveText('コンテキストとは？')
  await expect(item.locator('.claude-text strong')).toHaveText('会話の外')
  await expect(item.locator('.claude-answer-model')).toHaveText(/Sonnet/)
  await expect(page.locator('.claude-job:not(.claude-question)')).toHaveCount(1)
  await page.screenshot({ path: test.info().outputPath('chat-question.png') })
  // 会話の質問は、作業のタブの ●N に数えない
  await expect(panel(page).getByRole('tab', { name: '作業' })).toHaveText('作業')

  // 付箋に切り出す：会話の札（この質問と答え・添えた前の答えの写し）を添えた AI 付箋を置く
  await item.hover()
  await item.getByRole('button', { name: '📌 付箋に切り出す' }).click()
  await expect.poll(() =>
    page.evaluate((questionId) => {
      const editor = (window as any).canvcode.editor
      const found = editor.index.allIds().map((nodeId: string) => editor.getNode(nodeId)).find((node: any) => node?.meta?.ai?.contexts?.[0]?.questionId === questionId)
      return found?.meta.ai.contexts[0] ?? null
    }, id),
  ).toMatchObject({ kind: 'chat', threadId: 't1', questionId: id, turns: [{ question: 'question', answer: 'Answer from Claude' }, { question: 'コンテキストとは？', answer: '**会話の外**の答え' }] })

  // 作業のタブには、会話の質問を並べない
  await page.keyboard.press('Escape')
  await panel(page).getByRole('tab', { name: '作業' }).click()
  await expect(answerPanel(page)).toBeVisible()
  await expect(answerPanel(page).locator('.question-row')).toHaveCount(0)
})

test('a question asked with no conversation chosen becomes a new conversation and is chosen (docs/ai-note-tasks-plan.md の 10)', async ({ page }) => {
  await openApp(page)
  const id = '00000000-0000-4000-8000-0000000000b2'
  const now = Date.now()
  const stored = { id, threadId: id, question: '新しく聞く', previous: [], body: '答えです', model: 'claude-sonnet-5-5', effort: 'medium', status: 'done', createdAt: now, answeredAt: now + 1 }
  const asked: Record<string, unknown>[] = []
  await page.route('**/api/claude/answer', (route) => {
    asked.push(route.request().postDataJSON() as Record<string, unknown>)
    const lines = [{ type: 'start', id, threadId: id }, { type: 'answer', answer: { body: stored.body, related: [], model: stored.model } }]
    return route.fulfill({ body: lines.map((line) => JSON.stringify(line)).join('\n') + '\n', contentType: 'application/x-ndjson' })
  })
  await page.route(`**/api/claude/threads/${id}`, (route) =>
    route.fulfill({ json: { thread: { threadId: id, title: '新しく聞く', createdAt: now, updatedAt: now + 1, jobCount: 0, running: false }, jobs: [], questions: [stored] } }),
  )
  await page.getByRole('button', { name: '新しい会話' }).click()
  await page.getByRole('radiogroup', { name: '送り方' }).getByRole('radio', { name: '質問' }).click()
  await promptBox(page).fill('新しく聞く')
  await page.getByRole('button', { name: '送る' }).click()
  await expect.poll(() => asked.length).toBe(1)
  expect(asked[0]).toMatchObject({ source: { kind: 'chat', label: '新しく聞く' } })
  expect(asked[0]!.canvasId).toBe(await page.evaluate(() => (window as any).canvcode.editor.canvasId as string))
  expect((asked[0] as { source: object }).source).not.toHaveProperty('threadId')
  // サーバーが作った会話を選ぶ（質問だけの会話でも「読み込んでいます…」は出さない）
  await expect(page.locator('.claude-thread-name')).toHaveText('新しく聞く')
  await expect(page.locator(`.claude-question[data-question-id="${id}"] .claude-text`)).toHaveText('答えです')
  await expect(panel(page).getByText('読み込んでいます…')).toHaveCount(0)

  // その会話で「会話」で頼むと、最後に答えた質問を取り込んで渡す（Claude Code は、その会話の質問を知らない）
  const started: Record<string, unknown>[] = []
  await page.route('**/api/claude/jobs', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    started.push(body)
    await route.fulfill({ status: 201, json: { job: { id: 'j9', threadId: id, prompt: body.prompt, imports: body.imports, status: 'running', createdAt: Date.now(), eventCount: 0, events: [] } } })
  })
  await page.getByRole('radiogroup', { name: '送り方' }).getByRole('radio', { name: '会話' }).click()
  await promptBox(page).fill('これを表にして')
  await page.getByRole('button', { name: '送る' }).click()
  await expect.poll(() => started.length).toBe(1)
  expect(started[0]).toMatchObject({ prompt: 'これを表にして', threadId: id, imports: [{ label: '新しく聞く', question: '新しく聞く', answer: '答えです', questionId: id }] })
})

test('keeps 調べる done while Claude reads the canvas again after searching the web (docs/question-canvas-tools-plan.md)', async ({ page }) => {
  const now = Date.now()
  // 調べたあと、キャンバスを読んでいる（読むに戻った）会話の質問
  const running = { kind: 'chat', id: 'q-reading', threadId: 't1', label: 'この図の出典は？', status: 'running', step: 'read', searched: true, thinking: '― Web で調べる：出典\n\n― キャンバスを読む', startedAt: now + 1000 }
  const thread = { threadId: 't1', title: 'hello', createdAt: now, updatedAt: now, jobCount: 1, running: false, tasks: [], permissions: [] }
  const snapshot = { type: 'snapshot', threads: [thread], running: [], questions: [running] }
  await openApp(page, { events: (route) => route.fulfill({ body: `retry: 60000\n\ndata: ${JSON.stringify(snapshot)}\n\n`, contentType: 'text/event-stream' }) })
  const steps = page.locator('.claude-question[data-question-id="q-reading"] .answer-view-step')
  await expect(steps).toHaveCount(3)
  await expect(steps.nth(0)).toHaveClass(/current/)
  await expect(steps.nth(1)).toHaveClass(/done/)
  await expect(steps.nth(1)).toContainText('✓ 調べる')
  await expect(steps.nth(2)).toHaveClass(/todo/)
})
