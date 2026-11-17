import { expect, test, type Page } from '@playwright/test'

// 確認のダイアログ（MAI-108）：Enter はフォーカスのあるボタンを押すこと（最初の選択肢を決め打ちで選ばない）、
// 危ない選択肢があれば初めのフォーカスが「やめる」になること、「やめる」が左端で主な選択肢が右端に並ぶこと、
// Tab / Shift+Tab がダイアログの外へ出ないこと、閉じたら開く前のフォーカスへ戻ること、Enter・Esc がキャンバスへ届かないこと。
// グラフのダイアログ（PlotDialog）も同じくモーダルとして扱うこと。サーバーの応答だけを差し替える（design-panel.spec.ts と同じ）

const CANVAS_ID = 'canvas:dialog-test'
const CHILD_ID = 'canvas:dialog-child'
const TRASHED_ID = 'canvas:dialog-trashed'
const FILE_ID = 'file:dialog-csv'
const CSV = '名前,値\nA,1\nB,2\n'
// 1×1 の PNG（グラフのプレビューの代わり）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

function canvas(id: string, title: string, parentCanvasId: string | null, ownerNodeId: string | null, extra: object = {}) {
  return { typeName: 'canvas', id, title, parentCanvasId, ownerNodeId, createdAt: 0, updatedAt: 0, deletedAt: null, trash: null, ...extra }
}

function node(id: string, type: string, x: number, y: number, index: string, props: object) {
  return { typeName: 'node', id, type, parentId: CANVAS_ID, x, y, rotation: 0, index, opacity: 1, locked: false, version: 1, props, meta: {} }
}

async function openApp(page: Page) {
  const records = [
    canvas(CANVAS_ID, 'Dialog', null, null),
    canvas(CHILD_ID, '子', CANVAS_ID, 'node:portal'),
    canvas(TRASHED_ID, '捨てたキャンバス', null, null, { deletedAt: 1, trash: { batchId: 'canvas:batch-trashed', portal: null } }),
    node('node:portal', 'portal', 100, 100, 'a0', { targetId: CHILD_ID, role: 'owner', w: 240, h: 170 }),
    node('node:table', 'table-card', 500, 100, 'a1', { fileId: FILE_ID, w: 200, h: 120, sizing: 'auto', role: 'owner', header: true }),
  ]
  const file = { id: FILE_ID, kind: 'table', title: '一覧', path: '一覧.csv', size: CSV.length, mtime: 0, hash: 'test', missing: false }
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/api/records?*', (route) => route.fulfill({ json: { rootCanvasId: CANVAS_ID, rev: 0, records } }))
  await page.route('**/api/files', (route) => route.fulfill({ json: { files: [file] } }))
  await page.route(`**/api/files/${encodeURIComponent(FILE_ID)}/content`, (route) => route.fulfill({ body: CSV, headers: { etag: '"test"' } }))
  await page.route('**/api/plot/styles', (route) => route.fulfill({ json: { styles: [{ name: 'プレゼン', description: '見本', colors: ['#0072b2', '#e69f00'] }] } }))
  await page.route('**/api/plot', (route) => route.fulfill({ body: PNG, contentType: 'image/png', headers: { 'x-canvcode-width': '1', 'x-canvcode-height': '1' } }))
  await page.goto('/')
  await expect(canvasRoot(page)).toBeVisible()
}

const canvasRoot = (page: Page) => page.locator('.canvas-container > div[tabindex]')

// カメラは最初 (0, 0)・倍率 1
async function clickWorld(page: Page, x: number, y: number, button: 'left' | 'right' = 'left') {
  const rect = (await canvasRoot(page).boundingBox())!
  await page.mouse.click(rect.x + x, rect.y + y, { button })
}

// キャンバスの確認を直接呼ぶ（選んだ値を window.__choice に入れる。答えるまでは 'pending'）
async function askTrash(page: Page) {
  await page.evaluate(() => {
    const w = window as any
    w.__choice = 'pending'
    w.canvcode.view.options.confirmOwnerPortalDeletion([{ title: '子', descendants: 0 }]).then((v: unknown) => (w.__choice = v))
  })
  await expect(page.getByRole('dialog', { name: 'キャンバスを消しますか？' })).toBeVisible()
}

