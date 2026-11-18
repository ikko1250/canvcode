import { expect, test, type Locator, type Page } from '@playwright/test'

// 押せる部品の触れられる範囲（当たり。MAI-113）：見た目の大きさは変えずに、ボタンやスライダーの当たりを広げたこと。
// - 主な場所（サイドバー・デザインパネル・カラーピッカー・Claude のパネル・確認とグラフのダイアログ・左のパレット）の押せるものは、
//   当たりが 24×24px 以上（WCAG 2.2 の 2.5.8）で、広げた当たりがほかの押せるものの見た目にかからず、当たりどうしも重ならない
// - キャンバスに浮かぶボタンとダイアログのボタンは、44px（DADS）まで広がる
// - 見た目の外側の点を押すと、そのボタン（隣ではなく）が押される。スライダーは溝の上下を押しても値が変わる
// - フォーカスの枠（MAI-109）は、広げた当たりではなく、見た目の枠に沿って出る
// 当たりは document.elementFromPoint で、要素の中心から上下左右へ 0.25px 刻みでたどって測る（tests/bench/target-size.ts と同じ）。
// サーバーの応答だけを差し替える（design-panel.spec.ts と同じ）

const CANVAS_ID = 'canvas:target-test'
const CHILD_ID = 'canvas:target-child'
const TABLE_FILE = 'file:target-table'
const MD_FILE = 'file:target-memo'
const CSV = '店舗,売上,備考\n渋谷,300,駅の近く\n新宿,1200,大きな店舗\n'
// 1×1 の PNG（グラフのプレビューの代わり）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

function canvas(id: string, title: string, parentCanvasId: string | null, ownerNodeId: string | null, extra: object = {}) {
  return { typeName: 'canvas', id, title, parentCanvasId, ownerNodeId, createdAt: 0, updatedAt: 0, deletedAt: null, trash: null, ...extra }
}

function node(id: string, type: string, x: number, y: number, index: string, props: object) {
  return { typeName: 'node', id, type, parentId: CANVAS_ID, x, y, rotation: 0, index, opacity: 1, locked: false, version: 3, props, meta: {} }
}

async function openApp(page: Page) {
  const records = [
    canvas(CANVAS_ID, 'Target', null, null),
    canvas(CHILD_ID, '子', CANVAS_ID, 'node:portal'),
    canvas('canvas:target-trashed', '捨てたキャンバス', null, null, { deletedAt: 1, trash: { batchId: 'canvas:batch-target', portal: null } }),
    node('node:geo', 'geo', 100, 120, 'a0', { shape: 'rect', w: 120, h: 120, fill: '#e8eefc', stroke: '#3b5bdb', strokeWidth: 2, label: '図形' }),
    node('node:gradient', 'geo', 260, 120, 'a1', {
      shape: 'rect', w: 120, h: 120, stroke: null, strokeWidth: 0, label: '',
      fill: { type: 'linear', start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 }, opacity: 1, stops: [{ position: 0, color: '#ff0000', opacity: 1 }, { position: 1, color: '#0000ff', opacity: 1 }] },
    }),
    node('node:text', 'text', 500, 140, 'a2', { text: 'hello', fontSize: 16, color: '#1f2328', align: 'left', w: 200, autoWidth: true }),
    node('node:table', 'table-card', 400, 330, 'a3', { fileId: TABLE_FILE, w: 360, h: 200, sizing: 'auto', role: 'owner', header: true }),
    node('node:portal', 'portal', 100, 600, 'a4', { targetId: CHILD_ID, role: 'owner', w: 240, h: 170 }),
  ]
  const files = [
    { id: TABLE_FILE, kind: 'table', title: '店舗', path: '店舗.csv', size: CSV.length, mtime: 0, hash: 'test', missing: false },
    { id: MD_FILE, kind: 'markdown', title: 'メモ', path: 'メモ.md', size: 10, mtime: 0, hash: 'test', missing: false },
  ]
  const now = Date.now()
  const thread = {
    threadId: 't1', title: '会話', createdAt: now, updatedAt: now, jobCount: 1, running: false,
    tasks: [{ id: 'ag1', description: '論文を探す', type: 'local_agent' }], permissions: [],
  }
  const jobs = [{ id: 'j1', threadId: 't1', prompt: '整理して', status: 'done', createdAt: now, eventCount: 1, events: [{ kind: 'text', text: '整理しました' }] }]
  const models = {
    models: [
      { value: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium', 'high'] },
      { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', efforts: [] },
    ],
    default: { value: 'opus', label: 'Opus 5.5' },
    fromClaude: true,
  }
  const stops: string[] = []
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files } }))
  await page.route(`**/api/files/${encodeURIComponent(TABLE_FILE)}/content`, (route) => route.fulfill({ body: CSV, headers: { etag: '"test"' } }))
  await page.route('**/api/claude/threads', (route) => route.fulfill({ json: { threads: [thread] } }))
  await page.route('**/api/claude/threads/t1', (route) => route.fulfill({ json: { jobs } }))
  await page.route('**/api/claude/threads/t1/**', (route) => {
    stops.push(new URL(route.request().url()).pathname)
    return route.fulfill({ status: 204 })
  })
  await page.route('**/api/claude/events', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/claude/models', (route) => route.fulfill({ json: models }))
  await page.route('**/api/plot/styles', (route) => route.fulfill({ json: { styles: [{ name: 'プレゼン', description: '見本', colors: ['#0072b2', '#e69f00'] }] } }))
  await page.route('**/api/plot', (route) => route.fulfill({ body: PNG, contentType: 'image/png', headers: { 'x-canvcode-width': '1', 'x-canvcode-height': '1' } }))
  await page.goto('/')
  await expect(canvasRoot(page)).toBeVisible()
  await page.waitForFunction(() => Boolean((window as any).canvcode?.view))
  return { stops }
}

