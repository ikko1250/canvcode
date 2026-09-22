import {
  History,
  Store,
  applyMat,
  createId,
  indexBetween,
  invert,
  type NodeRecord,
  type Transaction,
  type Vec,
} from '@canvcode/core'
import { builtinNodeTypes, type AnyNodeTypeDef } from '@canvcode/nodes'
import { NodeIndex } from './nodeIndex.ts'
import { Session } from './session.ts'

// 1 つの Canvas を編集するための入口。ストア・履歴・セッション・索引をまとめ、
// 名前の付いたコマンドを提供する（MAI-11）。ツールや React の UI は、ここを通して変更する。
// 段階 2 では永続化せず、ブラウザのメモリ内だけで動く。

export interface HistoryMeta {
  selectionBefore: string[]
  selectionAfter?: string[]
}

export interface EditorOptions {
  canvasId?: string
  types?: AnyNodeTypeDef[]
}

export class Editor {
  readonly canvasId: string
  readonly store = new Store<NodeRecord>()
  readonly history = new History(this.store)
  readonly session = new Session()
  readonly types: Map<string, AnyNodeTypeDef>
  readonly index: NodeIndex

  constructor(options: EditorOptions = {}) {
    this.canvasId = options.canvasId ?? createId('canvas')
    this.types = new Map((options.types ?? builtinNodeTypes).map((type) => [type.type, type]))
    this.index = new NodeIndex(this.canvasId, this.types)
    this.store.listen((event) => {
      this.index.applyPatch(event.patch)
      // 消えたノードを選択から外す
      const { selectedIds, hoveredId } = this.session.get()
      let changed = false
      const next = new Set(selectedIds)
      for (const [id, change] of event.patch) {
        if (change.after) continue
        if (next.delete(id)) changed = true
      }
      const hoverGone = hoveredId !== null && !this.store.has(hoveredId)
      if (changed || hoverGone) {
        this.session.set({ selectedIds: changed ? next : selectedIds, hoveredId: hoverGone ? null : hoveredId })
      }
    })
  }

  getNode(id: string): NodeRecord | undefined {
    return this.store.get(id)
  }

  getType(node: NodeRecord): AnyNodeTypeDef {
    const type = this.types.get(node.type)
    if (!type) throw new Error(`Unknown node type: ${node.type}`)
    return type
  }

  // ---- トランザクション ----

  // 長く続く操作（ドラッグなど）用。終えるときは finish か cancel を呼ぶ
  begin(label: string): Transaction<NodeRecord> {
    const meta: HistoryMeta = { selectionBefore: [...this.session.get().selectedIds] }
    return this.store.begin(label, { scope: this.canvasId, meta })
  }

  finish(tx: Transaction<NodeRecord>): void {
    const meta = tx.options.meta as HistoryMeta | undefined
    tx.commit()
    if (meta) meta.selectionAfter = [...this.session.get().selectedIds]
  }

  transact<T>(label: string, fn: (tx: Transaction<NodeRecord>) => T): T {
    const tx = this.begin(label)
    try {
      const result = fn(tx)
      this.finish(tx)
      return result
    } catch (error) {
      if (!tx.isDone) tx.cancel()
      throw error
    }
  }

  // ---- コマンド ----

  // 新しいノードのレコードを作る（まだストアには入れない）
  makeNode(type: string, fields: { x: number; y: number; props?: object; index?: string }): NodeRecord {
    const def = this.types.get(type)
    if (!def) throw new Error(`Unknown node type: ${type}`)
    return {
      typeName: 'node',
      id: createId('node'),
      type,
      parentId: this.canvasId,
      x: fields.x,
      y: fields.y,
      rotation: 0,
      index: fields.index ?? this.nextIndex(),
      opacity: 1,
      locked: false,
      props: { ...def.defaultProps(), ...fields.props },
      meta: {},
    }
  }

  // 最も手前に置くための重なり順
  nextIndex(): string {
    return indexBetween(this.index.topmost()?.index ?? null, null)
  }

  createNodes(nodes: NodeRecord[], label = 'create'): void {
    this.transact(label, (tx) => {
      for (const node of nodes) tx.put(node)
    })
  }

  deleteNodes(ids: Iterable<string>): void {
    const list = [...ids].filter((id) => this.store.has(id))
    if (list.length === 0) return
    this.transact('delete', (tx) => {
      for (const id of list) tx.remove(id)
    })
  }

  deleteSelected(): void {
    this.deleteNodes(this.session.get().selectedIds)
  }

  moveNodes(ids: Iterable<string>, dx: number, dy: number, label = 'move'): void {
    const list = [...ids].filter((id) => {
      const node = this.store.get(id)
      return node && !node.locked
    })
    if (list.length === 0) return
    this.transact(label, (tx) => {
      for (const id of list) tx.update(id, (node) => ({ ...node, x: node.x + dx, y: node.y + dy }))
    })
  }

  // ---- 選択 ----

  setSelection(ids: Iterable<string>): void {
    this.session.set({ selectedIds: new Set(ids) })
  }

  selectAll(): void {
    this.setSelection(this.index.allIds().filter((id) => !this.store.get(id)?.locked))
  }

  // ---- Undo / Redo（Canvas ごと） ----

  undo(): boolean {
    const result = this.history.undo(this.canvasId)
    if (!result.ok) return false
    const meta = result.entry.meta as HistoryMeta | undefined
    if (meta) this.setSelection(meta.selectionBefore.filter((id) => this.store.has(id)))
    return true
  }

  redo(): boolean {
    const result = this.history.redo(this.canvasId)
    if (!result.ok) return false
    const meta = result.entry.meta as HistoryMeta | undefined
    if (meta?.selectionAfter) this.setSelection(meta.selectionAfter.filter((id) => this.store.has(id)))
    return true
  }

  // ---- 当たり判定（MAI-12） ----

  // ワールド座標の点に当たっている、最も手前のノード。marginWorld はワールド座標での余裕
  hitTest(point: Vec, marginWorld: number): NodeRecord | null {
    const ids = this.index.search({
      x: point.x - marginWorld,
      y: point.y - marginWorld,
      w: marginWorld * 2,
      h: marginWorld * 2,
    })
    const ordered = this.index.sortByOrder(ids)
    for (let i = ordered.length - 1; i >= 0; i--) {
      const entry = this.index.get(ordered[i])
      if (!entry || entry.node.locked) continue
      const local = applyMat(invert(entry.worldMatrix), point)
      if (this.getType(entry.node).hitTest(entry.node, local, marginWorld)) return entry.node
    }
    return null
  }
}
