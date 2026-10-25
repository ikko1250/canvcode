import { expect, test, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RecordStore } from '../../apps/server/src/records.ts'

// 開いた Canvas の分だけ読む（docs/lazy-canvas-loading-plan.md）。
// ほかの e2e と違い、本物のサーバー（使い捨てのワークスペース）と、それにつないだ Vite の開発サーバーを、このファイルの中で起動する。
//
// ワークスペース：
//   ルート ─ Portal → A（group の中に node:a-inner、node:a）─ Portal → B（node:b）
//          ─ Portal → C（node:c、引用ノート node:q-c）
//          └ 引用ノート node:q-root
//   ゴミ箱：T（持ち主の Portal は A の group の中にあった）、D（中身 node:d）

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

test.describe.configure({ mode: 'serial' })

let server: ChildProcess | null = null
let vite: ChildProcess | null = null
let workspaceDir = ''
let base = ''
let apiBase = ''
const ids = { root: '', a: 'canvas:lazyA', b: 'canvas:lazyB', c: 'canvas:lazyC', t: 'canvas:lazyT', d: 'canvas:lazyD' }

function populate(dataDir: string): void {
  const store = new RecordStore(dataDir)
  try {
    const root = store.rootCanvasId
    ids.root = root
    const now = 1
    const canvas = (id: string, title: string, parentCanvasId: string | null, ownerNodeId: string | null, extra: Record<string, unknown> = {}) => ({
      typeName: 'canvas', id, title, parentCanvasId, ownerNodeId, createdAt: now, updatedAt: now, deletedAt: null, trash: null, ...extra,
    })
    const node = (id: string, parentId: string, type: string, props: Record<string, unknown>, x = 0, index = 'a0') => ({
      typeName: 'node', id, type, parentId, x, y: 0, rotation: 0, index, opacity: 1, locked: false, props, meta: {},
    })
    const geo = (id: string, parentId: string, x = 0, index = 'a0') =>
      node(id, parentId, 'geo', { shape: 'rect', w: 100, h: 100, fill: { type: 'solid', color: '#e8eefc', opacity: 1 }, stroke: { type: 'solid', color: '#3b5bdb', opacity: 1 }, strokeWidth: 2, label: id }, x, index)
    const portal = (id: string, parentId: string, targetId: string, x: number, index: string) => node(id, parentId, 'portal', { targetId, role: 'owner', w: 240, h: 170 }, x, index)
    const quote = (id: string, parentId: string, memo: string, index: string) =>
      node(id, parentId, 'quote-card', { anchorId: 'anchor:lazy', fileId: 'file:lazy', quote: '引用した文', figure: null, memo, w: 280 }, 600, index)
    const trashedPortal = portal('node:portal-t', 'node:group', ids.t, 300, 'a2')
    store.apply(
      [
        portal('node:portal-a', root, ids.a, 0, 'a0'),
        portal('node:portal-c', root, ids.c, 300, 'a1'),
        quote('node:q-root', root, 'ルートのメモ', 'a2'),
        canvas(ids.a, 'A', root, 'node:portal-a'),
        node('node:group', ids.a, 'group', {}, 0, 'a0'),
        geo('node:a-inner', 'node:group', 0, 'a0'),
        geo('node:a', ids.a, 400, 'a1'),
        portal('node:portal-b', ids.a, ids.b, 0, 'a2'),
        canvas(ids.b, 'B', ids.a, 'node:portal-b'),
        geo('node:b', ids.b),
        canvas(ids.c, 'C', root, 'node:portal-c'),
        geo('node:c', ids.c),
        quote('node:q-c', ids.c, 'C のメモ', 'a1'),
        canvas(ids.t, 'T', null, null, { deletedAt: now, trash: { batchId: 'canvas:batchT', portal: trashedPortal } }),
        canvas(ids.d, 'D', null, null, { deletedAt: now, trash: { batchId: 'canvas:batchD', portal: null } }),
        geo('node:d', ids.d),
        { typeName: 'file', id: 'file:lazy', kind: 'pdf', title: '資料', path: '', size: 1, mtime: now, hash: 'x', missing: false, parentCanvasId: null, ownerNodeId: null, createdAt: now, updatedAt: now, deletedAt: null, trash: null },
        { typeName: 'anchor', id: 'anchor:lazy', fileId: 'file:lazy', locator: { kind: 'pdf', pageIndex: 0, rect: { x: 0, y: 0, w: 0.5, h: 0.1 } }, quote: '引用した文', createdAt: now },
      ],
      [],
    )
  } finally {
    store.close()
  }
}

