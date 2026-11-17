import { chromium, firefox, type Browser, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

// 押せる部品の、見えている大きさと触れられる範囲（当たり）を、場所ごとに測る（MAI-113）。npm run bench:target-size で動かす。
// 1. 画面の開発サーバー（vite）を起動する。API のプロキシ先は誰も待ち受けていないポートにし（e2e と同じ）、サーバーの応答は
//    page.route で差し替える。本物のワークスペースには触れない
// 2. 場所（デザインパネル・サイドバー・Claude のパネルなど）を 1 つずつ開き、押せるもの（ボタン・入力欄・タブ・スライダーなど）ごとに、
//    - 見えている大きさ：枠の大きさ（getBoundingClientRect）
//    - 触れられる範囲：document.elementFromPoint でその要素（label ならその入力）に当たる範囲。中心を通る横と縦の線の上で、
//      続いて当たる長さを 1px ずつ（端の 1px は 0.25px ずつ）測る。境目の点がどちらに当たるかと小数の位置で、±0.5px の誤差がある
//    を測る。24×24 に足りないもの（WCAG 2.2 の 2.5.8 の間隔の例外を満たすかも）、44×44 に足りないもの、見えている枠の中で
//    ほかの押せるものに当たってしまう所（当たりの奪い合い）、CSS で広げた当たり（::before）どうしの重なり、当たりが場所
//    （パネルなど）の外へはみ出す所を数える。スクロールする入れ物の大きさも出す（広げた当たりがスクロールの範囲を広げていないか）。
//    パイメニューの項目は、向きで選ぶ（当たりは扇形）ので測らない。キャンバスに描くもの（選択のハンドルなど）も対象外
// 3. 結果を --out に JSON と Markdown の表で出す。--shots なら、場所ごとのスクリーンショットと、当たりを色で重ねたもの
//    （緑：44×44 以上、黄：24×24 以上、赤：足りない。青い枠は見えている枠）も撮る。--compare <dir> なら、前に撮った
//    スクリーンショット（<dir>/shots）と画素で比べ、違う画素の数と、違う所を赤くした画像を出す

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '4320' },
    out: { type: 'string', default: 'test-results/target-size' },
    browser: { type: 'string', default: 'chromium' },
    shots: { type: 'boolean', default: false },
    compare: { type: 'string' },
    // 場所の名前の一部で絞る（カンマ区切り）
    only: { type: 'string' },
  },
})

const VIEWPORT = { width: 1440, height: 900 }

// 押せるもの。label は、その入力の当たりとして数える（label を押すと入力を押したことになる）
const TARGET_SELECTOR = [
  'button',
  'a[href]',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  'label',
  '[role="button"]',
  '[role="tab"]',
  '[role="radio"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="slider"]',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="link"]',
  // ボタンの形をしていない、押して（引いて）使う所
  '.design-color-square',
  '.design-gradient-bar',
  '.design-label.scrub',
].join(', ')

// 測らないもの：キャンバスの上で文字を編集する所と、CodeMirror の本文（広い文字の欄）
const EXCLUDE_SELECTOR = '.canvcode-text-editor, .cm-editor, #target-overlay'

// ---- 差し替えるサーバーの応答 ----

const CANVAS_ID = 'canvas:target'
const CHILD_ID = 'canvas:target-child'
const TABLE_FILE = 'file:target-table'
const MD_FILE = 'file:target-memo'
const CSV = '店舗,売上,備考\n渋谷,300,駅の近く\n新宿,1200,大きな店舗\n池袋,50,\n'
const MD = '# 見出し\n\n本文です。\n'
// 1×1 の PNG（グラフのプレビューの代わり）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

function canvas(id: string, title: string, parentCanvasId: string | null, ownerNodeId: string | null, extra: object = {}) {
  return { typeName: 'canvas', id, title, parentCanvasId, ownerNodeId, createdAt: 0, updatedAt: 0, deletedAt: null, trash: null, ...extra }
}

function node(id: string, type: string, x: number, y: number, index: string, props: object) {
  return { typeName: 'node', id, type, parentId: CANVAS_ID, x, y, rotation: 0, index, opacity: 1, locked: false, version: 3, props, meta: {} }
}

const RECORDS = [
  canvas(CANVAS_ID, 'ターゲット', null, null),
  canvas(CHILD_ID, '子のキャンバス', CANVAS_ID, 'node:portal'),
  canvas('canvas:target-trashed', '捨てたキャンバス', null, null, { deletedAt: 1, trash: { batchId: 'canvas:batch-target', portal: null } }),
  node('node:geo', 'geo', 100, 120, 'a0', { shape: 'rect', w: 120, h: 120, fill: '#e8eefc', stroke: '#3b5bdb', strokeWidth: 2, label: '図形' }),
  node('node:gradient', 'geo', 260, 120, 'a1', {
    shape: 'rect', w: 120, h: 120, stroke: null, strokeWidth: 0, label: '',
    fill: {
      type: 'linear', start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 }, opacity: 1,
      stops: [{ position: 0, color: '#ff0000', opacity: 1 }, { position: 0.5, color: '#00ff00', opacity: 1 }, { position: 1, color: '#0000ff', opacity: 1 }],
    },
  }),
  node('node:text', 'text', 500, 140, 'a2', { text: 'hello', fontSize: 16, color: '#1f2328', align: 'left', w: 200, autoWidth: true }),
  node('node:chart', 'chart', 100, 330, 'a3', {
    kind: 'pie', w: 200, h: 200, innerRadius: 0, startAngle: 0, showLabels: false, showPercent: false,
    rows: [{ label: 'A', value: 1, color: '#ff0000' }, { label: 'B', value: 2 }, { label: 'C', value: 3 }],
  }),
  node('node:table', 'table-card', 400, 330, 'a4', { fileId: TABLE_FILE, w: 360, h: 200, sizing: 'auto', role: 'owner', header: true }),
  node('node:portal', 'portal', 100, 600, 'a5', { targetId: CHILD_ID, role: 'owner', w: 240, h: 170 }),
]