async function askMove(page: Page) {
  await page.evaluate(() => {
    const w = window as any
    w.__choice = 'pending'
    w.canvcode.view.options.confirmMoveToCanvas({ title: '子', count: 2 }).then((v: unknown) => (w.__choice = v))
  })
  await expect(page.getByRole('dialog', { name: 'キャンバスに移動しますか？' })).toBeVisible()
}

const choice = (page: Page) => page.evaluate(() => (window as any).__choice)
const focusedLabel = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent ?? null)
const focusInDialog = (page: Page) => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') != null)

test('Delete on an owner portal asks with やめる focused; Enter there cancels without reaching the canvas, and focus returns', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 220, 185)
  await expect.poll(() => page.evaluate(() => [...(window as any).canvcode.editor.session.get().selectedIds])).toEqual(['node:portal'])
  await expect(canvasRoot(page)).toBeFocused()
  await page.keyboard.press('Delete')

  const dialog = page.getByRole('dialog', { name: 'キャンバスを消しますか？' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  await expect(dialog).toHaveAccessibleDescription(/ゴミ箱に送ります/)
  // 「やめる」が左端、主な選択肢（最初の選択肢）が右端
  const buttons = dialog.getByRole('button')
  await expect(buttons).toHaveText(['やめる', '未配置にする', 'ゴミ箱に送る'])
  const xs = await buttons.evaluateAll((list) => list.map((b) => b.getBoundingClientRect().x))
  expect([...xs].sort((a, b) => a - b)).toEqual(xs)
  // 危ない選択肢があるので、初めのフォーカスは「やめる」
  await expect(dialog.getByRole('button', { name: 'やめる' })).toBeFocused()

  await page.keyboard.press('Enter')
  await expect(dialog).toHaveCount(0)
  // 消していない。Enter はキャンバスに届いていない（選んだ Portal の中に入っていない）。フォーカスはキャンバスに戻る
  const state = () =>
    page.evaluate(() => {
      const app = (window as any).canvcode
      return { canvasId: app.editor.canvasId, portal: Boolean(app.editor.getNode('node:portal')), selected: [...app.editor.session.get().selectedIds] }
    })
  expect(await state()).toEqual({ canvasId: CANVAS_ID, portal: true, selected: ['node:portal'] })
  await expect(canvasRoot(page)).toBeFocused()

  // Esc でもやめる（キャンバスに届けば選択が外れる）
  await page.keyboard.press('Delete')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(await state()).toEqual({ canvasId: CANVAS_ID, portal: true, selected: ['node:portal'] })
  await expect(canvasRoot(page)).toBeFocused()

  // Tab で「ゴミ箱に送る」に移って Enter なら、ゴミ箱に送る
  await page.keyboard.press('Delete')
  await page.keyboard.press('Shift+Tab')
  await expect(dialog.getByRole('button', { name: 'ゴミ箱に送る' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => Boolean((window as any).canvcode.editor.getNode('node:portal')))).toBe(false)
})

test('Enter presses the focused button, and Tab / Shift+Tab stay inside the dialog', async ({ page }) => {
  await openApp(page)

  // Tab で「未配置にする」へ移って Enter → その選択肢
  await askTrash(page)
  expect(await focusedLabel(page)).toBe('やめる')
  await page.keyboard.press('Tab')
  expect(await focusedLabel(page)).toBe('未配置にする')
  await page.keyboard.press('Enter')
  await expect.poll(() => choice(page)).toBe('unplace')

  // 既定のフォーカス（「やめる」）で Enter → 何も選ばない
  await askTrash(page)
  await page.keyboard.press('Enter')
  await expect.poll(() => choice(page)).toBeNull()

  // Esc → やめる
  await askTrash(page)
  await page.keyboard.press('Escape')
  await expect.poll(() => choice(page)).toBeNull()

  // Tab / Shift+Tab はダイアログの中で回る
  await askTrash(page)
  const forward: (string | null)[] = []
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab')
    expect(await focusInDialog(page)).toBe(true)
    forward.push(await focusedLabel(page))
  }
  expect(forward).toEqual(['未配置にする', 'ゴミ箱に送る', 'やめる', '未配置にする'])
  const backward: (string | null)[] = []
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Shift+Tab')
    expect(await focusInDialog(page)).toBe(true)
    backward.push(await focusedLabel(page))
  }
  expect(backward).toEqual(['やめる', 'ゴミ箱に送る', '未配置にする', 'やめる'])
  // 端から回って「ゴミ箱に送る」で Enter → その選択肢
  await page.keyboard.press('Shift+Tab')
  expect(await focusedLabel(page)).toBe('ゴミ箱に送る')
  await page.keyboard.press('Enter')
  await expect.poll(() => choice(page)).toBe('trash')
})

