import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentHost } from './agent/host.ts'
import { editCanvas } from './agent/ops.ts'
import { readCanvas } from './agent/outline.ts'
import { FileStore } from './files.ts'
import { RecordStore, type StoredRecord } from './records.ts'
import { cleanupSlidesV1, describeSlidesV1Cleanup } from './slidesV1Cleanup.ts'

// v1 のスライドを消したあとの、保存済みのデータの片付け（起動時に 1 度）

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'canvcode-slides-v1-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function file(id: string, path: string, extra: Partial<StoredRecord> = {}): StoredRecord {
  return {
    typeName: 'file', id, kind: 'slides', title: path.replace(/\.slide\.(md|json)$/, ''), path, size: 1, mtime: 1, hash: 'h', missing: false,
    parentCanvasId: null, ownerNodeId: null, createdAt: 1, updatedAt: 1, deletedAt: null, trash: null, ...extra,
  }
}

// v1 のデッキのキャンバスに似せたワークスペース。AI の編集で図形と矢印・group・v2 のスライドを作り、
// 図形の一部を v1 の型（デッキのカード・スライドの画像）に書き換える
function v1Workspace() {
  const workspace = tempDir()
  const dataDir = join(workspace, '.canvcode')
  const records = new RecordStore(dataDir)
  cleanups.push(() => records.close())
  const root = records.rootCanvasId
  const host = new AgentHost({ records })
  const made = editCanvas(host, {
    canvasId: root,
    ops: [
      { op: 'create', type: 'geo', as: 'deck', x: 0, y: 0, w: 480, h: 320 },
      { op: 'create', type: 'geo', as: 'p1', x: 600, y: 0, w: 640, h: 360 },
      { op: 'create', type: 'geo', as: 'p2', x: 600, y: 400, w: 640, h: 360 },
      { op: 'create', type: 'geo', as: 'p3', x: 1300, y: 400, w: 640, h: 360 },
      { op: 'group', as: 'g', ids: ['$p2', '$p3'] },
      { op: 'create', type: 'note', as: 'n', text: '書き込み', x: 0, y: 800 },
      { op: 'connect', as: 'a', from: '$n', to: '$p1' },
      { op: 'create', type: 'slide', as: 's', x: 0, y: 2000, name: 'v2' },
    ],
  }).created as Record<string, string>
  host.dispose()
  const retype = (id: string, type: string, props: Record<string, unknown>) => {
    const record = records.get(id)!
    records.apply([{ ...record, type, version: 1, props: { ...props, w: (record.props as { w: number }).w, h: (record.props as { h: number }).h } }], [])
  }
  retype(made.deck, 'slide-deck-card', { fileId: 'file:deck', role: 'owner' })
  for (const [i, id] of [made.p1, made.p2, made.p3].entries()) retype(id, 'slide-page', { fileId: 'file:deck', slideKey: `s${i}`, hash: 'x', slideIndex: i, removed: false })
  const trashedPortal = { typeName: 'node', id: 'node:oldcard', type: 'slide-deck-card', parentId: root, x: 0, y: 0, rotation: 0, index: 'a0', locked: false, props: { fileId: 'file:old', role: 'owner' } }
  records.apply(
    [
      file('file:deck', 'デッキ.slide.md', { ownerNodeId: made.deck, parentCanvasId: root }),
      file('file:json', 'json.slide.json'),
      file('file:old', '古い.slide.md', { deletedAt: 5, trash: { batchId: 'canvas:batch', portal: trashedPortal } }),
      { typeName: 'file', id: 'file:md', kind: 'markdown', title: 'メモ', path: 'メモ.md', size: 1, mtime: 1, hash: 'h', missing: false, parentCanvasId: null, ownerNodeId: null, createdAt: 1, updatedAt: 1, deletedAt: null, trash: null },
    ],
    [],
  )
  // 取り消すと v1 の型のノードを戻す AI の編集の記録（片付けで消す）
  records.applyAgentOp({ id: 'op:v1', canvasId: root, label: 'old', createdAt: 1, patch: [{ id: 'node:gone', before: { ...trashedPortal, id: 'node:gone', type: 'slide-page' }, after: null }] })
  // v1 のキャッシュと、実ファイル
  for (const dir of ['slide-pages', 'figures']) {
    mkdirSync(join(dataDir, dir), { recursive: true })
    writeFileSync(join(dataDir, dir, 'a.png'), 'PNG')
  }
  writeFileSync(join(workspace, 'デッキ.slide.md'), '# 表紙\n')
  writeFileSync(join(workspace, 'json.slide.json'), '{"slides":[]}\n')
  return { workspace, dataDir, records, root, made }
}