const FILES = [
  { id: TABLE_FILE, kind: 'table', title: '店舗', path: '店舗.csv', size: CSV.length, mtime: 0, hash: 'test', missing: false },
  { id: MD_FILE, kind: 'markdown', title: 'メモ', path: 'メモ.md', size: MD.length, mtime: 0, hash: 'test', missing: false },
]

// PDF の検索の場所：Helvetica で 1 行書いた 1 ページの PDF
function textPdf(): Buffer {
  const content = 'BT /F1 24 Tf 72 700 Td (apple one) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
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

// 差し替えた同期の WebSocket（AI の変更の知らせを送る場面で使う）。開発時は React の StrictMode で 2 本つなぐので、全部に送る
const syncSockets = new WeakMap<Page, { send(message: string): void }[]>()

async function routeServer(page: Page, options: { pdf?: boolean } = {}) {
  const now = Date.now()
  const thread = {
    threadId: 't1', title: '会話', createdAt: now, updatedAt: now, jobCount: 2, running: true,
    tasks: [{ id: 'ag1', description: '論文を探す', type: 'local_agent' }],
    permissions: [{ id: 'p1', jobId: 'j2', name: 'Bash', detail: 'npm run build', description: 'ビルドする', createdAt: now, expiresAt: now + 9 * 60_000 }],
  }
  const jobs = [
    {
      id: 'j1', threadId: 't1', prompt: '図形を整理してください', status: 'done', createdAt: now, eventCount: 2,
      events: [
        { kind: 'tool', name: 'read_canvas', detail: CANVAS_ID },
        { kind: 'text', text: '## まとめ\n\n整理しました。[リンク](https://example.com) を含む本文です。' },
      ],
    },
    { id: 'j2', threadId: 't1', prompt: 'ビルドして', status: 'running', createdAt: now + 1000, eventCount: 1, events: [{ kind: 'ask', id: 'p1', name: 'Bash', detail: 'npm run build' }] },
  ]
  const models = {
    models: [
      { value: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { value: 'claude-opus-4-6', label: 'Opus 4.6', efforts: ['low', 'medium', 'high', 'max'] },
      { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', efforts: [] },
    ],
    default: { value: 'opus', label: 'Opus 5.5' },
    fromClaude: true,
  }
  const pdf = textPdf()
  const hash = 'c'.repeat(64)
  const pdfRecords = [
    { typeName: 'file', id: 'file:target-pdf', kind: 'pdf', title: 'search.pdf', path: '', size: pdf.length, mtime: 0, hash, missing: false, assetId: `asset:${hash}`, pagesCanvasId: CANVAS_ID, pageCount: 1, parentCanvasId: null, ownerNodeId: null, createdAt: 0, updatedAt: 0, deletedAt: null, trash: null },
    { typeName: 'node', id: 'node:page0', type: 'pdf-page', parentId: CANVAS_ID, x: 900, y: 100, rotation: 0, index: 'a9', opacity: 1, locked: true, version: 1, props: { assetId: `asset:${hash}`, fileId: 'file:target-pdf', pageIndex: 0, w: 612 * (96 / 72), h: 792 * (96 / 72) }, meta: {} },
  ]
  const records = options.pdf ? [...RECORDS, ...pdfRecords] : RECORDS
  await page.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: FILES } }))
  await page.route(`**/api/files/${encodeURIComponent(TABLE_FILE)}/content`, (route) => route.fulfill({ body: CSV, headers: { etag: '"test"' } }))
  await page.route(`**/api/files/${encodeURIComponent(MD_FILE)}/content`, (route) => route.fulfill({ body: MD, headers: { etag: '"test"' } }))
  // Google Drive に送れていないときの札（右上）。同期はつながっている（保存済み）ことにする
  await page.route('**/api/backup-status', (route) =>
    route.fulfill({ json: { state: 'drive', lastAttemptAt: '2026-10-12T03:05:00.000Z', lastSuccessAt: '2026-10-12T02:00:00.000Z', driveLastOkAt: '2026-10-12T02:00:00.000Z', error: 'dial tcp' } }),
  )
  await page.routeWebSocket('**/api/sync', (ws) => {
    syncSockets.set(page, [...(syncSockets.get(page) ?? []), ws])
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (message.type === 'hello') ws.send(JSON.stringify({ type: 'changes', rev: 0, records: [], deleted: [] }))
    })
  })
  await page.route('**/api/claude/threads', (route) => route.fulfill({ json: { threads: [thread] } }))
  await page.route('**/api/claude/threads/t1', (route) => route.fulfill({ json: { jobs } }))
  await page.route('**/api/claude/events', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/claude/models', (route) => route.fulfill({ json: models }))
  await page.route('**/api/plot/styles', (route) => route.fulfill({ json: { styles: [{ name: 'プレゼン', description: '見本', colors: ['#0072b2', '#e69f00'] }] } }))
  await page.route('**/api/plot', (route) => route.fulfill({ body: PNG, contentType: 'image/png', headers: { 'x-canvcode-width': '1', 'x-canvcode-height': '1' } }))
  await page.route('**/api/assets**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/assets') return route.fulfill({ json: { assets: [{ mime: 'application/pdf', size: pdf.length, hash, width: 0, height: 0, variants: [] }] } })
    if (url.pathname.endsWith('/search')) return route.fulfill({ json: { status: 'ok', total: 1, pages: [{ pageIndex: 0, count: 1 }] } })
    return route.fulfill({ body: pdf, contentType: 'application/pdf' })
  })
}

// ---- 場所を開く ----

interface Scene {
  // 場所の名前
  name: string
  // 測る範囲（この中の押せるもの）
  roots: string[]
  // 当たりがはみ出してはいけない範囲（パネルなど。ないものは、キャンバスの上に浮かぶ部品）
  bounded?: boolean
  open(page: Page): Promise<void>
  path?: string
  pdf?: boolean
  touch?: boolean
  // 画面の大きさ（なければ 1440×900。touch なら 420×800）
  viewport?: { width: number; height: number }
  // 撮る前にポインタを動かさない（パイメニューなど）
  keepPointer?: boolean
}

