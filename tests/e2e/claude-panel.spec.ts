import { expect, test, type Page } from '@playwright/test'

// Claude のパネルの回答を選んでコピーしても、キャンバスで選んでいるノードのコピーに横取りされない。
// パネルの中のキー（Delete・矢印・Ctrl+A・Esc）は、キャンバスのショートカットに渡らない。
// バックグラウンドの作業が並び、1 つずつ・まるごと止められる。
// 画面で許可を待っている問い合わせが並び、JSON で答えられ、閉じたパネルの Claude のボタンに印が出る。
// C で開く（MAI-91）

// claude は、会話 t1 に足すもの（バックグラウンドの作業・待っている問い合わせ・ジョブ）。events は /api/claude/events の差し替え。
// open が false なら、パネルを開かずに返す（C で開くのを確かめる）
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
  await page.goto('/')
  const root = page.locator('.canvas-container > div[tabindex]')
  await expect(root).toBeVisible()
  expect(await page.evaluate(() => (window as any).canvcode.editor.index.allIds().length)).toBeGreaterThan(1)
  // カード（ワールドの (80, 70) から）を選ぶ
  const rect = (await root.boundingBox())!
  await page.mouse.click(rect.x + 140, rect.y + 140)
  await expect.poll(() => selectedIds(page)).toHaveLength(1)
  if (open) {
    await page.locator('.claude-toggle').click()
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
  // 改行の数はブラウザで違う
  expect(await textSelection(page)).toMatch(/^question\s+Answer from Claude\s+完了$/)
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
  await expect(page.locator('.claude-tool.task')).toHaveText('終わりました：見張り')

  // 作業の一覧。作業があるあいだは、消せないが送れる
  await expect(page.locator('.claude-task-name')).toHaveText(['サブエージェント：論文を探す', 'コマンド：ping 90 times'])
  await expect(page.locator('.claude-tasks-header')).toContainText('バックグラウンドで動いている作業（2）')
  await expect(page.locator('.claude-toggle')).toHaveClass(/running/)
  await expect(page.getByRole('button', { name: '削除' })).toBeDisabled()
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

  const list = page.locator('.claude-permissions')
  await expect(list.locator('.claude-permissions-header')).toHaveText('許可を待っています（2）')
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
  await expect(page.locator('.claude-tool.ask')).toContainText('許可を求めました：')
  await expect(page.locator('.claude-status.running')).toContainText('許可を待っています…')
  await expect(page.locator('.claude-thread-select option[value="t1"]')).toHaveText(/・許可待ち$/)
  await expect(page.locator('.claude-toggle')).toHaveClass(/waiting/)

  await items.nth(0).getByRole('button', { name: '許可する' }).click()
  await expect.poll(() => answers).toEqual([{ url: '/api/claude/threads/t1/permissions/p1', type: 'application/json', body: '{"decision":"allow"}' }])
  // SSE で一覧が変わると、答えたものが消える
  await expect(list.locator('.claude-permissions-header')).toHaveText('許可を待っています（1）')
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
  await expect(page.locator('.claude-tool.answer')).toHaveText(['許可しました', '時間切れで断りました'])
  await expect(page.locator('.claude-tool.ask')).toHaveText([
    '許可を求めました：make',
    '許可を求めました（サブエージェント「片付ける」）：make clean',
    '許可を求めました：make install（答えないまま途切れました）',
  ])
  await expect(page.locator('.claude-permissions')).toHaveCount(0)
  await expect(page.locator('.claude-toggle')).not.toHaveClass(/waiting/)
})

test('C on the canvas opens the panel and focuses the empty prompt box (MAI-91)', async ({ page }) => {
  await openApp(page, {}, { open: false })
  await expect(panel(page)).toHaveCount(0)
  await page.keyboard.press('c')
  await expect(panel(page)).toBeVisible()
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

test('holding C opens the panel without typing c into the prompt box (MAI-91)', async ({ page }) => {
  await openApp(page, {}, { open: false })
  await page.keyboard.down('c')
  await expect(promptBox(page)).toBeFocused()
  // キーリピート（repeat の keydown）は、フォーカスを移した入力欄に届く
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

// 全画面のエディタを開く（サイドバーから）
async function openFileEditor(page: Page) {
  await page.getByRole('button', { name: '☰' }).click()
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
  await page.getByRole('button', { name: '＋ 選んでいる所を添える' }).click()
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
