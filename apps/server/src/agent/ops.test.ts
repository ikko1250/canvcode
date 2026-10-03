import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { builtinNodeTypes } from '@canvcode/nodes'
import { RecordStore, type StoredRecord } from '../records.ts'
import { SyncHub } from '../sync.ts'
import { AgentHost } from './host.ts'
import { EditError, editCanvas, undoCanvasEdit, type EditRequest } from './ops.ts'
import { readNodes } from './outline.ts'

// AI の編集（edit_canvas・undo_canvas_edit）と、サーバーの中のワークスペース（host.ts）

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

// 開いているタブの代わり（SyncHub が送ったメッセージを受け取る）
interface FakeSocket {
  readyState: number
  OPEN: number
  sent: Record<string, unknown>[]
  send(text: string): void
}

function fakeSocket(): FakeSocket {
  return {
    readyState: 1,
    OPEN: 1,
    sent: [],
    send(text: string) {
      this.sent.push(JSON.parse(text))
    },
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'canvcode-ops-'))
  const records = new RecordStore(dir)
  const sync = new SyncHub(records)
  const host = new AgentHost({ records, sync })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  cleanups.push(() => records.close())
  cleanups.push(() => host.dispose())
  const tab = fakeSocket()
  ;(sync as unknown as { clients: Set<unknown> }).clients.add(tab)
  const root = records.rootCanvasId
  const edit = (ops: unknown[], extra: Partial<EditRequest> = {}) => editCanvas(host, { canvasId: root, ops, ...extra })
  return { records, sync, host, tab, root, edit }
}

const types = new Map(builtinNodeTypes.map((t) => [t.type, t]))

// 型の既定の props と版を持つノード
function node(id: string, type: string, parentId: string, index: string, props: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): StoredRecord {
  const def = types.get(type)!
  return {
    typeName: 'node',
    id,
    type,
    parentId,
    x: 0,
    y: 0,
    rotation: 0,
    index,
    opacity: 1,
    locked: false,
    props: { ...def.defaultProps(), ...props },
    meta: {},
    ...(def.version > 1 ? { version: def.version } : {}),
    ...extra,
  }
}

function world(records: RecordStore, id: string): { x: number; y: number; w: number; h: number; rotation?: number } {
  return readNodes(records, [id]).nodes[0] as { x: number; y: number; w: number; h: number; rotation?: number }
}

function bindingsOf(records: RecordStore, arrowId: string): StoredRecord[] {
  return records.bindingsFrom([arrowId])
}