const canvasRoot = (page: Page) => page.locator('.canvas-container > div[tabindex]')

async function clickWorld(page: Page, x: number, y: number, button: 'left' | 'right' = 'left') {
  const rect = (await canvasRoot(page).boundingBox())!
  await page.mouse.click(rect.x + x, rect.y + y, { button })
}

async function selectGeo(page: Page) {
  await clickWorld(page, 160, 180)
  await page.getByTestId('design-panel').locator('[data-section="fill"]').waitFor()
}

async function openClaude(page: Page) {
  await page.locator('.claude-toggle').click()
  await page.locator('.claude-panel').waitFor()
  await page.locator('.claude-thread-select').selectOption('t1')
  await page.locator('.claude-text').first().waitFor()
}

// 表のカードの列の上（データの 1 行目）にポインタを置く（csv-table.spec.ts と同じ）
async function pointAtColumn(page: Page, col: number) {
  const x = await page.evaluate((col) => {
    const editor = (window as any).canvcode.editor
    const target = editor.getNode('node:table')
    const type = editor.getType(target)
    const xs: number[] = []
    for (let x = 0; x < target.props.w; x += 2) if (type.columnAt(target, { x, y: 36 + 28 + 14 })?.col === col) xs.push(x)
    return (xs[0] + xs.at(-1)!) / 2
  }, col)
  const rect = (await canvasRoot(page).boundingBox())!
  await page.mouse.move(rect.x + 400 + x, rect.y + 330 + 36 + 28 + 14)
}

async function choosePie(page: Page, key: string, labels: string[]) {
  await page.keyboard.down(key)
  for (const label of labels) await page.locator('.pie-item').filter({ hasText: new RegExp(`^${label}›?$`) }).click({ force: true })
  await page.keyboard.up(key)
}

