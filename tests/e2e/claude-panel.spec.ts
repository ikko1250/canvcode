import { expect, test, type Page } from '@playwright/test'

// Claude のパネルの回答を選んでコピーしても、キャンバスで選んでいるノードのコピーに横取りされない。
// パネルの中のキー（Delete・矢印・Ctrl+A・Esc）は、キャンバスのショートカットに渡らない。
// バックグラウンドの作業が並び、1 つずつ・まるごと止められる

// claude は、会話 t1 に足すもの（バックグラウンドの作業と、ジョブ）
async function openApp(page: Page, claude: { tasks?: object[]; jobs?: object[] } = {}) {
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
  const thread = { threadId: 't1', title: 'hello', createdAt: now, updatedAt: now, jobCount: 1, running: false, tasks: claude.tasks ?? [] }
  const job = { id: 'j1', threadId: 't1', prompt: 'question', status: 'done', createdAt: now, eventCount: 1, events: [{ kind: 'text', text: 'Answer from Claude' }] }
  await page.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: 'canvas:input-test', rev: 0, records } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [file] } }))
  await page.route('**/api/files/file%3Ainput-test/content', (route) => route.fulfill({ body: '# Card', headers: { etag: '"test"' } }))
  await page.route('**/api/claude/threads', (route) => route.fulfill({ json: { threads: [thread] } }))
  await page.route('**/api/claude/threads/t1', (route) => route.fulfill({ json: { jobs: [job, ...(claude.jobs ?? [])] } }))
  await page.route('**/api/claude/events', (route) => route.fulfill({ status: 204 }))
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
