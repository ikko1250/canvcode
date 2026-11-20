import { expect, test, type Locator, type Page } from '@playwright/test'

// 画面の文字（MAI-112）：DADS に合わせ、画面の文字は 14px を下限にし、読む文（Claude との会話・ダイアログの本文）は 16px・行間 1.5 以上、
// 書体の先頭は同梱の Noto Sans JP（等幅は Noto Sans MONO）、太さは 400 と 700 だけであること。
// 主な場所（デザインパネル・サイドバー・右クリックのメニュー・パイメニュー・Claude のパネル・確認のダイアログ）の、
// 文字を持つ要素の計算後の値を調べる。サーバーの応答だけを差し替える（design-panel.spec.ts と同じ）

const CANVAS_ID = 'canvas:typography-test'
const CHILD_ID = 'canvas:typography-child'
const FILE_ID = 'file:typography-md'
const MD = '# 見出し\n\n本文\n'

function canvas(id: string, title: string, parentCanvasId: string | null, ownerNodeId: string | null, extra: object = {}) {
  return { typeName: 'canvas', id, title, parentCanvasId, ownerNodeId, createdAt: 0, updatedAt: 0, deletedAt: null, trash: null, ...extra }
}

function node(id: string, type: string, x: number, y: number, index: string, props: object) {
  return { typeName: 'node', id, type, parentId: CANVAS_ID, x, y, rotation: 0, index, opacity: 1, locked: false, version: 3, props, meta: {} }
}

async function openApp(page: Page) {
  const records = [
    canvas(CANVAS_ID, 'Typography', null, null),
    canvas(CHILD_ID, '子', CANVAS_ID, 'node:portal'),
    canvas('canvas:typography-trashed', '捨てたキャンバス', null, null, { deletedAt: 1, trash: { batchId: 'canvas:batch-typography', portal: null } }),
    node('node:geo', 'geo', 100, 120, 'a0', { shape: 'rect', w: 120, h: 120, fill: '#e8eefc', stroke: '#3b5bdb', strokeWidth: 2, label: '図形' }),
    node('node:portal', 'portal', 100, 330, 'a1', { targetId: CHILD_ID, role: 'owner', w: 240, h: 170 }),
  ]
  const files = [{ id: FILE_ID, kind: 'markdown', title: 'メモ', path: 'メモ.md', size: MD.length, mtime: 0, hash: 'test', missing: false }]
  const now = Date.now()
  const thread = { threadId: 't1', title: '会話', createdAt: now, updatedAt: now, jobCount: 1, running: false }
  const jobs = [
    {
      id: 'j1', threadId: 't1', prompt: '図形を整理してください', status: 'done', createdAt: now, eventCount: 3,
      events: [
        { kind: 'tool', name: 'read_canvas', detail: 'canvas:typography-test' },
        { kind: 'text', text: '## まとめ\n\n整理しました。`code` を含む本文です。' },
        { kind: 'error', message: 'エラーの例' },
      ],
    },
  ]
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files } }))
  await page.route('**/api/claude/threads', (route) => route.fulfill({ json: { threads: [thread] } }))
  await page.route('**/api/claude/threads/t1', (route) => route.fulfill({ json: { jobs } }))
  await page.route('**/api/claude/events', (route) => route.fulfill({ status: 204 }))
  await page.goto('/')
  await expect(canvasRoot(page)).toBeVisible()
}


// 答えを持つ AI 付箋を置き（会話の答えの札も添える）、画面の真ん中に寄せる。付箋の id を返す（docs/claude-chat-tab-plan.md の 9）
async function addAiNote(page: Page): Promise<string> {
  const id = await page.evaluate(() => {
    const editor = (window as any).canvcode.editor
    const node = editor.makeNode('note', { x: 860, y: 140, props: { paragraphs: [{ runs: [{ text: 'コンテキストとは？' }] }] } })
    const answer = { body: '前提：LLM\n\n**コンテキスト**は、モデルに渡す文の全体です。', related: [], model: 'claude-sonnet-5-5', effort: 'medium', question: 'コンテキストとは？', answeredAt: Date.now() }
    const chat = { kind: 'chat', threadId: 't1', jobId: 'j1', label: '会話「会話」の答え', turns: [{ question: '整理して', answer: '整理しました' }] }
    editor.transact('AI 付箋', (tx: any) => tx.put({ ...node, meta: { ...node.meta, ai: { contexts: [chat], answer } } }))
    return node.id as string
  })
  await page.evaluate((id) => (window as any).canvcode.view.focusNode(id), id)
  return id
}

const canvasRoot = (page: Page) => page.locator('.canvas-container > div[tabindex]')

async function clickWorld(page: Page, x: number, y: number, button: 'left' | 'right' = 'left') {
  const rect = (await canvasRoot(page).boundingBox())!
  await page.mouse.click(rect.x + x, rect.y + y, { button })
}

interface TextStyle {
  where: string
  size: number
  lineHeight: number
  family: string
  weight: string
}