describe('edit_canvas', () => {
  it('creates nodes with references and placement, connects them, and saves and broadcasts once', () => {
    const { records, tab, edit, root } = setup()
    const before = records.rev
    const result = edit(
      [
        { op: 'create', type: 'geo', as: 'a', text: '開始', x: 0, y: 0, w: 160, h: 60, fill: '#e8eefc', stroke: 'none' },
        { op: 'create', type: 'geo', as: 'b', text: 'ログイン', place: { rightOf: '$a', gap: 80 }, w: 160, h: 60 },
        { op: 'connect', as: 'e', from: '$a', to: '$b', label: '開く' },
        { op: 'create', type: 'text', text: 'メモ\n2 行目', place: { below: '$b' } },
      ],
      { label: 'ログインの流れ' },
    )
    expect(records.rev).toBe(before + 1)
    expect(result.counts).toEqual({ created: 4, updated: 0, deleted: 0 })
    expect(Object.keys(result.created)).toEqual(['a', 'b', 'e', '#3'])
    const a = records.get(result.created.a!)!
    expect(a).toMatchObject({ parentId: root, x: 0, y: 0, props: { label: '開始', fill: { type: 'solid', color: '#e8eefc', opacity: 1 }, stroke: null } })
    expect(world(records, result.created.b!)).toMatchObject({ x: 240, y: 0, w: 160, h: 60 })
    const text = records.get(result.created['#3']!)!
    expect(text.props).toMatchObject({ autoWidth: false, w: 240 })
    expect(world(records, text.id)).toMatchObject({ x: 240, y: 100 })
    // 矢印は両端のノードにつながり、端はノードの縁で切られる
    const bindings = bindingsOf(records, result.created.e!)
    const ends = Object.fromEntries(bindings.map((b) => [(b.props as { terminal: string }).terminal, b.toId]))
    expect(ends).toEqual({ start: result.created.a, end: result.created.b })
    const arrow = records.get(result.created.e!)!.props as { clip: [number, number]; label: string }
    expect(arrow.label).toBe('開く')
    expect(arrow.clip[0]).toBeGreaterThan(0)
    expect(arrow.clip[1]).toBeLessThan(1)
    // 開いているタブには 1 回で、AI の編集として知らせる
    expect(tab.sent).toHaveLength(1)
    expect(tab.sent[0]).toMatchObject({ type: 'changes', rev: records.rev, deleted: [], origin: { kind: 'ai', batchId: result.batch, label: 'ログインの流れ', canvasId: root } })
    expect((tab.sent[0]!.records as unknown[]).length).toBe(6)
  })

  it('converts world coordinates into rotated and nested frames', () => {
    const { records, edit, root } = setup()
    records.apply(
      [
        node('node:outer', 'frame', root, 'a1', { w: 400, h: 400, name: '外' }, { x: 500, y: 100, rotation: Math.PI / 2 }),
        node('node:inner', 'frame', 'node:outer', 'a1', { w: 200, h: 200, name: '内' }, { x: 50, y: 20, rotation: Math.PI / 6 }),
      ],
      [],
    )
    const result = edit([{ op: 'create', type: 'note', as: 'n', parent: 'node:inner', x: 300, y: 250, w: 80, h: 60, text: '中' }])
    const id = result.created.n!
    expect(records.get(id)!.parentId).toBe('node:inner')
    const w = world(records, id)
    expect(w.x).toBeCloseTo(300)
    expect(w.y).toBeCloseTo(250)
    // 動かしても、指定したワールド座標に置く
    edit([{ op: 'move', ids: [id], x: 320, y: 260 }])
    expect(world(records, id).x).toBeCloseTo(320)
    expect(world(records, id).y).toBeCloseTo(260)
    edit([{ op: 'move', ids: [id], dx: 10, dy: -5 }])
    expect(world(records, id).x).toBeCloseTo(330)
    expect(world(records, id).y).toBeCloseTo(255)
    // 親から出しても、ワールドでの位置は変わらない
    edit([{ op: 'reparent', ids: [id], parent: 'canvas' }])
    expect(records.get(id)!.parentId).toBe(root)
    expect(world(records, id).x).toBeCloseTo(330)
    expect(world(records, id).y).toBeCloseTo(255)
  })

  it('updates props and size, and arrows follow a bound node when it moves', () => {
    const { records, edit } = setup()
    const made = edit([
      { op: 'create', type: 'geo', as: 'a', x: 0, y: 0, w: 100, h: 100 },
      { op: 'create', type: 'geo', as: 'b', x: 400, y: 0, w: 100, h: 100 },
      { op: 'connect', as: 'e', from: '$a', to: '$b' },
    ]).created
    const arrowBefore = records.get(made.e!)!
    edit([
      { op: 'update', id: made.b, text: '新しい', fill: 'none', color: '#ff0000', w: 200 },
      { op: 'move', ids: [made.b], dx: 0, dy: 300 },
    ])
    const b = records.get(made.b!)!
    expect(b.props).toMatchObject({ label: '新しい', fill: null, labelColor: '#ff0000', w: 200, h: 100 })
    const arrowAfter = records.get(made.e!)!
    expect(arrowAfter.props).not.toEqual(arrowBefore.props)
    expect(bindingsOf(records, made.e!)).toHaveLength(2)
    // 矢印の終わりは、動かした先のノードの方を向く
    const end = readNodes(records, [made.e!]).nodes[0]!.end as { x: number; y: number; node: string }
    expect(end.node).toBe(made.b)
    expect(end.y).toBeGreaterThan(250)
  })

  it('refuses style fields the type does not have, and locked nodes', () => {
    const { records, edit, root } = setup()
    records.apply([node('node:t', 'text', root, 'a1', {}, { locked: true })], [])
    expect(() => edit([{ op: 'create', type: 'text', fill: '#ffffff' }])).toThrow(/ops\[0\] \(create\): fill is not supported for text/)
    expect(() => edit([{ op: 'move', ids: ['node:t'], dx: 1 }])).toThrow(/locked/)
    edit([{ op: 'update', id: 'node:t', locked: false, text: 'ok' }])
    expect(records.get('node:t')).toMatchObject({ locked: false })
  })

  it('groups, ungroups, aligns and distributes', () => {
    const { records, edit } = setup()
    const made = edit([
      { op: 'create', type: 'note', as: 'a', x: 0, y: 0, w: 100, h: 100 },
      { op: 'create', type: 'note', as: 'b', x: 200, y: 50, w: 100, h: 100 },
      { op: 'create', type: 'note', as: 'c', x: 500, y: 20, w: 100, h: 100 },
      { op: 'align', ids: ['$a', '$b', '$c'], edge: 'top' },
      { op: 'distribute', ids: ['$a', '$b', '$c'], axis: 'x' },
      { op: 'group', as: 'g', ids: ['$a', '$b'] },
    ]).created
    expect([made.a, made.b, made.c].map((id) => world(records, id!).y)).toEqual([0, 0, 0])
    expect(world(records, made.b!).x).toBe(250)
    expect(records.get(made.a!)!.parentId).toBe(made.g)
    edit([{ op: 'move', ids: [made.g], dx: 10, dy: 10 }])
    expect(world(records, made.b!)).toMatchObject({ x: 260, y: 10 })
    const result = edit([{ op: 'ungroup', ids: [made.g] }])
    expect(result.counts).toEqual({ created: 0, updated: 2, deleted: 1 })
    expect(records.get(made.g!)).toBeUndefined()
    expect(world(records, made.b!)).toMatchObject({ x: 260, y: 10 })
  })

  it('deletes nodes with their bindings and broadcasts the deleted ids', () => {
    const { records, edit, tab } = setup()
    const made = edit([
      { op: 'create', type: 'geo', as: 'a', x: 0, y: 0 },
      { op: 'create', type: 'geo', as: 'b', x: 300, y: 0 },
      { op: 'connect', as: 'e', from: '$a', to: '$b' },
    ]).created
    const bindings = bindingsOf(records, made.e!).map((b) => b.id)
    const result = edit([{ op: 'delete', ids: [made.b] }])
    expect(result.counts).toEqual({ created: 0, updated: 1, deleted: 1 })
    expect(records.get(made.b!)).toBeUndefined()
    // つながっていた矢印は残り、その端のつながりだけが外れる
    expect(bindingsOf(records, made.e!)).toHaveLength(1)
    const message = tab.sent.at(-1)!
    expect(message.deleted).toEqual(expect.arrayContaining([made.b, ...bindings.filter((id) => !records.get(id))]))
  })

  it('sends the document of a deleted card to the trash', () => {
    const { records, edit, root } = setup()
    const now = Date.now()
    const file = { typeName: 'file', id: 'file:md', kind: 'markdown', title: 'メモ', path: 'メモ.md', size: 1, mtime: now, hash: 'h', missing: false, parentCanvasId: null, ownerNodeId: null, createdAt: now, updatedAt: now, deletedAt: null, trash: null }
    records.apply([file], [])
    const made = edit([{ op: 'create', type: 'card', as: 'c', file: 'file:md', x: 0, y: 0 }]).created
    expect(records.get(made.c!)).toMatchObject({ type: 'markdown-card', props: { fileId: 'file:md', role: 'owner' } })
    expect(records.get('file:md')).toMatchObject({ ownerNodeId: made.c, parentCanvasId: root })
    edit([{ op: 'delete', ids: [made.c] }])
    expect(records.get('file:md')!.deletedAt).not.toBeNull()
  })

  it('fails atomically and names the failing op', () => {
    const { records, edit, tab, host } = setup()
    const rev = records.rev
    let message = ''
    try {
      edit([
        { op: 'create', type: 'note', as: 'a', x: 0, y: 0 },
        { op: 'move', ids: ['$a', 'node:nope'], dx: 1 },
      ])
    } catch (error) {
      expect(error).toBeInstanceOf(EditError)
      message = (error as Error).message
    }
    expect(message).toMatch(/^ops\[1\] \(move\): unknown node node:nope/)
    expect(records.rev).toBe(rev)
    expect(tab.sent).toHaveLength(0)
    expect([...host.workspace().store.values()].filter((r) => r.typeName === 'node')).toHaveLength(0)
    expect(() => edit([{ op: 'move', ids: ['$x'], dx: 1 }])).toThrow(/unknown reference \$x/)
    expect(() => edit([{ op: 'spin' }])).toThrow(/unknown op "spin"/)
  })

  it('refuses with if_rev when a node changed after that rev', () => {
    const { records, sync, edit, root } = setup()
    records.apply([node('node:a', 'note', root, 'a1'), node('node:b', 'note', root, 'a2', {}, { x: 300 })], [])
    const read = records.rev
    edit([{ op: 'update', id: 'node:a', text: 'x' }])
    // ブラウザからの保存（SyncHub に届いた push）は、サーバーの中のワークスペースにも当たる
    const browser = fakeSocket()
    ;(sync as unknown as { receive(socket: unknown, text: string): void }).receive(
      browser,
      JSON.stringify({ type: 'push', seq: 1, puts: [{ ...records.get('node:b')!, x: 400 }], deletes: [] }),
    )
    expect(browser.sent.at(-1)).toMatchObject({ type: 'ack', seq: 1 })
    const rev = records.rev
    expect(() => edit([{ op: 'move', ids: ['node:b'], dx: 10 }], { ifRev: read })).toThrow(/Conflict: 1 record\(s\) changed after rev \d+ \(node:b\)/)
    expect(records.rev).toBe(rev)
    edit([{ op: 'move', ids: ['node:b'], dx: 10 }], { ifRev: rev })
    expect(records.get('node:b')!.x).toBe(410)
  })
})

