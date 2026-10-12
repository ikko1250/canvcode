import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { builtinNodeTypes, richTextFromPlain } from '@canvcode/nodes'
import { canvasSlideLayout } from '@canvcode/slides'
import { Editor } from '@canvcode/canvas/editor'
import { RecordStore, type StoredRecord } from '../records.ts'
import { SyncHub } from '../sync.ts'
import { AgentHost } from './host.ts'
import { EditError, editCanvas, undoCanvasEdit, type EditRequest } from './ops.ts'
import { readCanvas, readNodes } from './outline.ts'

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

  it('sets the dash, width and heads of an arrow (a plain line without heads), and the dash of a shape', () => {
    const { records, edit } = setup()
    const made = edit([
      { op: 'create', type: 'geo', as: 'a', x: 0, y: 0, w: 100, h: 100, dash: 'dotted' },
      { op: 'connect', as: 'e', from: '$a', to: { x: 400, y: 50 }, dash: 'dashed', heads: 'none' },
      { op: 'connect', as: 'f', from: '$a', to: { x: 400, y: 300 } },
    ]).created
    expect(records.get(made.a!)!.props).toMatchObject({ strokeDash: 'dotted' })
    expect(records.get(made.e!)!.props).toMatchObject({ strokeDash: 'dashed', arrowheadStart: 'none', arrowheadEnd: 'none' })
    // 実線は書かない（未指定 = 実線）
    expect(records.get(made.f!)!.props).not.toHaveProperty('strokeDash')
    expect(readNodes(records, [made.e!]).nodes[0]).toMatchObject({ strokeDash: 'dashed', arrowheadStart: 'none', arrowheadEnd: 'none' })
    expect(readNodes(records, [made.f!]).nodes[0]).not.toHaveProperty('strokeDash')

    edit([{ op: 'update', id: made.e, dash: 'dotted', strokeWidth: 5, heads: 'start' }])
    expect(records.get(made.e!)!.props).toMatchObject({ strokeDash: 'dotted', size: 5, arrowheadStart: 'arrow', arrowheadEnd: 'none' })
    edit([{ op: 'update', id: made.e, dash: 'solid', heads: 'both' }])
    expect(records.get(made.e!)!.props).toMatchObject({ strokeDash: 'solid', arrowheadStart: 'arrow', arrowheadEnd: 'arrow' })
    expect(() => edit([{ op: 'update', id: made.e, dash: 'wavy' }])).toThrow(/dash/)
    expect(() => edit([{ op: 'update', id: made.a, heads: 'both' }])).toThrow(/heads is not supported for geo/)
  })

  it('refuses style fields the type does not have, and locked nodes', () => {
    const { records, edit, root } = setup()
    records.apply([node('node:t', 'text', root, 'a1', {}, { locked: true })], [])
    expect(() => edit([{ op: 'create', type: 'text', fill: '#ffffff' }])).toThrow(/ops\[0\] \(create\): fill is not supported for text/)
    expect(() => edit([{ op: 'move', ids: ['node:t'], dx: 1 }])).toThrow(/locked/)
    edit([{ op: 'update', id: 'node:t', locked: false, text: 'ok' }])
    expect(records.get('node:t')).toMatchObject({ locked: false })
  })

  it('crops an image (keeping its width) and the image fill of a shape, and shows the crop in read_nodes', () => {
    const { records, edit, root } = setup()
    records.apply(
      [
        node('node:img', 'image', root, 'a1', { assetId: 'asset:a', w: 200, h: 100 }),
        node('node:frame', 'geo', root, 'a2', { w: 300, h: 200, fill: { type: 'image', assetId: 'asset:a', scaleMode: 'fill', crop: { x: 0, y: 0, w: 1, h: 1 }, tileScale: 1, opacity: 1 } }),
        node('node:plain', 'geo', root, 'a3'),
      ],
      [],
    )
    // 左半分だけ：200×100 の画像の左半分は 100×100 なので、幅 200 なら高さ 200
    edit([{ op: 'update', id: 'node:img', crop: { x: 0, y: 0, w: 0.5, h: 1 } }])
    expect(records.get('node:img')!.props).toMatchObject({ w: 200, h: 200, crop: { x: 0, y: 0, w: 0.5, h: 1 } })
    expect(readNodes(records, ['node:img']).nodes[0]).toMatchObject({ crop: { x: 0, y: 0, w: 0.5, h: 1 } })
    edit([{ op: 'update', id: 'node:img', crop: null }])
    expect(records.get('node:img')!.props).toMatchObject({ w: 200, h: 100, crop: null })

    edit([{ op: 'update', id: 'node:frame', crop: { x: 0.25, y: 0, w: 0.5, h: 1 } }])
    expect(records.get('node:frame')!.props).toMatchObject({ w: 300, h: 200, fill: { scaleMode: 'crop', crop: { x: 0.25, y: 0, w: 0.5, h: 1 } } })
    expect(readNodes(records, ['node:frame']).nodes[0]).toMatchObject({ fill: 'image', scaleMode: 'crop', crop: { x: 0.25, w: 0.5 } })
    edit([{ op: 'update', id: 'node:frame', crop: null }])
    expect(records.get('node:frame')!.props).toMatchObject({ fill: { scaleMode: 'fill' } })

    expect(() => edit([{ op: 'update', id: 'node:plain', crop: { x: 0, y: 0, w: 1, h: 1 } }])).toThrow(/crop is only for an image/)
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

// スライド（スライド v2）：テンプレートと行は画面と同じ Editor の関数で作り、commit の直前に slide-layout の子を並べ直す
describe('edit_canvas slides', () => {
  type Slots = { title?: string; panel?: string; rows: { label?: string; body: string; h?: number }[] }
  const layoutOf = (records: RecordStore, slideId: string) => records.childrenOf(slideId).find((r) => r.type === 'slide-layout')!
  const slotsOf = (records: RecordStore, slideId: string) => (layoutOf(records, slideId).props as { slots: Slots }).slots
  // 行のセルのワールドの箱が、v1 の幾何（canvasSlideLayout）の rowCount 行のときの箱をスライドの位置だけずらしたものか
  const expectRows = (records: RecordStore, slideId: string, kind: 'bullets' | 'table', ratio: '16:9' | '4:3', origin: { x: number; y: number }) => {
    const rows = slotsOf(records, slideId).rows
    const boxes = canvasSlideLayout(kind, rows.length, ratio).rows
    for (const [i, row] of rows.entries()) {
      for (const role of ['label', 'body'] as const) {
        const box = boxes[i]![role]
        if (!row[role] || !box) continue
        expect(world(records, row[role]!)).toMatchObject({ x: origin.x + box.x, y: origin.y + box.y, w: box.w, h: box.h })
      }
    }
  }

  it('places a slide with a template like the editor, and lays the rows out again when a row is added', () => {
    const { records, edit } = setup()
    const result = edit([
      { op: 'create', type: 'slide', as: 's', x: 100, y: 200, name: '比較', template: 'table' },
      { op: 'add_row', slide: '$s', text: '四', label: '見出し 4', as: 'r' },
    ])
    const slideId = result.created.s!
    expect(records.get(slideId)).toMatchObject({ x: 100, y: 200, props: { ratio: '16:9', name: '比較', hidden: false } })
    const slots = slotsOf(records, slideId)
    expect(slots.rows).toHaveLength(4)
    expect(slots.rows[3]).toEqual({ label: result.created['r:label'], body: result.created.r })
    expect(records.get(result.created.r!)!.props).toMatchObject({ label: '四' })
    expect(records.get(result.created['r:label']!)!.props).toMatchObject({ label: '見出し 4' })
    // 4 行の幾何どおりに並ぶ（足した行だけでなく、もとの 3 行も詰め直す）
    expectRows(records, slideId, 'table', '16:9', { x: 100, y: 200 })

    // 画面の applySlideTemplate と同じ子（型・props・位置）を作る
    const editor = new Editor({ canvasId: 'canvas:client' })
    const clientSlide = editor.createSlide({ x: 960, y: 540 }, '16:9')
    editor.applySlideTemplate(clientSlide, 'table')
    const shape = (nodes: { type: string; x: number; y: number; props: unknown }[]) =>
      nodes.map((n) => ({ type: n.type, x: n.x, y: n.y, props: JSON.stringify(n.props).replace(/node:[\w-]+/g, 'id') }))
    const clientLayout = editor.index.childrenOf(clientSlide).map((id) => editor.getNode(id)!)[0]!
    const clientChildren = editor.index.childrenOf(clientLayout.id).map((id) => editor.getNode(id)!)
    const serverLayout = layoutOf(records, slideId)
    const serverChildren = records
      .childrenOf(serverLayout.id)
      .filter((r) => r.id !== result.created.r && r.id !== result.created['r:label'])
      .sort((a, b) => (String(a.index) < String(b.index) ? -1 : 1)) as unknown as { type: string; x: number; y: number; props: unknown }[]
    // 行を足す前の 3 行の形と比べるため、画面でも同じ行を足す
    editor.setSelection([clientSlide])
    editor.addSlideLayoutRow()
    const clientAfter = editor.index.childrenOf(clientLayout.id).map((id) => editor.getNode(id)!).filter((n) => clientChildren.some((c) => c.id === n.id))
    // パネル・タイトル・3 行の見出しと本文
    expect(serverChildren).toHaveLength(8)
    expect(shape(serverChildren)).toEqual(shape(clientAfter))
  })

  it('closes the rows up when a row body is deleted, and undoes the edits', () => {
    const { records, host, edit } = setup()
    const created = edit([{ op: 'create', type: 'slide', as: 's', x: 0, y: 0, template: 'table' }])
    const slideId = created.created.s!
    const added = edit([{ op: 'add_row', after: slotsOf(records, slideId).rows[0]!.body, text: '二番目' }])
    const rows = slotsOf(records, slideId).rows
    expect(rows[1]!.body).toBe(added.created['#0'])
    expectRows(records, slideId, 'table', '16:9', { x: 0, y: 0 })
    const positions = () => slotsOf(records, slideId).rows.map((row) => records.get(row.body)!.y)

    // 本文を消すと、その行の見出しも消えて 3 行に詰まる
    const removed = rows[2]!
    const deleted = edit([{ op: 'delete', ids: [removed.body] }])
    expect(slotsOf(records, slideId).rows).toEqual(rows.filter((row) => row !== removed))
    expect(records.get(removed.label!)).toBeUndefined()
    expectRows(records, slideId, 'table', '16:9', { x: 0, y: 0 })
    const threeRows = positions()

    // Undo で 4 行に戻る（並べ直した位置も戻る）
    undoCanvasEdit(host, deleted.batch)
    expect(slotsOf(records, slideId).rows).toEqual(rows)
    expect(records.get(removed.label!)).toBeDefined()
    expectRows(records, slideId, 'table', '16:9', { x: 0, y: 0 })
    expect(positions()).not.toEqual(threeRows)
    undoCanvasEdit(host, added.batch)
    expect(slotsOf(records, slideId).rows).toHaveLength(3)
    expectRows(records, slideId, 'table', '16:9', { x: 0, y: 0 })
    undoCanvasEdit(host, created.batch)
    expect(records.get(slideId)).toBeUndefined()
    expect(readCanvas(records, {}).split('\n')).toHaveLength(1)
  })

  it('changes the ratio, hidden and cell text, and numbers the slides in read_canvas', () => {
    const { records, edit } = setup()
    const made = edit([
      { op: 'create', type: 'slide', as: 'a', x: 0, y: 0, template: 'bullets' },
      { op: 'create', type: 'slide', as: 'b', x: 2000, y: 0 },
      { op: 'create', type: 'slide', as: 'c', x: 4000, y: 0, hidden: true },
    ]).created
    const body = slotsOf(records, made.a!).rows[0]!.body
    // セルの位置を書いても、並べ直しで決まる
    edit([
      { op: 'update', id: made.a!, ratio: '4:3', name: '要点' },
      { op: 'update', id: body, text: '最初の項目', x: 900, y: 900 },
      { op: 'update', id: made.b!, hidden: true },
      { op: 'update', id: made.c!, hidden: false },
    ])
    expect(layoutOf(records, made.a!).props).toMatchObject({ w: 1440, h: 1080 })
    expect(records.get(body)!.props).toMatchObject({ label: '最初の項目' })
    expectRows(records, made.a!, 'bullets', '4:3', { x: 0, y: 0 })
    const lines = readCanvas(records, {}).split('\n').slice(1)
    expect(lines).toEqual([
      `${made.a} slide 0,0 1440x1080 n=1 "要点" [1 children]`,
      `${made.b} slide 2000,0 1920x1080 hidden`,
      `${made.c} slide 4000,0 1920x1080 n=2`,
    ])
  })

  it('places a table-images slide with one row and two figure frames', () => {
    const { records, edit } = setup()
    const slideId = edit([{ op: 'create', type: 'slide', as: 's', x: 0, y: 0, template: 'table-images' }]).created.s!
    const slots = slotsOf(records, slideId) as Slots & { figure: string; figure2: string }
    expect(slots.rows).toHaveLength(1)
    const boxes = canvasSlideLayout('table-images', 1)
    expect(world(records, slots.figure)).toMatchObject(boxes.figure!)
    expect(world(records, slots.figure2)).toMatchObject(boxes.figure2!)
    expect(world(records, slots.rows[0]!.body)).toMatchObject(boxes.rows[0]!.body)
  })

  it('moves the table and the figure and widens the table with adjust', () => {
    const { records, edit } = setup()
    const made = edit([{ op: 'create', type: 'slide', as: 's', x: 0, y: 0, template: 'table-image' }]).created
    const slideId = made.s!
    const slots = slotsOf(records, slideId) as Slots & { panel: string; figure: string }
    edit([{ op: 'update', id: slots.rows[0]!.body, adjust: { table: { dy: -60, w: 800 }, figure: { dx: 10 } } }])
    expect((layoutOf(records, slideId).props as { adjust: unknown }).adjust).toEqual({ table: { dy: -60, w: 800 }, figure: { dx: 10 } })
    const boxes = canvasSlideLayout('table-image', 3, '16:9', { tableWidth: 800, tableOffset: { dx: 0, dy: -60 }, figureOffset: { dx: 10, dy: 0 } })
    expect(world(records, slots.panel)).toMatchObject(boxes.panel)
    expect(world(records, slots.figure)).toMatchObject(boxes.figure!)
    expect(readNodes(records, [layoutOf(records, slideId).id]).nodes[0]).toMatchObject({ adjust: { table: { dy: -60, w: 800 } } })
    // null は既定に戻す
    edit([{ op: 'update', id: slideId, adjust: { table: { w: null }, figure: { dx: null } } }])
    expect((layoutOf(records, slideId).props as { adjust: unknown }).adjust).toEqual({ table: { dy: -60 } })
    // 表紙・全幅の表には使えない値
    const other = edit([
      { op: 'create', type: 'slide', as: 't', x: 3000, y: 0, template: 'title' },
      { op: 'create', type: 'slide', as: 'b', x: 6000, y: 0, template: 'table' },
    ]).created
    expect(() => edit([{ op: 'update', id: other.t!, adjust: { table: { dy: 10 } } }])).toThrow(/not for the title template/)
    expect(() => edit([{ op: 'update', id: other.b!, adjust: { table: { w: 900 } } }])).toThrow(/only for the table-image template/)
    expect(() => edit([{ op: 'update', id: made.s!, adjust: { table: { z: 1 } } }])).toThrow()
  })

  it('fixes the height of the table panel with adjust, keeping its top unless dy is given', () => {
    const { records, edit } = setup()
    const slideId = edit([{ op: 'create', type: 'slide', as: 's', x: 0, y: 0, template: 'table-image' }]).created.s!
    const slots = slotsOf(records, slideId) as Slots & { panel: string }
    const top = world(records, slots.panel).y
    edit([{ op: 'update', id: slideId, adjust: { table: { h: 500 } } }])
    expect((layoutOf(records, slideId).props as { adjust: unknown }).adjust).toEqual({ table: { h: 500, dy: top - 197 } })
    expect(world(records, slots.panel)).toMatchObject({ y: top, h: 500 })
    // 行は高さを決めたパネルの中に収まる（一律の行の高さは v1 と同じく 1px に丸めるので、1px までの差は許す）
    const last = world(records, slots.rows[slots.rows.length - 1]!.body)
    expect(last.y + last.h).toBeLessThanOrEqual(top + 500 - 40 + 1)
    // dy を指定すれば、その位置（197 + dy）。範囲の外は収める
    edit([{ op: 'update', id: slideId, adjust: { table: { h: 99999, dy: 0 } } }])
    expect(world(records, slots.panel)).toMatchObject({ y: 197, h: 883 })
    // null は高さを内容から決める（行数と文字）に戻す
    edit([{ op: 'update', id: slideId, adjust: { table: { h: null, dy: null } } }])
    expect((layoutOf(records, slideId).props as { adjust: unknown }).adjust).toEqual({})
    expect(world(records, slots.panel)).toMatchObject({ y: top })
  })

  it('refuses slide ops that do not fit', () => {
    const { records, edit } = setup()
    const made = edit([
      { op: 'create', type: 'slide', as: 's', x: 0, y: 0, template: 'title' },
      { op: 'create', type: 'slide', as: 'b', x: 2000, y: 0, template: 'bullets' },
    ]).created
    const rev = records.rev
    expect(() => edit([{ op: 'update', id: made.s!, template: 'table' }])).toThrow(/already has contents/)
    expect(() => edit([{ op: 'add_row', slide: made.s! }])).toThrow(/a title slide has no rows/)
    expect(() => edit([{ op: 'add_row', slide: made.b!, label: 'x' }])).toThrow(/no row labels/)
    expect(() => edit([{ op: 'add_row', slide: made.b!, after: made.b! }])).toThrow(/exactly one of slide, after/)
    expect(() => edit([{ op: 'create', type: 'slide', w: 100 }])).toThrow(/w is not supported for slide/)
    expect(() => edit([{ op: 'create', type: 'note', template: 'title' }])).toThrow(/template is only for slides/)
    expect(() => edit([{ op: 'update', id: made.s!, w: 100 }])).toThrow(/slide cannot be resized/)
    expect(() => edit(Array.from({ length: 10 }, () => ({ op: 'add_row', slide: made.b! })))).toThrow(/ops\[\d\] \(add_row\): a bullets slide has at most \d+ rows/)
    expect(records.rev).toBe(rev)
  })

  it('sizes the rows by their text like the editor, and keeps a row height the AI writes on a cell', () => {
    const { records, edit } = setup()
    const made = edit([
      { op: 'create', type: 'slide', as: 's', x: 0, y: 0, template: 'table' },
      { op: 'add_row', slide: '$s' },
    ]).created
    const long = Array.from({ length: 5 }, (_, i) => `行${i}`).join('\n')
    edit([{ op: 'update', id: slotsOf(records, made.s!).rows[1]!.body, text: long }])
    const heights = () => slotsOf(records, made.s!).rows.map((row) => (records.get(row.body)!.props as { h: number }).h)

    // 画面で同じ操作をしたときと同じ高さ（文字の多い行が高くなる）
    const editor = new Editor({ canvasId: 'canvas:client' })
    const slide = editor.createSlide({ x: 960, y: 540 }, '16:9')
    editor.applySlideTemplate(slide, 'table')
    const layout = editor.index.childrenOf(slide).map((id) => editor.getNode(id)!)[0]!
    const clientRows = () => (editor.getNode(layout.id)!.props as { slots: Slots }).slots.rows
    editor.setSelection([clientRows()[2]!.body])
    editor.addSlideLayoutRow()
    editor.transact('edit', (tx) => {
      const cell = editor.getNode(clientRows()[1]!.body)!
      tx.put({ ...cell, props: { ...cell.props, label: long, labelParagraphs: richTextFromPlain(long) } })
    })
    const clientHeights = clientRows().map((row) => (editor.getNode(row.body)!.props as { h: number }).h)
    expect(heights()).toEqual(clientHeights)
    expect(heights()[1]).toBeGreaterThan(canvasSlideLayout('table', 4).rowPx)

    // セルの高さを書くと（上端はそのまま）、その行の高さを手で決めたことになる
    edit([{ op: 'update', id: slotsOf(records, made.s!).rows[2]!.body, h: 250 }])
    expect(slotsOf(records, made.s!).rows.map((row) => row.h)).toEqual([undefined, undefined, 250, undefined])
    expect(heights()[2]).toBe(250)
  })

  it('warns about a slide whose text overflows', () => {
    const { records, edit } = setup()
    const made = edit([{ op: 'create', type: 'slide', as: 's', x: 0, y: 0, template: 'bullets' }]).created
    const body = slotsOf(records, made.s!).rows[0]!.body
    const result = edit([{ op: 'update', id: body, text: 'とても長い本文。'.repeat(80) }])
    expect(result.warnings).toEqual([`slide ${made.s} overflows: text does not fit in ${body}`])
    expect(readCanvas(records, {})).toContain(`${made.s} slide 0,0 1920x1080 n=1 overflow`)
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
