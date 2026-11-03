import { expect, test, type Page } from '@playwright/test'

// Claude のパネルの回答を選んでコピーしても、キャンバスで選んでいるノードのコピーに横取りされない。
// パネルの中のキー（Delete・矢印・Ctrl+A・Esc）は、キャンバスのショートカットに渡らない。
// バックグラウンドの作業が並び、1 つずつ・まるごと止められる。
// 画面で許可を待っている問い合わせが並び、JSON で答えられ、閉じたパネルの Claude のボタンに印が出る

// claude は、会話 t1 に足すもの（バックグラウンドの作業・待っている問い合わせ・ジョブ）。events は /api/claude/events の差し替え
async function openApp(
  page: Page,
  claude: { tasks?: object[]; permissions?: object[]; jobs?: object[]; events?: Parameters<Page['route']>[1] } = {},
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
  await page.locator('.claude-toggle').click()
  await expect(page.locator('.claude-text').first()).toHaveText('Answer from Claude')
  // キャンバスの copy の処理（window で受ける）が既定の動作を止めたかを記録する
  await page.evaluate(() => {
    ;(window as any).copyPrevented = []
    window.addEventListener('copy', (e) => (window as any).copyPrevented.push(e.defaultPrevented))
  })
  return root
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