describe('auto placement', () => {
  const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

  it('puts unpositioned nodes in free space near the centre of the user\'s view, stacked', () => {
    const { records, edit, root } = setup()
    // 見ている範囲（0,0 800x600）の中心をふさぐノード
    records.apply([node('node:a', 'note', root, 'a1', { w: 200, h: 200 }, { x: 300, y: 200 })], [])
    const viewport = { x: 0, y: 0, w: 800, h: 600 }
    const result = edit(
      [
        // 先に同じ呼び出しで作ったものも避ける
        { op: 'create', type: 'note', as: 'fixed', x: 150, y: 250, w: 100, h: 100 },
        { op: 'create', type: 'note', as: 'p', w: 100, h: 100 },
        { op: 'create', type: 'note', as: 'q', w: 100, h: 100 },
      ],
      { viewport },
    )
    const p = world(records, result.created.p!)
    const q = world(records, result.created.q!)
    for (const other of [world(records, 'node:a'), world(records, result.created.fixed!)]) expect(overlaps(p, other)).toBe(false)
    // 中心の近く（見ている範囲の中）
    expect(Math.hypot(p.x + 50 - 400, p.y + 50 - 300)).toBeLessThan(250)
    expect(overlaps(p, viewport)).toBe(true)
    // 2 つ目以降は、1 つ目の下に並べる
    expect(q).toMatchObject({ x: p.x, y: p.y + 140 })
  })

  it('places right of the content without a view', () => {
    const { records, edit, root } = setup()
    records.apply([node('node:a', 'note', root, 'a1', { w: 200, h: 200 }, { x: 300, y: 200 })], [])
    const result = edit([{ op: 'create', type: 'note', as: 'p', w: 100, h: 100 }])
    expect(world(records, result.created.p!)).toMatchObject({ x: 580, y: 200 })
  })
})