const SCENES: Scene[] = [
  {
    name: '右上の札とパンくず',
    roots: ['.topbar', '.status-bar'],
    path: `/c/${encodeURIComponent(CHILD_ID)}`,
    open: async (page) => {
      await page.locator('.claude-toggle').waitFor()
      await page.locator('.breadcrumb button').first().waitFor()
      await page.locator('.status-bar .backup-status').waitFor()
    },
  },
  {
    name: 'サイドバー',
    roots: ['.sidebar'],
    bounded: true,
    open: async (page) => {
      await page.locator('.sidebar-open').click()
      await page.locator('.sidebar-row.trashed').waitFor()
      await page.locator('.sidebar-action', { hasText: 'ここに置く' }).first().waitFor()
    },
  },
  {
    name: 'デザインパネル（図形の見た目）',
    roots: ['[data-testid="design-panel"]'],
    bounded: true,
    open: selectGeo,
  },
  {
    name: 'デザインパネル（図形の文字）',
    roots: ['[data-testid="design-panel"]'],
    bounded: true,
    open: async (page) => {
      await selectGeo(page)
      await page.getByTestId('design-panel').getByRole('tab', { name: '文字' }).click()
      await page.getByTestId('design-panel').locator('[data-section="text"]').waitFor()
    },
  },
  {
    name: 'カラーピッカー',
    roots: ['.design-color-popup'],
    bounded: true,
    open: async (page) => {
      await selectGeo(page)
      await page.getByTestId('design-panel').locator('[data-section="fill"] .design-paint-kind, [data-section="fill"] .design-swatch').first().click()
      await page.locator('.design-color-popup').waitFor()
    },
  },
  {
    name: 'カラーピッカー（グラデーション）',
    roots: ['.design-color-popup'],
    bounded: true,
    open: async (page) => {
      await clickWorld(page, 320, 180)
      const panel = page.getByTestId('design-panel')
      await panel.locator('[data-section="fill"]').waitFor()
      await panel.locator('[data-section="fill"] .design-paint-kind, [data-section="fill"] .design-swatch').first().click()
      await page.locator('.design-color-popup .design-gradient').waitFor()
    },
  },
  {
    name: 'フォントの一覧',
    roots: ['.design-font-popup'],
    bounded: true,
    open: async (page) => {
      await selectGeo(page)
      const panel = page.getByTestId('design-panel')
      await panel.getByRole('tab', { name: '文字' }).click()
      await panel.locator('button.design-font-button').click()
      await page.locator('.design-font-popup').waitFor()
    },
  },
  {
    name: 'デザインパネル（グラフのデータ）',
    roots: ['[data-testid="design-panel"]'],
    bounded: true,
    open: async (page) => {
      await clickWorld(page, 200, 430)
      await page.getByTestId('design-panel').locator('[data-section="chart"]').waitFor()
    },
  },
  {
    name: '右クリックのメニュー',
    roots: ['.context-menu'],
    bounded: true,
    open: async (page) => {
      await clickWorld(page, 160, 180, 'right')
      await page.locator('.context-menu').waitFor()
    },
  },
  {
    name: 'パイメニューのボタン（タッチ）',
    roots: ['.pie-buttons'],
    touch: true,
    open: async (page) => {
      await page.locator('.pie-buttons button').first().waitFor()
    },
  },
  {
    name: 'Claude のパネル',
    roots: ['.claude-panel'],
    bounded: true,
    open: openClaude,
  },
  {
    name: 'Claude のモデルの選択',
    roots: ['.claude-model-popover'],
    bounded: true,
    open: async (page) => {
      await openClaude(page)
      await page.locator('.claude-model-button').click()
      await page.locator('.claude-model-popover [role="slider"]').first().waitFor()
    },
  },
  {
    name: 'Claude のモデルの一覧',
    roots: ['.claude-model-popover'],
    bounded: true,
    open: async (page) => {
      await openClaude(page)
      await page.locator('.claude-model-button').click()
      await page.locator('.claude-model-popover').getByRole('button', { name: /^Model/ }).click()
      await page.locator('.claude-model-popover [role="radio"]').first().waitFor()
    },
  },
  {
    name: '確認のダイアログ',
    roots: ['.dialog'],
    bounded: true,
    open: async (page) => {
      await page.evaluate(() => {
        const w = window as any
        void w.canvcode.view.options.confirmOwnerPortalDeletion([{ title: '子', descendants: 0 }])
      })
      await page.locator('.dialog').waitFor()
    },
  },
  {
    // 狭い画面では、ボタンが 2 行に折り返す
    name: '確認のダイアログ（幅 360px）',
    roots: ['.dialog'],
    bounded: true,
    viewport: { width: 360, height: 700 },
    open: async (page) => {
      await page.evaluate(() => {
        const w = window as any
        void w.canvcode.view.options.confirmOwnerPortalDeletion([{ title: '子', descendants: 0 }])
      })
      await page.locator('.dialog').waitFor()
    },
  },
  {
    name: 'グラフを作るダイアログ',
    roots: ['.dialog.plot-dialog'],
    bounded: true,
    open: async (page) => {
      await clickWorld(page, 580, 360, 'right')
      await page.locator('.context-menu button', { hasText: 'グラフを作る…' }).click()
      await page.locator('.dialog.plot-dialog').waitFor()
      await page.locator('.plot-dialog-preview img').waitFor()
    },
  },
  {
    name: '全画面のエディタ',
    roots: ['.file-editor'],
    bounded: true,
    open: async (page) => {
      await page.locator('.sidebar-open').click()
      await page.locator('.sidebar-title', { hasText: 'メモ' }).click()
      await page.locator('.file-editor .cm-content').waitFor()
    },
  },
  {
    // 狭い画面では、見出しの帯の部品が折り返す
    name: '全画面のエディタ（幅 360px）',
    roots: ['.file-editor-header'],
    bounded: true,
    viewport: { width: 360, height: 700 },
    open: async (page) => {
      await page.locator('.sidebar-open').click()
      await page.locator('.sidebar-title', { hasText: 'メモ' }).click()
      await page.locator('.file-editor .cm-content').waitFor()
    },
  },
  {
    name: 'PDF の検索',
    roots: ['.pdf-search'],
    bounded: true,
    pdf: true,
    open: async (page) => {
      await canvasRoot(page).focus()
      await page.keyboard.press('ControlOrMeta+f')
      await page.locator('.pdf-search input').waitFor()
    },
  },
  {
    // キャンバスの下に 1 つで浮かぶ札（押すと番号の入力欄になる）
    name: 'PDF のページの番号',
    roots: ['.pdf-page-number'],
    pdf: true,
    open: async (page) => {
      await page.locator('.pdf-page-number').waitFor()
    },
  },
  {
    name: '表のカードの絞り込み',
    roots: ['.table-filter-input'],
    bounded: true,
    open: async (page) => {
      await page.waitForFunction(() => (window as any).canvcode.editor.index.get('node:table')?.worldBounds.h > 100)
      await pointAtColumn(page, 1)
      await choosePie(page, 'o', ['フィルター', '≧…'])
      await page.locator('.table-filter-input input').waitFor()
    },
  },
  {
    name: 'AI の変更の知らせ',
    roots: ['.agent-notices'],
    bounded: true,
    open: async (page) => {
      await page.locator('.sync-status', { hasText: '保存済み' }).waitFor()
      const origin = { kind: 'ai', batchId: 'batch:target', label: '図形を 2 つ並べた', canvasId: CANVAS_ID, count: 2 }
      for (const ws of syncSockets.get(page) ?? []) ws.send(JSON.stringify({ type: 'changes', rev: 1, records: [], deleted: [], origin }))
      await page.locator('.agent-notice button').waitFor()
    },
  },
  {
    name: '左のパレット（矢印）',
    roots: ['.palette-column'],
    bounded: true,
    open: async (page) => {
      await page.evaluate(() => (window as any).canvcode.editor.session.set({ toolId: 'arrow' }))
      await page.locator('.style-palette').waitFor()
    },
  },
  {
    name: '左のパレット（フリーハンド）',
    roots: ['.palette-column'],
    bounded: true,
    open: async (page) => {
      await page.evaluate(() => (window as any).canvcode.editor.session.set({ toolId: 'draw' }))
      await page.locator('.style-palette').waitFor()
    },
  },
  {
    name: '左のパレット（整列）',
    roots: ['.palette-column'],
    bounded: true,
    open: async (page) => {
      await page.evaluate(() => (window as any).canvcode.editor.setSelection(['node:geo', 'node:gradient']))
      await page.getByTestId('arrange-palette').waitFor()
    },
  },
  {
    name: '文字の書式のツールバー',
    roots: ['[data-testid="text-format-toolbar"]'],
    bounded: true,
    open: async (page) => {
      await clickWorld(page, 510, 150)
      await page.keyboard.press('Enter')
      await page.getByTestId('text-format-toolbar').waitFor()
    },
  },
]

// ---- 測る（画面の中で動かす） ----

interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

interface Measured {
  // 何か（タグ・クラス・名前）
  name: string
  visible: Box
  // 触れられる範囲。中心が別の要素に覆われていて、どこにも当たらないときは null
  hit: Box | null
  // 中心を覆っているもの
  covered: string | null
  // 見えている枠の中で、ほかの押せるものに当たってしまう所（そのものの名前と、調べた点のうちの割合）
  stolenBy: { name: string; ratio: number }[]
  disabled: boolean
  // スクロールする入れ物の外に出ていて見えない（数えない）
  scrolledOut: boolean
  // CSS で決めた当たりの範囲（見えている枠と、広げた ::before を合わせたもの）。重なりを調べるのに使う
  area: Box
  // DOM の中の位置（入れ子を見分ける）
  path: number[]
}

interface Result extends Measured {
  place: string
  hitW: number
  hitH: number
  // 24×24 に足りないが、WCAG 2.2 の 2.5.8 の間隔の例外を満たす（24px の円がほかの当たりや円に重ならない）
  spacing: boolean
  // 当たりが場所の外へはみ出す（はみ出した長さ）
  outside: number
  // CSS で決めた当たりの範囲が重なっているもの（入れ子でないもの）
  overlaps: string[]
}