test('without a danger choice the primary is focused; Enter elsewhere or held from before does not choose', async ({ page }) => {
  await openApp(page)
  const dialog = page.getByRole('dialog', { name: 'キャンバスに移動しますか？' })

  // 既定のボタン（主な選択肢）で Enter → その選択肢
  await askMove(page)
  await expect(dialog.getByRole('button')).toHaveText(['やめる', 'OK'])
  await expect(dialog.getByRole('button', { name: 'OK' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(() => choice(page)).toBe(true)

  // Tab で「やめる」に移って Enter → 何も選ばない
  await askMove(page)
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'やめる' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(() => choice(page)).toBe(false)

  // 本文を押して（フォーカスはダイアログ自体）Enter → 何もしない（閉じない）
  await askMove(page)
  await dialog.locator('p').click()
  expect(await focusInDialog(page)).toBe(true)
  await page.keyboard.press('Enter')
  await expect(dialog).toBeVisible()
  expect(await choice(page)).toBe('pending')
  await page.keyboard.press('Escape')
  await expect.poll(() => choice(page)).toBe(false)

  // 開く前から押し続けている Enter（キーのリピート）では選ばない
  await canvasRoot(page).focus()
  await page.keyboard.down('Enter')
  await askMove(page)
  await page.keyboard.down('Enter')
  await page.keyboard.up('Enter')
  await expect(dialog).toBeVisible()
  expect(await choice(page)).toBe('pending')
  await page.keyboard.press('Escape')
  await expect.poll(() => choice(page)).toBe(false)
})

test('deleting forever from the trash starts on やめる and returns focus to the sidebar button', async ({ page }) => {
  await openApp(page)
  await page.keyboard.press('Control+\\')
  const row = page.locator('.sidebar-row.trashed', { hasText: '捨てたキャンバス' })
  const remove = row.getByRole('button', { name: '削除' })
  await remove.click()

  const dialog = page.getByRole('dialog', { name: '完全に削除しますか？' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAccessibleDescription(/この操作は取り消せません/)
  await expect(dialog.getByRole('button')).toHaveText(['やめる', '完全に削除する'])
  await expect(dialog.getByRole('button', { name: 'やめる' })).toBeFocused()
  // 「やめる」で Enter → 消さない。フォーカスはサイドバーの「削除」に戻る
  await page.keyboard.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(row).toBeVisible()
  await expect(remove).toBeFocused()

  // 「完全に削除する」に移って Enter → 消す
  await page.keyboard.press('Enter')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: '完全に削除する' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(row).toHaveCount(0)
})

test('the plot dialog is modal too: named by its heading, Tab stays inside, Esc closes back to the canvas', async ({ page }) => {
  await openApp(page)
  await clickWorld(page, 600, 130, 'right')
  await page.locator('.context-menu button', { hasText: 'グラフを作る…' }).click()
  const dialog = page.getByRole('dialog', { name: 'グラフを作る 一覧' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  await expect(dialog).toBeFocused()
  await expect(dialog.getByRole('button', { name: '置く' })).toBeEnabled()
  // 「やめる」が左端、「置く」が右端
  const cancel = (await dialog.getByRole('button', { name: 'やめる' }).boundingBox())!
  const place = (await dialog.getByRole('button', { name: '置く' }).boundingBox())!
  expect(cancel.x).toBeLessThan(place.x)

  // 最初の前は最後（「置く」）、最後の次は最初へ
  await page.keyboard.press('Shift+Tab')
  await expect(dialog.getByRole('button', { name: '置く' })).toBeFocused()
  await page.keyboard.press('Tab')
  expect(await focusInDialog(page)).toBe(true)
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab')
    expect(await focusInDialog(page)).toBe(true)
  }

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(canvasRoot(page)).toBeFocused()
})