describe('undo_canvas_edit', () => {
  it('restores the records and broadcasts the undo', () => {
    const { records, host, edit, tab, root } = setup()
    records.apply([node('node:a', 'note', root, 'a1')], [])
    const result = edit([
      { op: 'create', type: 'note', as: 'n', x: 0, y: 300 },
      { op: 'move', ids: ['node:a'], dx: 50, dy: 0 },
    ])
    const undone = undoCanvasEdit(host, result.batch)
    expect(undone.restored).toBe(2)
    expect(records.get(result.created.n!)).toBeUndefined()
    expect(records.get('node:a')!.x).toBe(0)
    expect(tab.sent.at(-1)).toMatchObject({ type: 'changes', deleted: [result.created.n], origin: { kind: 'ai-undo', batchId: result.batch } })
    // サーバーの中のワークスペースにも当たっている
    expect(host.workspace().getNode('node:a')!.x).toBe(0)
    expect(() => undoCanvasEdit(host, result.batch)).toThrow(/already undone/)
    expect(() => undoCanvasEdit(host, 'ai-nope')).toThrow(/Unknown batch/)
  })

  it('refuses when a node changed after the edit', () => {
    const { records, host, edit } = setup()
    const result = edit([{ op: 'create', type: 'note', as: 'n', x: 0, y: 0 }])
    records.apply([{ ...records.get(result.created.n!)!, x: 99 }], [])
    expect(() => undoCanvasEdit(host, result.batch)).toThrow(/Conflict: 1 record\(s\) changed after this edit/)
    expect(records.get(result.created.n!)!.x).toBe(99)
  })

  it('keeps only the latest edits', () => {
    const { records, host, edit } = setup()
    const first = edit([{ op: 'create', type: 'note', x: 0, y: 0 }]).batch
    for (let i = 0; i < 50; i++) edit([{ op: 'create', type: 'note', x: i, y: 0 }])
    expect(records.getAgentOp(first)).toBeUndefined()
    expect(() => undoCanvasEdit(host, first)).toThrow(/Unknown batch/)
  })
})