interface ScrollBox {
  name: string
  scrollWidth: number
  scrollHeight: number
  clientWidth: number
  clientHeight: number
}

function measureInPage({ roots, selector, exclude }: { roots: string[]; selector: string; exclude: string }) {
  const rootEls = roots.flatMap((s) => [...document.querySelectorAll(s)])
  const describe = (e: Element) => {
    const classes = [...e.classList].slice(0, 3).join('.')
    const text = (
      e.getAttribute('aria-label') ||
      e.getAttribute('title') ||
      (e instanceof HTMLInputElement && e.type !== 'range' ? e.placeholder || e.value : '') ||
      (e.textContent ?? '')
    ).trim().replace(/\s+/g, ' ').slice(0, 24)
    const type = e instanceof HTMLInputElement ? `[${e.type}]` : ''
    return `${e.tagName.toLowerCase()}${type}${classes ? `.${classes}` : ''}${text ? ` 「${text}」` : ''}`
  }
  // 当たった要素が、押したことになるもの（いちばん内側の押せるもの。label はその入力）
  const ownerOf = (hit: Element | null): Element | null => {
    const target = hit?.closest(selector) ?? null
    if (target instanceof HTMLLabelElement) return target.control ?? null
    return target
  }
  const visibleEnough = (e: Element) => {
    if (e.getClientRects().length === 0) return false
    const r = e.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    return e.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  }
  // 測るもの：見えている押せるもの。label は、入力が見えていないとき（見た目の代わり）だけ、入力の代わりに測る
  const items: { el: Element; owner: Element }[] = []
  const seen = new Set<Element>()
  for (const root of rootEls) {
    for (const e of [root, ...root.querySelectorAll(selector)]) {
      if (!e.matches(selector) || e.closest(exclude) || seen.has(e)) continue
      seen.add(e)
      if (e instanceof HTMLLabelElement) {
        const control = e.control
        if (control && !visibleEnough(control) && visibleEnough(e)) items.push({ el: e, owner: control })
        continue
      }
      if (visibleEnough(e)) items.push({ el: e, owner: e })
    }
  }
  const results: Measured[] = []
  // DOM の中の位置（親からの番号の並び）。入れ子かどうかを、あとで見分ける
  const pathOf = (e: Element) => {
    const path: number[] = []
    for (let n: Element | null = e; n && n.parentElement; n = n.parentElement) path.unshift([...n.parentElement.children].indexOf(n))
    return path
  }
  // スクロールする（中身を切る）入れ物の外に、一部でも出ているか（一覧の端で切れている項目は、当たりも切れるので数えない）
  // 中身を切るのは、要素の入れ物（containing block）の並びの上にある入れ物だけ。position: fixed の要素はその上で切られず、
  // absolute の要素は、位置を決めていない入れ物には切られない
  const scrolledOut = (e: Element) => {
    const r = e.getBoundingClientRect()
    let position = getComputedStyle(e).position
    for (let n = e.parentElement; n && position !== 'fixed'; n = n.parentElement) {
      const style = getComputedStyle(n)
      const skip = position === 'absolute' && style.position === 'static'
      if (!skip) position = style.position
      if (skip || (style.overflowX === 'visible' && style.overflowY === 'visible')) continue
      const b = n.getBoundingClientRect()
      if (r.left < b.left - 1 || r.right > b.right + 1 || r.top < b.top - 1 || r.bottom > b.bottom + 1) return true
    }
    return false
  }
  // CSS で決めた当たりの範囲：見えている枠と、外へ広げた ::before（position: absolute）を合わせたもの
  const areaOf = (e: Element, r: DOMRect) => {
    const area = { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    const before = getComputedStyle(e, '::before')
    if (before.content === 'none' || before.content === 'normal' || before.position !== 'absolute') return area
    const style = getComputedStyle(e)
    const left = r.left + parseFloat(style.borderLeftWidth) + parseFloat(before.left)
    const top = r.top + parseFloat(style.borderTopWidth) + parseFloat(before.top)
    const right = r.right - parseFloat(style.borderRightWidth) - parseFloat(before.right)
    const bottom = r.bottom - parseFloat(style.borderBottomWidth) - parseFloat(before.bottom)
    return { left: Math.min(area.left, left), top: Math.min(area.top, top), right: Math.max(area.right, right), bottom: Math.max(area.bottom, bottom) }
  }
  for (const { el, owner } of items) {
    const r = el.getBoundingClientRect()
    const path = pathOf(el)
    const area = areaOf(el, r)
    const mine = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false
      return ownerOf(document.elementFromPoint(x, y)) === owner
    }
    // 測り始める点：中心。当たらなければ、枠の中の格子の点から探す
    let origin: { x: number; y: number } | null = null
    const cx = Math.floor(r.left + r.width / 2) + 0.5
    const cy = Math.floor(r.top + r.height / 2) + 0.5
    if (mine(cx, cy)) origin = { x: cx, y: cy }
    for (let i = 1; i < 6 && !origin; i++) {
      for (let j = 1; j < 6 && !origin; j++) {
        const x = Math.floor(r.left + (r.width * i) / 6) + 0.5
        const y = Math.floor(r.top + (r.height * j) / 6) + 0.5
        if (mine(x, y)) origin = { x, y }
      }
    }
    const disabled = (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true'
    const visible = { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    if (!origin) {
      const out = scrolledOut(el)
      results.push({ name: describe(el), visible, hit: null, covered: out ? null : describe(document.elementFromPoint(cx, cy) ?? document.body), stolenBy: [], disabled, scrolledOut: out, area, path })
      continue
    }
    const from = origin
    // 起点から、続いて当たる長さ。1px ずつ進め、外れた 1px の中を 0.25px ずつ調べる
    const reach = (dx: number, dy: number) => {
      const limit = 600
      let d = 0
      while (d < limit && mine(from.x + dx * (d + 1), from.y + dy * (d + 1))) d++
      let fine = 0
      for (const f of [0.25, 0.5, 0.75]) {
        if (!mine(from.x + dx * (d + f), from.y + dy * (d + f))) break
        fine = f
      }
      return d + fine
    }
    const hit = {
      left: from.x - reach(-1, 0),
      right: from.x + reach(1, 0),
      top: from.y - reach(0, -1),
      bottom: from.y + reach(0, 1),
    }
    // 見えている枠の中の点（3px おき）で、ほかの押せるものに当たる所
    const stolen = new Map<Element, number>()
    let points = 0
    for (let y = r.top + 1.5; y < r.bottom - 1; y += 3) {
      for (let x = r.left + 1.5; x < r.right - 1; x += 3) {
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue
        points++
        const other = ownerOf(document.elementFromPoint(x, y))
        if (!other || other === owner || el.contains(other) || other.contains(el)) continue
        stolen.set(other, (stolen.get(other) ?? 0) + 1)
      }
    }
    results.push({
      name: describe(el),
      visible,
      hit,
      covered: null,
      stolenBy: [...stolen].map(([other, n]) => ({ name: describe(other), ratio: n / Math.max(points, 1) })),
      disabled,
      scrolledOut: scrolledOut(el),
      area,
      path,
    })
  }
  const rootBoxes = rootEls.map((e) => {
    const r = e.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
  })
  // スクロールする入れ物の大きさ（広げた当たりが、スクロールの範囲を広げていないかを、前と後で比べる）
  const scrollBoxes: ScrollBox[] = []
  for (const root of rootEls) {
    for (const e of [root, ...root.querySelectorAll('*')]) {
      const style = getComputedStyle(e)
      if (![style.overflowX, style.overflowY].some((v) => v === 'auto' || v === 'scroll')) continue
      scrollBoxes.push({ name: describe(e).replace(/ 「.*$/, ''), scrollWidth: e.scrollWidth, scrollHeight: e.scrollHeight, clientWidth: e.clientWidth, clientHeight: e.clientHeight })
    }
  }
  return { results, rootBoxes, scrollBoxes }
}

// 当たりが size×size 以上か。測り方の誤差（境目の 1 点がどちらに当たるか・小数の位置。±0.5px）を見込む
const meets = (r: { hitW: number; hitH: number }, size: number) => r.hitW >= size - 0.5 && r.hitH >= size - 0.5

const nested = (a: number[], b: number[]) => a.length !== b.length && (a.length < b.length ? a.every((v, i) => b[i] === v) : b.every((v, i) => a[i] === v))

function finish(place: string, measured: Measured[], rootBoxes: Box[], bounded: boolean): Result[] {
  const round = (v: number) => Math.round(v * 4) / 4
  const sized: Result[] = measured.map((m) => ({
    ...m,
    place,
    hitW: m.hit ? round(m.hit.right - m.hit.left) : 0,
    hitH: m.hit ? round(m.hit.bottom - m.hit.top) : 0,
    spacing: false,
    outside: 0,
    overlaps: [],
  }))
  // CSS で決めた当たりの範囲の重なり（入れ子でないものどうし。0.5px 未満は数えない）
  for (const [i, a] of sized.entries()) {
    for (const b of sized.slice(i + 1)) {
      if (a.scrolledOut || b.scrolledOut || nested(a.path, b.path)) continue
      const w = Math.min(a.area.right, b.area.right) - Math.max(a.area.left, b.area.left)
      const h = Math.min(a.area.bottom, b.area.bottom) - Math.max(a.area.top, b.area.top)
      if (w > 0.5 && h > 0.5) {
        a.overlaps.push(`${b.name}（${round(w)}×${round(h)}）`)
        b.overlaps.push(`${a.name}（${round(w)}×${round(h)}）`)
      }
    }
  }
  for (const item of sized) {
    if (item.hit && bounded) {
      // 見えている枠を含む場所の範囲から、当たりがはみ出す長さ
      const box = rootBoxes.find((b) => item.visible.left >= b.left - 1 && item.visible.right <= b.right + 1 && item.visible.top >= b.top - 1 && item.visible.bottom <= b.bottom + 1)
      // 測り方の誤差（0.5px）を引く
      if (box) item.outside = Math.max(0, box.left - item.hit.left, item.hit.right - box.right, box.top - item.hit.top, item.hit.bottom - box.bottom) - 0.5
    }
    if (!item.hit || meets(item, 24)) continue
    // 間隔の例外：当たりの中心に置いた直径 24px の円が、ほかの当たりにも、足りないものの円にも重ならない
    const center = { x: (item.hit.left + item.hit.right) / 2, y: (item.hit.top + item.hit.bottom) / 2 }
    item.spacing = sized.every((other) => {
      if (other === item || !other.hit) return true
      const nx = Math.max(other.hit.left, Math.min(center.x, other.hit.right))
      const ny = Math.max(other.hit.top, Math.min(center.y, other.hit.bottom))
      if (Math.hypot(nx - center.x, ny - center.y) < 12) return false
      if (meets(other, 24)) return true
      const oc = { x: (other.hit.left + other.hit.right) / 2, y: (other.hit.top + other.hit.bottom) / 2 }
      return Math.hypot(oc.x - center.x, oc.y - center.y) >= 24
    })
  }
  return sized
}

// 当たりを色で重ねる（緑：44×44 以上、黄：24×24 以上、赤：足りない。青い枠は見えている枠）
function overlayInPage(results: Result[]) {
  const layer = document.createElement('div')
  layer.id = 'target-overlay'
  Object.assign(layer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647' })
  for (const item of results) {
    if (!item.hit) continue
    // meets は使えない（画面の中で動かす関数なので、外の関数を呼べない）。誤差の 0.5px を見込む
    const color = item.hitW >= 43.5 && item.hitH >= 43.5 ? '0, 160, 60' : item.hitW >= 23.5 && item.hitH >= 23.5 ? '230, 170, 0' : '220, 0, 0'
    const hit = document.createElement('div')
    Object.assign(hit.style, {
      position: 'fixed', left: `${item.hit.left}px`, top: `${item.hit.top}px`,
      width: `${item.hit.right - item.hit.left}px`, height: `${item.hit.bottom - item.hit.top}px`,
      background: `rgba(${color}, 0.28)`, outline: `1px solid rgba(${color}, 0.9)`, outlineOffset: '-1px',
    })
    const visible = document.createElement('div')
    Object.assign(visible.style, {
      position: 'fixed', left: `${item.visible.left}px`, top: `${item.visible.top}px`,
      width: `${item.visible.right - item.visible.left}px`, height: `${item.visible.bottom - item.visible.top}px`,
      outline: '1px dashed rgba(0, 60, 220, 0.9)', outlineOffset: '-1px',
    })
    layer.append(hit, visible)
  }
  document.body.append(layer)
}

// ---- サーバーとブラウザ ----

async function startDevServer(port: number): Promise<ChildProcess> {
  const server = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: join(ROOT, 'apps/web'),
    env: { ...process.env, CANVCODE_API_TARGET: 'http://127.0.0.1:9' },
    stdio: 'ignore',
  })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/canvas-input-test.html`)).ok) return server
    } catch {
      // まだ起動していない
    }
    await delay(200)
  }
  server.kill()
  throw new Error('開発サーバーが起動しませんでした')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const slug = (index: number, name: string) => `${String(index).padStart(2, '0')}-${name.replace(/[\s/（）()]+/g, '_').replace(/_+$/, '')}`

async function runScene(browser: Browser, base: string, scene: Scene, index: number, shotDir: string | null): Promise<{ results: Result[]; scrollBoxes: ScrollBox[] }> {
  const viewport = scene.viewport ?? (scene.touch ? { width: 420, height: 800 } : VIEWPORT)
  const context = await browser.newContext({ viewport, hasTouch: scene.touch, isMobile: scene.touch && browser.browserType().name() === 'chromium', deviceScaleFactor: 1 })
  const page = await context.newPage()
  try {
    await page.addInitScript(() => localStorage.clear())
    await routeServer(page, { pdf: scene.pdf })
    await page.goto(`${base}${scene.path ?? '/'}`)
    await canvasRoot(page).waitFor()
    await page.waitForFunction(() => Boolean((window as any).canvcode?.view))
    await page.evaluate(() => document.fonts.ready)
    await scene.open(page)
    // ポインタを左下の隅（キャンバスの何もない所）へ動かして、ホバーの見た目を消す
    if (!scene.keepPointer && !scene.touch) await page.mouse.move(2, viewport.height - 2)
    await page.waitForTimeout(150)
    const { results: measured, rootBoxes, scrollBoxes } = await page.evaluate(measureInPage, { roots: scene.roots, selector: TARGET_SELECTOR, exclude: EXCLUDE_SELECTOR })
    const results = finish(scene.name, measured, rootBoxes, scene.bounded ?? false)
    if (shotDir && rootBoxes.length > 0) {
      const margin = 24
      const clip = {
        x: Math.max(0, Math.min(...rootBoxes.map((b) => b.left)) - margin),
        y: Math.max(0, Math.min(...rootBoxes.map((b) => b.top)) - margin),
        right: Math.min(viewport.width, Math.max(...rootBoxes.map((b) => b.right)) + margin),
        bottom: Math.min(viewport.height, Math.max(...rootBoxes.map((b) => b.bottom)) + margin),
      }
      const rect = { x: Math.floor(clip.x), y: Math.floor(clip.y), width: Math.ceil(clip.right - clip.x), height: Math.ceil(clip.bottom - clip.y) }
      const file = slug(index, scene.name)
      await page.screenshot({ path: join(shotDir, 'shots', `${file}.png`), clip: rect, animations: 'disabled', caret: 'hide' })
      await page.evaluate(overlayInPage, results)
      await page.screenshot({ path: join(shotDir, 'overlay', `${file}.png`), clip: rect, animations: 'disabled', caret: 'hide' })
    }
    return { results, scrollBoxes }
  } finally {
    await context.close()
  }
}

// ---- 結果 ----

const size = (w: number, h: number) => `${Math.round(w * 2) / 2}×${Math.round(h * 2) / 2}`

function markdownReport(results: Result[], scrolls: Record<string, ScrollBox[]>, meta: Record<string, unknown>): string {
  const lines = [`# 押せる部品の触れられる範囲（${meta.browser}、${VIEWPORT.width}×${VIEWPORT.height}）`, '']
  lines.push('| 場所 | 数 | 当たりの最小（幅・高さ） | 24×24 未満 | うち間隔の例外 | 44×44 未満 | 奪い合い | 重なり | はみ出し |')
  lines.push('| --- | --: | --- | --: | --: | --: | --: | --: | --: |')
  const places = [...new Set(results.map((r) => r.place))]
  for (const place of places) {
    const items = results.filter((r) => r.place === place && r.hit && !r.scrolledOut)
    const under24 = items.filter((r) => !meets(r, 24))
    const under44 = items.filter((r) => !meets(r, 44))
    const minW = Math.min(...items.map((r) => r.hitW))
    const minH = Math.min(...items.map((r) => r.hitH))
    lines.push(
      `| ${place} | ${items.length} | ${items.length ? `${minW}・${minH}` : '—'} | ${under24.length} | ${under24.filter((r) => r.spacing).length} | ${under44.length} | ${items.filter((r) => r.stolenBy.length > 0).length} | ${items.filter((r) => r.overlaps.length > 0).length} | ${items.filter((r) => r.outside > 0.5).length} |`,
    )
  }
  lines.push('', '## スクロールする入れ物の大きさ', '', '| 場所 | 入れ物 | スクロールの範囲 | 見えている範囲 |', '| --- | --- | --- | --- |')
  for (const [place, boxes] of Object.entries(scrolls)) {
    for (const b of boxes) lines.push(`| ${place} | ${b.name} | ${b.scrollWidth}×${b.scrollHeight} | ${b.clientWidth}×${b.clientHeight} |`)
  }
  lines.push('', '## 場所ごとの一覧', '', '見た目：枠の大きさ。当たり：触れられる範囲（中心を通る線の上。±0.5px の誤差を見込む）。印：✗ 24×24 未満、△ 44×44 未満、例外 は間隔の例外を満たす', '')
  for (const place of places) {
    lines.push(`### ${place}`, '', '| 印 | 要素 | 見た目 | 当たり | 備考 |', '| --- | --- | --- | --- | --- |')
    for (const r of results.filter((r) => r.place === place)) {
      const notes: string[] = []
      if (r.scrolledOut) notes.push('一部がスクロールの外（数えない）')
      if (r.disabled) notes.push('押せない状態')
      if (r.covered) notes.push(`中心が ${r.covered} に覆われている`)
      if (r.spacing) notes.push('間隔の例外')
      for (const s of r.stolenBy) notes.push(`見た目の ${Math.round(s.ratio * 100)} % が ${s.name} に当たる`)
      if (r.outside > 0.5) notes.push(`場所の外へ ${Math.round(r.outside)}px はみ出す`)
      for (const o of r.overlaps) notes.push(`当たりが ${o} と重なる`)
      const mark = r.scrolledOut ? '' : !r.hit ? '?' : !meets(r, 24) ? '✗' : !meets(r, 44) ? '△' : ''
      const v = r.visible
      lines.push(`| ${mark} | ${r.name.replace(/\|/g, '\\|')} | ${size(v.right - v.left, v.bottom - v.top)} | ${r.hit ? size(r.hitW, r.hitH) : '—'} | ${notes.join('、').replace(/\|/g, '\\|')} |`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

// 前のスクリーンショットと画素で比べる（画面の中で画像を読んで比べる）
async function compareShots(browser: Browser, before: string, after: string): Promise<string[]> {
  const page = await browser.newPage()
  const lines = ['# スクリーンショットの比較', '', `前：${before}`, `後：${after}`, '', '| 場所 | 違う画素 | 大きさ |', '| --- | --: | --- |']
  try {
    await mkdir(join(after, 'diff'), { recursive: true })
    for (const file of (await readdir(join(after, 'shots'))).sort()) {
      if (!existsSync(join(before, 'shots', file))) {
        lines.push(`| ${file} | 前がない | |`)
        continue
      }
      const [a, b] = await Promise.all([readFile(join(before, 'shots', file)), readFile(join(after, 'shots', file))])
      const diff = await page.evaluate(
        async ([a, b]) => {
          const load = async (base64: string) => {
            const image = new Image()
            image.src = `data:image/png;base64,${base64}`
            await image.decode()
            return image
          }
          const [ia, ib] = await Promise.all([load(a), load(b)])
          if (ia.width !== ib.width || ia.height !== ib.height) return { count: -1, size: `${ia.width}×${ia.height} → ${ib.width}×${ib.height}`, png: null }
          const read = (image: HTMLImageElement) => {
            const c = document.createElement('canvas')
            c.width = image.width
            c.height = image.height
            const ctx = c.getContext('2d')!
            ctx.drawImage(image, 0, 0)
            return { c, ctx, data: ctx.getImageData(0, 0, c.width, c.height) }
          }
          const ra = read(ia)
          const rb = read(ib)
          let count = 0
          const out = rb.ctx.createImageData(rb.c.width, rb.c.height)
          for (let i = 0; i < ra.data.data.length; i += 4) {
            const d = Math.max(...[0, 1, 2].map((k) => Math.abs(ra.data.data[i + k] - rb.data.data[i + k])))
            const gray = (rb.data.data[i] + rb.data.data[i + 1] + rb.data.data[i + 2]) / 3
            if (d > 8) {
              count++
              out.data.set([255, 0, 0, 255], i)
            } else out.data.set([gray, gray, gray, 90], i)
          }
          rb.ctx.putImageData(out, 0, 0)
          return { count, size: `${ia.width}×${ia.height}`, png: count > 0 ? rb.c.toDataURL('image/png').split(',')[1] : null }
        },
        [a.toString('base64'), b.toString('base64')],
      )
      if (diff.png) await writeFile(join(after, 'diff', file), Buffer.from(diff.png, 'base64'))
      lines.push(`| ${file} | ${diff.count < 0 ? '大きさが違う' : diff.count} | ${diff.size} |`)
    }
  } finally {
    await page.close()
  }
  return lines
}

async function main(): Promise<void> {
  const outDir = resolve(ROOT, args.out!)
  await mkdir(join(outDir, 'shots'), { recursive: true })
  await mkdir(join(outDir, 'overlay'), { recursive: true })
  const browserType = args.browser === 'firefox' ? firefox : chromium
  const only = args.only?.split(',').filter(Boolean) ?? []
  const port = Number(args.port)
  const server = await startDevServer(port)
  const browser = await browserType.launch()
  try {
    const results: Result[] = []
    const scrolls: Record<string, ScrollBox[]> = {}
    for (const [i, scene] of SCENES.entries()) {
      if (only.length > 0 && !only.some((part) => scene.name.includes(part))) continue
      process.stdout.write(`${scene.name}…`)
      try {
        const found = await runScene(browser, `http://127.0.0.1:${port}`, scene, i + 1, args.shots ? outDir : null)
        results.push(...found.results)
        scrolls[scene.name] = found.scrollBoxes
        console.log(` ${found.results.length}`)
      } catch (error) {
        console.log(` 開けませんでした：${(error as Error).message.split('\n').slice(0, 4).join(' / ')}`)
      }
    }
    const meta = { date: new Date().toISOString(), browser: `${browserType.name()} ${browser.version()}`, viewport: VIEWPORT }
    const report = markdownReport(results, scrolls, meta)
    await writeFile(join(outDir, 'target-size.json'), JSON.stringify({ meta, results, scrolls }, null, 2))
    await writeFile(join(outDir, 'target-size.md'), report)
    console.log(`\n${report.split('\n## ')[0]}`)
    console.log(`results: ${join(outDir, 'target-size.md')}`)
    if (args.compare) {
      const lines = await compareShots(browser, resolve(ROOT, args.compare), outDir)
      await writeFile(join(outDir, 'compare.md'), lines.join('\n'))
      console.log(lines.join('\n'))
    }
  } finally {
    await browser.close()
    server.kill()
  }
}

await main()