// root の中の、文字を持つ（または入力欄の）見えている要素の、計算後の文字の値。
// フォントの選択（フォントの名前をそのフォントで描く欄と一覧）は、書体を調べない
async function textStyles(root: Locator): Promise<TextStyle[]> {
  return root.evaluate((el) => {
    const out: TextStyle[] = []
    for (const e of [el, ...el.querySelectorAll('*')]) {
      if (!(e instanceof HTMLElement) || e.getClientRects().length === 0) continue
      const style = getComputedStyle(e)
      if (style.visibility === 'hidden') continue
      // 文字を持たない入力（スライダー・チェックボックスなど）は除く
      const field = (e instanceof HTMLInputElement && !['range', 'checkbox', 'radio', 'color'].includes(e.type)) || e instanceof HTMLSelectElement || e instanceof HTMLTextAreaElement
      const ownText = [...e.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '')
      if (!field && !ownText) continue
      const fontPicker = e.closest('.design-font-button, .design-font-option') && !e.closest('.design-font-option-missing')
      const lineHeight = style.lineHeight === 'normal' ? NaN : parseFloat(style.lineHeight)
      out.push({
        where: `${e.tagName.toLowerCase()}.${[...e.classList].join('.')} "${(e.textContent ?? '').trim().slice(0, 20)}"`,
        size: parseFloat(style.fontSize),
        lineHeight,
        family: fontPicker ? 'Noto Sans JP Variable' : style.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, ''),
        weight: style.fontWeight,
      })
    }
    return out
  })
}

// 14px 以上、行間を決めてある（normal でない）、書体の先頭が Noto Sans JP（等幅の所は Noto Sans Mono）、太さは 400 か 700
async function expectDadsText(root: Locator, options: { mono?: RegExp } = {}) {
  const styles = await textStyles(root)
  expect(styles.length).toBeGreaterThan(0)
  const problems = styles.filter((s) => {
    const mono = options.mono?.test(s.where) ?? false
    // ブラウザの見た目のままのセレクトは、行間が normal に固定される（Chrome）ので、行間を調べない
    const lineHeightUnset = Number.isNaN(s.lineHeight) && !s.where.startsWith('select')
    return s.size < 14 || lineHeightUnset || s.family !== (mono ? 'Noto Sans Mono' : 'Noto Sans JP Variable') || !['400', '700'].includes(s.weight)
  })
  expect(problems).toEqual([])
  return styles
}

test('the design panel, sidebar, context menu and pie menu use 14px or larger Noto Sans JP, weighted 400 or 700', async ({ page }) => {
  await openApp(page)

  // デザインパネル（図形の見た目と文字のタブ）
  await clickWorld(page, 160, 180)
  const panel = page.getByTestId('design-panel')
  await expect(panel.locator('[data-section="fill"]')).toBeVisible()
  const panelStyles = await expectDadsText(panel)
  // 選んでいるものの名前は太字（もとは 500）
  expect(panelStyles.find((s) => s.where.startsWith('span.design-panel-title'))?.weight).toBe('700')
  await panel.getByRole('tab', { name: '文字' }).click()
  await expect(panel.locator('[data-section="text"]')).toBeVisible()
  await expectDadsText(panel)
  await panel.locator('button.design-font-button').click()
  await expect(page.locator('.design-font-popup')).toBeVisible()
  await expectDadsText(page.locator('.design-font-popup'))
  await page.keyboard.press('Escape')
  await canvasRoot(page).focus()
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)

  // サイドバー（名前・見出し・札・ボタン）
  await page.locator('.sidebar-open').click()
  const sidebar = page.locator('.sidebar')
  await expect(sidebar.locator('.sidebar-title', { hasText: '捨てたキャンバス' })).toBeVisible()
  await page.locator('.sidebar-title', { hasText: 'メモ' }).waitFor()
  const sidebarStyles = await expectDadsText(sidebar)
  expect(sidebarStyles.find((s) => s.where.startsWith('span.sidebar-kind'))?.weight).toBe('700')
  // パンくず
  await expectDadsText(page.locator('.breadcrumb'))
  await page.locator('.sidebar-header button').click()

  // 右クリックのメニュー（キーの表示は等幅）
  await clickWorld(page, 220, 415, 'right')
  const menu = page.locator('.context-menu')
  await expect(menu).toBeVisible()
  const menuStyles = await expectDadsText(menu, { mono: /^kbd/ })
  expect(menuStyles.some((s) => s.where.startsWith('kbd'))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  // パイメニュー（項目と、中心の名前）
  const rect = (await canvasRoot(page).boundingBox())!
  await page.mouse.move(rect.x + 700, rect.y + 400)
  await page.keyboard.down('a')
  await expect(page.locator('.pie-item').first()).toBeVisible()
  await expectDadsText(page.locator('.pie-menu'))
  await page.keyboard.press('Escape')
  await page.keyboard.up('a')
})