async function waitFor(url: string): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // まだ起動していない
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`did not start: ${url}`)
}

// oxlint-disable-next-line no-empty-pattern -- Playwright は最初の引数を分割代入で受け取るよう求める
test.beforeAll(async ({}, info) => {
  const port = 4400 + info.workerIndex * 2
  workspaceDir = mkdtempSync(join(tmpdir(), 'canvcode-lazy-'))
  populate(join(workspaceDir, '.canvcode'))
  apiBase = `http://127.0.0.1:${port}`
  base = `http://127.0.0.1:${port + 1}`
  server = spawn(process.execPath, [join(ROOT, 'apps/server/src/index.ts'), '--workspace', workspaceDir], {
    cwd: ROOT,
    env: { ...process.env, CANVCODE_PORT: String(port), CANVCODE_CLAUDE: '0' },
    stdio: 'ignore',
  })
  vite = spawn('npm', ['run', 'dev', '-w', '@canvcode/web', '--', '--host', '127.0.0.1', '--port', String(port + 1), '--strictPort'], {
    cwd: ROOT,
    env: { ...process.env, CANVCODE_API_TARGET: apiBase },
    stdio: 'ignore',
    detached: true,
  })
  await waitFor(`${apiBase}/api/records?root`)
  await waitFor(`${base}/`)
})

test.afterAll(() => {
  server?.kill()
  // npm の子（vite）ごと止める
  if (vite?.pid) {
    try {
      process.kill(-vite.pid)
    } catch {
      vite.kill()
    }
  }
  if (workspaceDir) rmSync(workspaceDir, { recursive: true, force: true })
})

async function open(page: Page, path: string): Promise<void> {
  await page.goto(`${base}${path}`)
  await page.waitForFunction(() => Boolean((window as any).canvcode?.view))
}

const has = (page: Page, id: string) => page.evaluate((id) => (window as any).canvcode.workspace.store.has(id), id)
const canvasOf = async (id: string) => ((await (await fetch(`${apiBase}/api/records/${encodeURIComponent(id)}/canvas`)).json()) as { canvasId: string | null }).canvasId

// 今の Canvas にノードを足す（同期で送り終えるまで待つ）
async function addNode(page: Page, id: string): Promise<void> {
  await page.evaluate(async (id) => {
    const app = (window as any).canvcode
    const editor = app.editor
    const node = { ...editor.makeNode('geo', { x: 0, y: 300 }), id }
    editor.transact('add', (tx: any) => tx.put(node))
    app.sync.flush()
  }, id)
  await page.waitForFunction(() => !(window as any).canvcode.sync.pending)
}

test('opens a canvas in a new tab with only its nodes, and loads another canvas when moving into it', async ({ page }) => {
  await open(page, `/c/${encodeURIComponent(ids.a)}`)
  expect(await page.evaluate(() => (window as any).canvcode.editor.canvasId)).toBe(ids.a)
  expect(await has(page, 'node:a-inner')).toBe(true)
  // ほかの Canvas のノードは読まない。一覧のレコードは全部ある
  for (const id of ['node:b', 'node:c', 'node:portal-a', 'node:q-c']) expect(await has(page, id)).toBe(false)
  for (const id of [ids.b, ids.c, ids.t, 'file:lazy', 'anchor:lazy']) expect(await has(page, id)).toBe(true)
  await expect(page.locator('.breadcrumb-item')).toHaveCount(2)

  await page.evaluate((id) => (window as any).canvcode.navigate(id), ids.b)
  await expect.poll(() => page.evaluate(() => (window as any).canvcode.editor.canvasId)).toBe(ids.b)
  expect(await has(page, 'node:b')).toBe(true)
  expect(new URL(page.url()).pathname).toBe(`/c/${encodeURIComponent(ids.b)}`)
})

test('follows the changes of the canvases it has read from another tab, and loads the others fresh', async ({ context }) => {
  const reader = await context.newPage()
  const writer = await context.newPage()
  await open(reader, `/c/${encodeURIComponent(ids.a)}`)
  await open(writer, `/c/${encodeURIComponent(ids.c)}`)
  await addNode(writer, 'node:c-added')
  // 読んでいない Canvas の変更は届かない
  await reader.waitForTimeout(300)
  expect(await has(reader, 'node:c-added')).toBe(false)
  // 入ると、今の中身が届く。そのあとの変更も届く
  await reader.evaluate((id) => (window as any).canvcode.navigate(id), ids.c)
  await expect.poll(() => has(reader, 'node:c-added')).toBe(true)
  await addNode(writer, 'node:c-live')
  await expect.poll(() => has(reader, 'node:c-live')).toBe(true)
})