describe('cleanupSlidesV1', () => {
  it('removes the v1 nodes the way a delete does, and keeps everything else', async () => {
    const { dataDir, records, root, made } = v1Workspace()
    const arrowBefore = records.get(made.a)!
    const result = await cleanupSlidesV1(records, dataDir)
    expect(result).not.toBeNull()

    // デッキのカードとスライドの画像（4 個）と、空になった group が消える
    for (const id of [made.deck, made.p1, made.p2, made.p3, made.g]) expect(records.get(id)).toBeUndefined()
    expect(records.nodeIdsOfTypes(['slide-deck-card', 'slide-page'])).toEqual([])
    expect(result!.removedNodes).toBe(5)
    // 矢印は残り、スライドの画像につながっていた端は、その場に固定して Binding を外す
    const arrow = records.get(made.a)!
    const bindings = records.bindingsFrom([made.a])
    expect(bindings).toHaveLength(1)
    expect(bindings[0]!.toId).toBe(made.n)
    expect(result!.removedBindings).toBe(1)
    const end = (arrow.props as { end: { x: number; y: number } }).end
    expect(arrow.type).toBe('arrow')
    expect(Number.isFinite(end.x) && Number.isFinite(end.y)).toBe(true)
    expect(arrow.props).not.toEqual(arrowBefore.props)
    // 書き込み（付箋）と v2 のスライドは残る
    expect(records.get(made.n)?.type).toBe('note')
    expect(records.get(made.s)?.type).toBe('slide')
    expect(readCanvas(records, { canvasId: root })).toContain(`${made.s} slide`)
  })

  it('turns .slide.md files into Markdown, drops .slide.json records, and unplaces the deck file', async () => {
    const { dataDir, records } = v1Workspace()
    const result = await cleanupSlidesV1(records, dataDir)
    // 持ち主のカードを消した File は、持ち主を外して未配置にする（'unplace' と同じ）
    expect(records.get('file:deck')).toMatchObject({ kind: 'markdown', title: 'デッキ.slide', ownerNodeId: null, parentCanvasId: null, deletedAt: null })
    expect(records.get('file:json')).toBeUndefined()
    // ゴミ箱の中の File はゴミ箱に残し、消した型の持ち主の写しを外す（元に戻すと未配置に戻る）
    expect(records.get('file:old')).toMatchObject({ kind: 'markdown', deletedAt: 5, trash: { batchId: 'canvas:batch', portal: null } })
    // ほかの File は変えない
    expect(records.get('file:md')).toMatchObject({ kind: 'markdown', title: 'メモ', updatedAt: 1 })
    expect(result).toMatchObject({ unplacedFiles: 1, markdownFiles: 2, removedFiles: 1, trashPortals: 1 })
  })

  it('removes the agent ops and caches of v1, keeps a copy of the database, and logs what it did', async () => {
    const { workspace, dataDir, records } = v1Workspace()
    const result = (await cleanupSlidesV1(records, dataDir))!
    expect(records.getAgentOp('op:v1')).toBeUndefined()
    expect(result.removedAgentOps).toBe(1)
    expect(existsSync(join(dataDir, 'slide-pages'))).toBe(false)
    expect(existsSync(join(dataDir, 'figures'))).toBe(false)
    expect(result.removedDirs).toEqual(['slide-pages', 'figures'])
    expect(readdirSync(dataDir).some((name) => name.startsWith('workspace.db.before-slides-v1-removal-'))).toBe(true)
    // 実ファイルは消さない
    expect(readFileSync(join(workspace, 'デッキ.slide.md'), 'utf8')).toBe('# 表紙\n')
    expect(existsSync(join(workspace, 'json.slide.json'))).toBe(true)
    expect(describeSlidesV1Cleanup(result)).toContain('v1 のスライドを片付けた：ノード 5 個（Binding 1 個）を消した')
  })

  it('does nothing the second time, or on a workspace without v1 slides', async () => {
    const { dataDir, records } = v1Workspace()
    await cleanupSlidesV1(records, dataDir)
    const rev = records.rev
    expect(await cleanupSlidesV1(records, dataDir)).toBeNull()
    expect(records.rev).toBe(rev)

    const empty = new RecordStore(join(tempDir(), '.canvcode'))
    cleanups.push(() => empty.close())
    expect(await cleanupSlidesV1(empty, join(tempDir(), '.canvcode'))).toBeNull()
  })

  it('lets the server workspace load records of node types it does not know', () => {
    const { records, root, made } = v1Workspace()
    const host = new AgentHost({ records })
    cleanups.push(() => host.dispose())
    // 片付ける前でも、知らない型のノードを飛ばして編集できる
    expect(host.workspace().getNode(made.deck)).toBeUndefined()
    const result = editCanvas(host, { canvasId: root, ops: [{ op: 'create', type: 'note', as: 'm', text: 'ok', x: 0, y: 3000 }] })
    expect(records.get((result.created as Record<string, string>).m)?.type).toBe('note')
  })
})

describe('FileStore after v1', () => {
  it('lists a .slide.md file as Markdown and no longer lists .slide.json files', async () => {
    const workspace = tempDir()
    writeFileSync(join(workspace, 'デッキ.slide.md'), '# 表紙\n')
    writeFileSync(join(workspace, 'deck.slide.json'), '{}\n')
    const store = new FileStore(workspace, join(workspace, '.canvcode'), () => {})
    await store.init()
    cleanups.push(() => store.close())
    expect(store.list().map((f) => ({ kind: f.kind, title: f.title, path: f.path }))).toEqual([{ kind: 'markdown', title: 'デッキ.slide', path: 'デッキ.slide.md' }])
  })
})