test('the Claude panel conversation and the dialog body are 16px with a line height of 1.5 or more', async ({ page }) => {
  await openApp(page)

  // Claude のパネル：ヘッダーと添え書きは 14px 以上、会話（頼んだ文・回答）と入力欄は 16px・行間 1.5 以上
  await page.locator('.claude-toggle').click()
  // 右上の「質問」は質問のタブを開くので、会話のタブに移る
  await page.locator('.question-panel').getByRole('tab', { name: '会話' }).click()
  const claude = page.locator('.claude-panel')
  await expect(claude).toBeVisible()
  await expect(claude.locator('.claude-thread-name')).toHaveText('会話')
  await expect(claude.locator('.claude-text')).toBeVisible()
  // たたんだ作業を開く（ツールの行の文字も調べる）
  await claude.locator('.claude-tools-toggle').click()
  await expectDadsText(claude, { mono: /^(code|span\.claude-tool-detail|pre\.claude-permission-detail)/ })
  for (const selector of ['.claude-prompt-text', '.claude-text p', '.claude-compose textarea']) {
    const [style] = await textStyles(claude.locator(selector).first())
    expect(style.size, selector).toBe(16)
    expect(style.lineHeight / style.size, selector).toBeGreaterThanOrEqual(1.5)
  }
  await page.locator('.claude-model-button').click()
  await expect(page.locator('.claude-model-popover')).toBeVisible()
  await expectDadsText(page.locator('.claude-model-popover'))
  await page.keyboard.press('Escape')
  await claude.locator('.claude-close').click()
  // 閉じても描いたまま隠す（書きかけの文を残す。docs/claude-panel-keep-draft-plan.md）
  await expect(claude).toBeHidden()

  // 確認のダイアログ：本文は 16px・行間 1.5 以上、名前とボタンも 14px 以上
  await page.evaluate(() => {
    const w = window as any
    void w.canvcode.view.options.confirmOwnerPortalDeletion([{ title: '子', descendants: 0 }])
  })
  const dialog = page.getByRole('dialog', { name: 'キャンバスを消しますか？' })
  await expect(dialog).toBeVisible()
  await expectDadsText(dialog)
  const [message] = await textStyles(dialog.locator('p'))
  expect(message.size).toBe(16)
  expect(message.lineHeight / message.size).toBeGreaterThanOrEqual(1.5)
  const [title] = await textStyles(dialog.locator('h2'))
  expect(title.size).toBeGreaterThan(16)
  expect(title.weight).toBe('700')
  await page.keyboard.press('Escape')

  // 画面の文字を、同梱の Noto Sans JP（可変フォント）で描いている（読み込みを終えている）
  await expect
    .poll(() => page.evaluate(() => [...document.fonts].some((face) => face.family.replace(/["']/g, '') === 'Noto Sans JP Variable' && face.status === 'loaded')))
    .toBe(true)
})

test('the questions tab, the answer panel by a note, the AI note controls and the chat menus use 14px or larger Noto Sans JP (claude-chat-tab-plan 0)', async ({ page }) => {
  await openApp(page)
  const noteId = await addAiNote(page)
  // 等幅（Noto Sans Mono）は、答えの中のコードだけ（モデルの札は本文と同じ書体）
  const mono = /^code/
  await page.evaluate((id) => (window as any).canvcode.editor.setSelection([id]), noteId)
  await expect(page.locator('.ai-note-controls')).toBeVisible()
  await expectDadsText(page.locator('.ai-note-controls'))
  await expectDadsText(page.locator('.ai-note-chips'))
  await page.locator('.claude-toggle').click()
  const questions = page.locator('.question-panel')
  await expect(questions.locator('.question-row-main')).toHaveCount(1)
  await expectDadsText(questions)
  await questions.locator('.question-row-main').click()
  await expect(questions.locator('.answer-view-body')).toBeVisible()
  await expectDadsText(questions, { mono })
  // 答えの本文は、会話と同じ読む文の文字（16px・行間 1.5 以上）
  const [body] = await textStyles(questions.locator('.answer-view-body p').first())
  expect(body.size).toBe(16)
  expect(body.lineHeight / body.size).toBeGreaterThanOrEqual(1.5)
  await questions.getByRole('button', { name: '会話で続ける' }).click()
  await expectDadsText(questions.getByRole('menu'))
  await page.keyboard.press('Escape')
  await questions.getByRole('button', { name: '↗ 付箋へ移動' }).click()
  await expect(page.locator('.answer-popover')).toBeVisible()
  await expectDadsText(page.locator('.answer-popover'), { mono })
  await page.keyboard.press('Escape')
  await questions.getByRole('tab', { name: '会話' }).click()
  const claude = page.locator('.claude-panel')
  await claude.locator('.claude-job').first().hover()
  await expectDadsText(claude, { mono: /^(code|span\.claude-tool-detail)/ })
  await claude.locator('.claude-thread-button').click()
  await expectDadsText(claude.locator('.claude-thread-menu'))
  await page.keyboard.press('Escape')
  await claude.getByRole('button', { name: 'この会話のメニュー' }).click()
  await expectDadsText(claude.locator('.claude-more-menu'))
})