test('moves a node into a canvas that is not loaded, placing it beside the content there', async ({ page }) => {
  await open(page, `/c/${encodeURIComponent(ids.a)}`)
  expect(await has(page, 'node:b')).toBe(false)
  const moved = await page.evaluate((target) => (window as any).canvcode.view.moveToCanvas(['node:a'], target), ids.b)
  expect(moved).toBe(true)
  await page.waitForFunction(() => !(window as any).canvcode.sync.pending)
  expect(await canvasOf('node:a')).toBe(ids.b)
  // 移す先の中身（node:b）を読んで、その右に置いた
  const positions = await page.evaluate(() => {
    const workspace = (window as any).canvcode.workspace
    return { a: workspace.getNode('node:a').x, b: workspace.getNode('node:b').x }
  })
  expect(positions.a).toBeGreaterThan(positions.b)
})

test('counts the quote notes in canvases that are not loaded, and keeps their anchor', async ({ page }) => {
  await open(page, '/')
  expect(await has(page, 'node:q-c')).toBe(false)
  const notes = await page.evaluate(() => (window as any).canvcode.workspace.notesOfAnchor('anchor:lazy').map((n: { id: string; head: string }) => `${n.id}:${n.head}`))
  expect(notes.sort()).toEqual(['node:q-c:C のメモ', 'node:q-root:ルートのメモ'])
  // ルートの引用ノートを消しても、C のノートが引用しているので SourceAnchor は残る
  await page.evaluate(() => (window as any).canvcode.editor.deleteNodes(['node:q-root']))
  await page.waitForFunction(() => !(window as any).canvcode.sync.pending)
  expect(await has(page, 'anchor:lazy')).toBe(true)
  // 引用ノートの一覧から、読んでいない Canvas のノートへ移る
  await page.evaluate(() => {
    const app = (window as any).canvcode
    app.view.options.onOpenCitations(['anchor:lazy'], { clientX: 200, clientY: 200 })
  })
  await page.locator('.context-menu button', { hasText: 'C のメモ' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).canvcode.editor.canvasId)).toBe(ids.c)
  expect(await has(page, 'node:q-c')).toBe(true)
})

test('restores a trashed canvas into the group of a canvas that is not loaded, and deletes another forever with its contents', async ({ page }) => {
  await open(page, '/')
  expect(await has(page, 'node:group')).toBe(false)
  await page.keyboard.press('Control+\\')
  const trashed = (title: string) => page.locator('.sidebar-row.trashed', { hasText: title })
  await trashed('T').locator('button', { hasText: '元に戻す' }).click()
  await expect.poll(() => canvasOf('node:portal-t')).toBe(ids.a)
  await expect.poll(async () => ((await (await fetch(`${apiBase}/api/records`)).json()) as { records: { id: string; deletedAt?: number | null }[] }).records.find((r) => r.id === ids.t)?.deletedAt).toBeNull()

  await trashed('D').locator('button', { hasText: '削除' }).click()
  await page.locator('.dialog button', { hasText: '完全に削除する' }).click()
  await expect
    .poll(async () => ((await (await fetch(`${apiBase}/api/records`)).json()) as { records: { id: string }[] }).records.map((r) => r.id))
    .not.toContain('node:d')
})

test('does not undo creating a canvas after another tab put something in it', async ({ context }) => {
  const creator = await context.newPage()
  const other = await context.newPage()
  await open(creator, `/c/${encodeURIComponent(ids.c)}`)
  const created = await creator.evaluate(() => {
    const app = (window as any).canvcode
    const { canvasId } = app.editor.createPortal({ x: 900, y: 0 })
    app.sync.flush()
    return canvasId as string
  })
  await creator.waitForFunction(() => !(window as any).canvcode.sync.pending)
  await open(other, `/c/${encodeURIComponent(created)}`)
  await addNode(other, 'node:in-created')
  // 作ったタブは、その Canvas を読んだものとして扱うので、ほかのタブで足した中身も届く
  await expect.poll(() => has(creator, 'node:in-created')).toBe(true)
  await creator.evaluate(() => (window as any).canvcode.editor.undo())
  await creator.waitForTimeout(300)
  expect(await has(creator, created)).toBe(true)
  expect(await canvasOf('node:in-created')).toBe(created)
})