const canvasRoot = (page: Page) => page.locator('.canvas-container > div[tabindex]')

async function clickWorld(page: Page, x: number, y: number, button: 'left' | 'right' = 'left') {
  const rect = (await canvasRoot(page).boundingBox())!
  await page.mouse.click(rect.x + x, rect.y + y, { button })
}

// 押せるもの（label は、その入力の当たりとして数える）
const TARGETS = [
  'button',
  'a[href]',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'label',
  '[role="button"]',
  '[role="tab"]',
  '[role="radio"]',
  '[role="slider"]',
  '[role="option"]',
].join(', ')

interface Target {
  name: string
  // 見えている枠
  box: { x: number; y: number; w: number; h: number }
  // 当たり（中心を通る横と縦の線の上で、続いて当たる長さ）
  w: number
  h: number
  // 見えている枠の中で、ほかの押せるものに当たる所
  stolenBy: string[]
  // CSS で決めた当たり（見えている枠と、外へ広げた ::before）が重なる、ほかの押せるもの
  overlaps: string[]
}

// root の中の押せるもの（self なら root そのもの）の当たりを測る。スクロールの外に（一部でも）出ているものは数えない。
// スクロールする入れ物では、見えている枠だけでなく、広げた当たり（::before）が端で切れているものも数えない（スクロールの位置しだいで、
// 端にある部品の当たりは、部品が見えていても切れる。たとえば e2e の画面（Desktop Chrome の 1280×720）では、デザインパネルが
// スクロールし、カラーピッカーの行が、パネルの下の端にちょうど接する）
async function measureTargets(root: Locator, self = false): Promise<Target[]> {
  return root.evaluate((rootEl, { selector, self }) => {
    const describe = (e: Element) => {
      const text = (e.getAttribute('aria-label') || e.getAttribute('title') || (e.textContent ?? '')).trim().slice(0, 20)
      return `${e.tagName.toLowerCase()}.${[...e.classList].join('.')} 「${text}」`
    }
    const ownerOf = (hit: Element | null): Element | null => {
      const target = hit?.closest(selector) ?? null
      return target instanceof HTMLLabelElement ? target.control : target
    }
    const areaOf = (e: Element, r: DOMRect) => {
      const area = { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      const before = getComputedStyle(e, '::before')
      if (before.content === 'none' || before.content === 'normal' || before.position !== 'absolute') return area
      const style = getComputedStyle(e)
      return {
        left: Math.min(area.left, r.left + parseFloat(style.borderLeftWidth) + parseFloat(before.left)),
        top: Math.min(area.top, r.top + parseFloat(style.borderTopWidth) + parseFloat(before.top)),
        right: Math.max(area.right, r.right - parseFloat(style.borderRightWidth) - parseFloat(before.right)),
        bottom: Math.max(area.bottom, r.bottom - parseFloat(style.borderBottomWidth) - parseFloat(before.bottom)),
      }
    }
    // 中身を切る入れ物（要素の入れ物の並びの上にあるもの。position: fixed の要素はその上で切られず、absolute の要素は、位置を
    // 決めていない入れ物には切られない）の見える範囲（枠の内側）から、一部でも出ているか。スクロールできる入れ物では当たりの範囲で、
    // スクロールしない入れ物では見えている枠で調べる（スクロールしない入れ物で当たりが切れていれば、当たりが足りないと出る）
    const clipped = (e: Element) => {
      const r = e.getBoundingClientRect()
      const area = areaOf(e, r)
      let position = getComputedStyle(e).position
      for (let n = e.parentElement; n && position !== 'fixed'; n = n.parentElement) {
        const style = getComputedStyle(n)
        const skip = position === 'absolute' && style.position === 'static'
        if (!skip) position = style.position
        if (skip || (style.overflowX === 'visible' && style.overflowY === 'visible')) continue
        const b = n.getBoundingClientRect()
        const view = { left: b.left + n.clientLeft, top: b.top + n.clientTop, right: b.left + n.clientLeft + n.clientWidth, bottom: b.top + n.clientTop + n.clientHeight }
        const scrolls = n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1
        const box = scrolls ? area : r
        if (box.left < view.left - 0.5 || box.right > view.right + 0.5 || box.top < view.top - 0.5 || box.bottom > view.bottom + 0.5) return true
      }
      return false
    }
    const elements = (self ? [rootEl] : [...rootEl.querySelectorAll(selector)]).filter((e) => {
      if (e instanceof HTMLLabelElement) return false
      const r = e.getBoundingClientRect()
      return r.width >= 2 && r.height >= 2 && e.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && !clipped(e)
    })
    const measured = elements.map((e) => {
      const r = e.getBoundingClientRect()
      const mine = (x: number, y: number) => ownerOf(document.elementFromPoint(x, y)) === e
      const cx = Math.floor(r.left + r.width / 2) + 0.5
      const cy = Math.floor(r.top + r.height / 2) + 0.5
      const reach = (dx: number, dy: number) => {
        if (!mine(cx, cy)) return 0
        let d = 0
        while (d < 300 && mine(cx + dx * (d + 1), cy + dy * (d + 1))) d++
        let fine = 0
        for (const f of [0.25, 0.5, 0.75]) {
          if (!mine(cx + dx * (d + f), cy + dy * (d + f))) break
          fine = f
        }
        return d + fine
      }
      const stolen = new Set<string>()
      for (let y = r.top + 1.5; y < r.bottom - 1; y += 3) {
        for (let x = r.left + 1.5; x < r.right - 1; x += 3) {
          const other = ownerOf(document.elementFromPoint(x, y))
          if (other && other !== e && !e.contains(other) && !other.contains(e)) stolen.add(describe(other))
        }
      }
      return {
        el: e,
        area: areaOf(e, r),
        target: {
          name: describe(e),
          box: { x: r.left, y: r.top, w: r.width, h: r.height },
          w: reach(-1, 0) + reach(1, 0),
          h: reach(0, -1) + reach(0, 1),
          stolenBy: [...stolen],
          overlaps: [] as string[],
        },
      }
    })
    for (const [i, a] of measured.entries()) {
      for (const b of measured.slice(i + 1)) {
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue
        const w = Math.min(a.area.right, b.area.right) - Math.max(a.area.left, b.area.left)
        const h = Math.min(a.area.bottom, b.area.bottom) - Math.max(a.area.top, b.area.top)
        if (w > 0.5 && h > 0.5) {
          a.target.overlaps.push(b.target.name)
          b.target.overlaps.push(a.target.name)
        }
      }
    }
    return measured.map((m) => m.target)
  }, { selector: TARGETS, self })
}

// 当たりが 24×24 に足りないもの・ほかの見た目にかかるもの・重なるものを、名前で返す（測り方の誤差 0.5px を見込む）
async function targetProblems(root: Locator, options: { min?: number } = {}) {
  const min = (options.min ?? 24) - 0.5
  const targets = await measureTargets(root)
  expect(targets.length).toBeGreaterThan(0)
  return targets.flatMap((t) => {
    const problems: string[] = []
    if (t.w < min || t.h < min) problems.push(`${t.name}：当たりが ${t.w}×${t.h}`)
    for (const other of t.stolenBy) problems.push(`${t.name}：見た目の中が ${other} に当たる`)
    for (const other of t.overlaps) problems.push(`${t.name}：当たりが ${other} と重なる`)
    return problems
  })
}

// 1 つの要素の当たり
async function hitSize(locator: Locator) {
  const [target] = await measureTargets(locator, true)
  return target
}

test('buttons, sliders and swatches in the main places have targets of 24×24 or more that do not overlap', async ({ page }) => {
  await openApp(page)

  // サイドバー（ここに置く・元に戻す・削除）
  await page.locator('.sidebar-open').click()
  await expect(page.locator('.sidebar-row.trashed')).toBeVisible()
  expect(await targetProblems(page.locator('.sidebar'))).toEqual([])
  await page.locator('.sidebar-header button').click()

  // デザインパネル：図形の見た目（スライダー・アイコンのボタン・見本）、文字、カラーピッカー
  await clickWorld(page, 160, 180)
  const panel = page.getByTestId('design-panel')
  await expect(panel.locator('[data-section="fill"]')).toBeVisible()
  expect(await targetProblems(panel)).toEqual([])
  await panel.locator('[data-section="fill"] .design-swatch').click()
  await expect(page.locator('.design-color-popup')).toBeVisible()
  expect(await targetProblems(page.locator('.design-color-popup'))).toEqual([])
  // パネルの下の端より下にある色見本（DADS のテンプレート。MAI-114）は、スクロールして見えるようにしてから測る
  await page.locator('.design-color-popup .design-color-group').last().scrollIntoViewIfNeeded()
  expect(await targetProblems(page.locator('.design-color-popup'))).toEqual([])
  // 文字のタブ（いちばん上にテキストスタイルの一覧。MAI-114）
  await panel.evaluate((e) => e.scrollTo({ top: 0 }))
  await panel.getByRole('tab', { name: '文字' }).click()
  await expect(panel.locator('[data-section="text"]')).toBeVisible()
  expect(await targetProblems(panel)).toEqual([])
  await expect(panel.getByRole('combobox', { name: 'テキストスタイル（DADS）' })).toBeVisible()
  // グラデーション（止め色の印・帯・消すボタン）
  await panel.getByRole('tab', { name: '図形' }).click()
  await clickWorld(page, 320, 180)
  await expect(panel.locator('[data-section="fill"] .design-paint-kind')).toBeVisible()
  await panel.locator('[data-section="fill"] .design-paint-kind').click()
  await expect(page.locator('.design-color-popup .design-gradient')).toBeVisible()
  expect(await targetProblems(page.locator('.design-color-popup'))).toEqual([])
  await page.locator('.design-color-popup .design-color-group').last().scrollIntoViewIfNeeded()
  expect(await targetProblems(page.locator('.design-color-popup'))).toEqual([])
  await canvasRoot(page).focus()
  await page.keyboard.press('Escape')

  // 左のパレット（矢印の色・太さ・矢じり）
  await page.evaluate(() => (window as any).canvcode.editor.session.set({ toolId: 'arrow' }))
  await expect(page.locator('.style-palette')).toBeVisible()
  expect(await targetProblems(page.locator('.style-palette'))).toEqual([])
  await page.evaluate(() => (window as any).canvcode.editor.session.set({ toolId: 'select' }))

  // Claude のパネル（作業の一覧の「止める」）と、モデルの選択。右上の「質問」は質問のタブを開くので、会話のタブに移る
  await page.locator('.claude-toggle').click()
  await page.locator('.question-panel').getByRole('tab', { name: '会話' }).click()
  const claude = page.locator('.claude-panel')
  await claude.locator('.claude-thread-select').selectOption('t1')
  await expect(claude.locator('.claude-task')).toBeVisible()
  expect(await targetProblems(claude)).toEqual([])
  await claude.locator('.claude-model-button').click()
  await expect(page.locator('.claude-model-popover [role="slider"]').first()).toBeVisible()
  expect(await targetProblems(page.locator('.claude-model-popover'))).toEqual([])
  await page.keyboard.press('Escape')
  await claude.locator('.claude-close').click()

  // グラフを作るダイアログ（種類・値の列のチェックボックス・style.py を開く）
  await clickWorld(page, 580, 360, 'right')
  await page.locator('.context-menu button', { hasText: 'グラフを作る…' }).click()
  const plot = page.getByRole('dialog', { name: /^グラフを作る/ })
  await expect(plot.locator('.plot-dialog-preview img')).toBeVisible()
  expect(await targetProblems(plot)).toEqual([])
  await page.keyboard.press('Escape')
  await expect(plot).toHaveCount(0)
})

test('floating buttons and dialog buttons reach 44px', async ({ page }) => {
  await openApp(page)
  const atLeast = async (locator: Locator, w: number, h: number) => {
    const hit = await hitSize(locator)
    expect(hit.w, hit.name).toBeGreaterThanOrEqual(w - 0.5)
    expect(hit.h, hit.name).toBeGreaterThanOrEqual(h - 0.5)
  }
  // 右上の Claude（高さ 25px の札）と、デザインパネルを開くボタン（40px）
  await atLeast(page.locator('.claude-toggle'), 44, 44)
  await clickWorld(page, 160, 180)
  const panel = page.getByTestId('design-panel')
  await expect(panel).toBeVisible()
  // パネルのタブと閉じるボタン（30px）は、見出しの帯の中で高さ 44px
  await atLeast(panel.getByRole('tab', { name: '文字' }), 30, 44)
  await panel.getByTitle('閉じる').click()
  await atLeast(page.getByTitle('デザインパネルを開く'), 44, 44)
  // サイドバーを閉じるボタン（23×26px）
  await page.locator('.sidebar-open').click()
  await atLeast(page.locator('.sidebar-header button'), 44, 44)
  await page.locator('.sidebar-header button').click()

  // 確認のダイアログのボタン（高さ 31px）
  await page.evaluate(() => {
    const w = window as any
    w.__choice = 'pending'
    w.canvcode.view.options.confirmOwnerPortalDeletion([{ title: '子', descendants: 0 }]).then((v: unknown) => (w.__choice = v))
  })
  const dialog = page.getByRole('dialog', { name: 'キャンバスを消しますか？' })
  await expect(dialog).toBeVisible()
  for (const button of await dialog.getByRole('button').all()) await atLeast(button, 44, 44)
})

test('pressing just outside a small button presses it, not its neighbor', async ({ page }) => {
  const { stops } = await openApp(page)

  // 色の見本（18px）：右隣との間（6px）の、自分に近い側を押すと、その色になる。見本は「テンプレート：キャンバス」の並び
  // （押しても変わらない。2 行ある）。パネルの下の端より下にあることがあるので、見えるようにスクロールする。押すと
  // 「このキャンバスで使った色」が増えて並びが下へずれることがあるので、押す前に位置を読み直す
  await clickWorld(page, 160, 180)
  const panel = page.getByTestId('design-panel')
  const hex = panel.locator('[data-section="fill"] input.design-hex')
  await panel.locator('[data-section="fill"] .design-swatch').click()
  const group = page.locator('.design-color-popup').getByRole('group', { name: 'テンプレート：キャンバス', exact: true })
  const chip = (i: number) => group.locator('.design-color-chip').nth(i)
  const boxOf = async (i: number) => {
    await group.scrollIntoViewIfNeeded()
    return (await chip(i).boundingBox())!
  }
  const [firstColor, secondColor, belowColor] = [await chip(0).getAttribute('data-color'), await chip(1).getAttribute('data-color'), await chip(10).getAttribute('data-color')]
  expect(new Set([firstColor, secondColor, belowColor]).size).toBe(3)
  let first = await boxOf(0)
  const second = await boxOf(1)
  expect(second.x - (first.x + first.width)).toBeCloseTo(6, 0)
  await page.mouse.click(first.x + first.width + 2, first.y + first.height / 2)
  await expect(hex).toHaveValue(firstColor!)
  const next = await boxOf(1)
  await page.mouse.click(next.x - 2, next.y + next.height / 2)
  await expect(hex).toHaveValue(secondColor!)
  // 見本の下（下の行の見本との間）の、自分に近い側を押しても、その見本
  first = await boxOf(0)
  const below = await boxOf(10)
  expect(below.y - (first.y + first.height)).toBeCloseTo(6, 0)
  await page.mouse.click(first.x + first.width / 2, first.y + first.height + 2)
  await expect(hex).toHaveValue(firstColor!)
  await canvasRoot(page).focus()
  await page.keyboard.press('Escape')
  await expect(page.locator('.design-color-popup')).toHaveCount(0)

  // スライダー：溝（3px）の 8px 上を押しても、値が変わる（線の太さ）
  await clickWorld(page, 160, 180)
  const slider = panel.locator('[data-section="stroke"] input.design-slider')
  const strokeWidth = panel.locator('[data-section="stroke"]').getByRole('textbox', { name: '太さ', exact: true })
  await expect(strokeWidth).toHaveValue('2')
  const track = (await slider.boundingBox())!
  await page.mouse.click(track.x + track.width * 0.5, track.y + track.height / 2 - 8)
  await expect(strokeWidth).not.toHaveValue('2')
  await canvasRoot(page).focus()
  await page.keyboard.press('Escape')

  // サイドバーの「元に戻す」（高さ 23px）：行の高さ（25px）まで広げたので、見た目の 0.5px 上も「元に戻す」に当たる。
  // 広げたのは 1px だけなので、マウスの座標の丸めに左右されないよう、押さずに elementFromPoint で確かめる（幅は 44px を超えるので、
  // 左右には広げない）
  await page.locator('.sidebar-open').click()
  const restore = page.locator('.sidebar-row.trashed', { hasText: '捨てたキャンバス' }).getByRole('button', { name: '元に戻す' })
  const hits = await restore.evaluate((e) => {
    const r = e.getBoundingClientRect()
    const at = (x: number, y: number) => document.elementFromPoint(x, y) === e
    return [at(r.left + r.width / 2, r.top - 0.5), at(r.left + r.width / 2, r.bottom + 0.5)]
  })
  expect(hits).toEqual([true, true])
  await page.locator('.sidebar-header button').click()

  // Claude のパネルの作業の「止める」（文字だけ、高さ 17px）：文字の 3px 下を押す（右上の「質問」から、会話のタブに移る）
  await page.locator('.claude-toggle').click()
  await page.locator('.question-panel').getByRole('tab', { name: '会話' }).click()
  await page.locator('.claude-thread-select').selectOption('t1')
  const stop = (await page.locator('.claude-task').getByRole('button', { name: '止める' }).boundingBox())!
  await page.mouse.click(stop.x + stop.width / 2, stop.y + stop.height + 3)
  await expect.poll(() => stops).toEqual(['/api/claude/threads/t1/tasks/ag1/stop'])
  await page.locator('.claude-panel .claude-close').click()

  // 確認のダイアログ：「未配置にする」の 6px 下を押すと、未配置にする（ダイアログの外を押したときの「やめる」にはならない）
  await page.evaluate(() => {
    const w = window as any
    w.__choice = 'pending'
    w.canvcode.view.options.confirmOwnerPortalDeletion([{ title: '子', descendants: 0 }]).then((v: unknown) => (w.__choice = v))
  })
  const unplace = (await page.getByRole('dialog').getByRole('button', { name: '未配置にする' }).boundingBox())!
  await page.mouse.click(unplace.x + unplace.width / 2, unplace.y + unplace.height + 6)
  await expect.poll(() => page.evaluate(() => (window as any).__choice)).toBe('unplace')
})

test('the focus ring follows the visible button, not the widened target', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 160, 180)
  const panel = page.getByTestId('design-panel')
  const textTab = panel.getByRole('tab', { name: '文字' })
  await expect(textTab).toBeVisible()
  // 当たりは見た目より上下に 7px ずつ広い
  const hit = await hitSize(textTab)
  const box = (await textTab.boundingBox())!
  expect(hit.h).toBeGreaterThanOrEqual(box.height + 13.5)
  // Tab で移る（:focus-visible）
  for (let i = 0; i < 40 && !(await textTab.evaluate((e) => e === document.activeElement)); i++) await page.keyboard.press('Tab')
  await expect(textTab).toBeFocused()
  // 黒い枠（outline 4px、要素から 2px 外）の画素の範囲は、見た目の枠から 6px 外まで
  const margin = 14
  const clip = { x: box.x - margin, y: box.y - margin, width: box.width + margin * 2, height: box.height + margin * 2 }
  const png = await page.screenshot({ clip })
  const black = await page.evaluate(async (base64) => {
    const image = new Image()
    image.src = `data:image/png;base64,${base64}`
    await image.decode()
    const c = document.createElement('canvas')
    c.width = image.width
    c.height = image.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(image, 0, 0)
    const data = ctx.getImageData(0, 0, c.width, c.height).data
    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bottom = -Infinity
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4
        if (data[i] < 40 && data[i + 1] < 40 && data[i + 2] < 40) {
          left = Math.min(left, x)
          top = Math.min(top, y)
          right = Math.max(right, x + 1)
          bottom = Math.max(bottom, y + 1)
        }
      }
    }
    return { left, top, right, bottom }
  }, png.toString('base64'))
  // 小数の位置の丸めで 1px までずれる
  const expected = { left: margin - 6, top: margin - 6, right: margin + box.width + 6, bottom: margin + box.height + 6 }
  for (const side of ['left', 'top', 'right', 'bottom'] as const) expect(Math.abs(black[side] - expected[side]), side).toBeLessThanOrEqual(1)
})
