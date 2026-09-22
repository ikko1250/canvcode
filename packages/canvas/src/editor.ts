import {
  History,
  Store,
  applyMat,
  boxContains,
  createId,
  indexBetween,
  indicesBetween,
  invert,
  multiply,
  transformOf,
  type Box,
  type Mat,
  type NodeRecord,
  type Transaction,
  type Vec,
} from '@canvcode/core'
import { builtinNodeTypes, type AnyNodeTypeDef } from '@canvcode/nodes'
import { NodeIndex, type IndexEntry } from './nodeIndex.ts'
import { Session } from './session.ts'
import {
  nodeFrame,
  resizeNodes,
  rightAngle,
  rotateNodes,
  selectionFrame,
  type Frame,
  type ResizeTarget,
} from './transform.ts'

// 1 つの Canvas を編集するための入口。ストア・履歴・セッション・索引をまとめ、
// 名前の付いたコマンドを提供する（MAI-11）。ツールや React の UI は、ここを通して変更する。
// 段階 11 までは永続化せず、ブラウザのメモリ内だけで動く。

export interface HistoryMeta {
  selectionBefore: string[]
  selectionAfter?: string[]
}

// 選択しているノードをリサイズ・回転するときの対象（MAI-23）
export interface TransformSelection {
  frame: Frame
  // ワールドでの形にしたノード（x・y・rotation はワールドの値）。変形したら fromWorld で親の座標に戻す
  targets: ResizeTarget[]
  // 1 つだけのときは、その型がリサイズできるか（group は中身を伸ばせるのでできる）。複数のときは、どれか 1 つでもできるか
  canResize: boolean
  canRotate: boolean
  // 斜めに回転したノードや group を含む複数選択は、形が歪まないよう縦横比を保って伸ばす
  forceAspect: boolean
  minSize: { w: number; h: number }
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
    this.store.setHooks({
      // 親を消したら、子孫もまとめて消す（同じトランザクションの中なので、Undo で一緒に戻る）
      afterDelete: (node, tx) => {
        // 子は索引から引く（ストアを全部調べると、1 万ノードを消すときに遅すぎる）
        for (const childId of this.index.childrenOf(node.id)) {
          if (tx.get(childId)?.parentId === node.id) tx.remove(childId)
        }
      },
      // 子がいなくなった group は消す（MAI-25）
      beforeCommit: (patch, tx) => {
        const groups = new Set<string>()
        for (const change of patch.values()) {
          const parentId = change.before?.parentId
          if (parentId && parentId !== change.after?.parentId) groups.add(parentId)
        }
        for (const id of groups) {
          const group = this.store.get(id)
          if (group && this.types.get(group.type)?.container === 'group' && this.childrenInStore(id).length === 0) {
            tx.remove(id)
          }
        }
      },
    })
    this.store.listen((event) => {
      this.index.applyPatch(event.patch)
      // 消えたノードを選択から外す
      const { selectedIds, hoveredId, focusedGroupId } = this.session.get()
      let changed = false
      const next = new Set(selectedIds)
      for (const [id, change] of event.patch) {
        if (change.after) continue
        if (next.delete(id)) changed = true
      }
      const hoverGone = hoveredId !== null && !this.store.has(hoveredId)
      const focusGone = focusedGroupId !== null && !this.store.has(focusedGroupId)
      if (changed || hoverGone || focusGone) {
        this.session.set({
          selectedIds: changed ? next : selectedIds,
          hoveredId: hoverGone ? null : hoveredId,
          focusedGroupId: focusGone ? null : focusedGroupId,
        })
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

  isContainer(node: NodeRecord, kind?: 'group' | 'frame'): boolean {
    const container = this.types.get(node.type)?.container
    return kind ? container === kind : container !== undefined
  }

  // ストアの中で、親が parentId のノード（トランザクションの途中の変更も含む）
  private childrenInStore(parentId: string): NodeRecord[] {
    const out: NodeRecord[] = []
    for (const node of this.store.values()) if (node.parentId === parentId) out.push(node)
    return out
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

  // ---- 座標（MAI-6、MAI-25） ----

  // 親のローカル座標 → ワールド座標の行列
  parentMatrix(parentId: string): Mat {
    return this.index.parentMatrix(parentId)
  }

  // ノードを「ワールドでの形」にする（x・y・rotation をワールドの値にする）。移動・リサイズ・回転はこの形で計算する
  toWorld(node: NodeRecord): NodeRecord {
    if (node.parentId === this.canvasId) return node
    const m = multiply(this.parentMatrix(node.parentId), transformOf(node.x, node.y, node.rotation))
    return { ...node, x: m.e, y: m.f, rotation: Math.atan2(m.b, m.a) }
  }

  // 「ワールドでの形」を、parentId（既定はノードの今の親）のローカル座標に戻す
  fromWorld(node: NodeRecord, parentId = node.parentId): NodeRecord {
    if (parentId === this.canvasId) return { ...node, parentId }
    const m = multiply(invert(this.parentMatrix(parentId)), transformOf(node.x, node.y, node.rotation))
    return { ...node, parentId, x: m.e, y: m.f, rotation: Math.atan2(m.b, m.a) }
  }

  // ワールド座標の点を、parentId のローカル座標にする
  worldToParent(parentId: string, point: Vec): Vec {
    return applyMat(invert(this.parentMatrix(parentId)), point)
  }

  // ---- コマンド ----

  // 新しいノードのレコードを作る（まだストアには入れない）。x・y は親のローカル座標
  makeNode(
    type: string,
    fields: { x: number; y: number; props?: object; index?: string; parentId?: string },
  ): NodeRecord {
    const def = this.types.get(type)
    if (!def) throw new Error(`Unknown node type: ${type}`)
    const parentId = fields.parentId ?? this.canvasId
    return {
      typeName: 'node',
      id: createId('node'),
      type,
      parentId,
      x: fields.x,
      y: fields.y,
      rotation: 0,
      index: fields.index ?? this.nextIndex(parentId),
      opacity: 1,
      locked: false,
      props: { ...def.defaultProps(), ...fields.props },
      meta: {},
    }
  }

  // 親の中で最も手前に置くための重なり順
  nextIndex(parentId = this.canvasId): string {
    return indexBetween(this.index.topmost(parentId)?.index ?? null, null)
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
    const list = [...ids].flatMap((id) => {
      const node = this.store.get(id)
      return node && !node.locked ? [node] : []
    })
    if (list.length === 0) return
    this.transact(label, (tx) => {
      for (const node of list) {
        const world = this.toWorld(node)
        tx.put(this.fromWorld({ ...world, x: world.x + dx, y: world.y + dy }))
      }
    })
  }

  // ノードの親を付け替える（ワールドでの位置と向きは変えない）。親の中では最も手前に置く
  reparent(tx: Transaction<NodeRecord>, ids: string[], parentId: string): void {
    const nodes = ids.flatMap((id) => {
      const node = tx.get(id)
      return node && node.parentId !== parentId && !this.isAncestorOrSelf(id, parentId) ? [node] : []
    })
    if (nodes.length === 0) return
    // 今の重なり順を保ったまま、新しい親の最も手前に並べる
    const ordered = this.index.sortByOrder(nodes.map((n) => n.id))
    const indices = indicesBetween(this.index.topmost(parentId)?.index ?? null, null, ordered.length)
    for (const [i, id] of ordered.entries()) {
      const node = tx.get(id)!
      tx.put({ ...this.fromWorld(this.toWorld(node), parentId), index: indices[i] })
    }
  }

  // a が b 自身か、b の祖先か（ノードを自分の子孫に入れないため）
  isAncestorOrSelf(a: string, b: string): boolean {
    return a === b || this.index.ancestorsOf(b).includes(a)
  }

  // 選んでいるノードを group にまとめる（Ctrl+G）。親が同じものだけをまとめる
  groupSelected(): string | null {
    const selected = [...this.session.get().selectedIds].flatMap((id) => {
      const node = this.store.get(id)
      return node ? [node] : []
    })
    if (selected.length < 2) return null
    const parentId = selected[0].parentId
    const members = this.index.sortByOrder(selected.filter((n) => n.parentId === parentId).map((n) => n.id))
    if (members.length < 2) return null
    const topmost = this.store.get(members.at(-1)!)!
    // group は親の原点に置く（回転なし）。そうすれば、子は座標を変えずにそのまま入れられる
    const group = this.makeNode('group', { x: 0, y: 0, parentId, index: topmost.index })
    this.transact('group', (tx) => {
      // 一番手前の子の index を group に譲るので、その子の index を振り直す
      tx.put(group)
      const indices = indicesBetween(null, null, members.length)
      for (const [i, id] of members.entries()) {
        const node = tx.get(id)!
        tx.put({ ...node, parentId: group.id, index: indices[i] })
      }
      this.setSelection([group.id])
    })
    return group.id
  }

  // 選んでいる group を解除する（Ctrl+Shift+G）。子は、ワールドでの位置を保ったまま group の親に戻す
  ungroupSelected(): void {
    const groups = [...this.session.get().selectedIds].flatMap((id) => {
      const node = this.store.get(id)
      return node && this.isContainer(node, 'group') ? [node] : []
    })
    if (groups.length === 0) return
    const released: string[] = []
    this.transact('ungroup', (tx) => {
      for (const group of groups) {
        const children = this.index.childrenOf(group.id)
        // group があった重なり順の位置に、子を並べる
        const siblings = this.index.childrenOf(group.parentId)
        const at = siblings.indexOf(group.id)
        const before = at > 0 ? this.store.get(siblings[at - 1])!.index : null
        const after = at >= 0 && at < siblings.length - 1 ? this.store.get(siblings[at + 1])!.index : null
        const indices = indicesBetween(before, after, children.length)
        for (const [i, id] of children.entries()) {
          const child = tx.get(id)!
          tx.put({ ...this.fromWorld(this.toWorld(child), group.parentId), index: indices[i] })
          released.push(id)
        }
        tx.remove(group.id)
      }
      this.setSelection(released)
    })
  }

  // ---- 選択 ----

  setSelection(ids: Iterable<string>): void {
    this.session.set({ selectedIds: new Set(ids) })
  }

  // 今の階層（中に入っている group の中、そうでなければ Canvas 直下）のノードをすべて選ぶ
  selectAll(): void {
    const parent = this.session.get().focusedGroupId ?? this.canvasId
    this.setSelection(this.index.childrenOf(parent).filter((id) => !this.store.get(id)?.locked))
  }

  // group の中に入る（ダブルクリック）・出る（Esc）
  focusGroup(groupId: string | null): void {
    this.session.set({ focusedGroupId: groupId })
  }

  // クリックしたノードから、実際に選ぶノードを決める（MAI-12）。
  // group の中のノードは、中に入っていなければ group 全体を選ぶ（入れ子なら、今の階層の直下の group）。
  // フレームの中のノードは、直接選べる
  selectableFor(id: string): string {
    const focus = this.session.get().focusedGroupId
    let target = id
    for (const ancestor of this.index.ancestorsOf(id)) {
      if (ancestor === focus) break
      const node = this.store.get(ancestor)
      if (node && this.isContainer(node, 'group')) target = ancestor
    }
    // 中に入っている group の外のノードをクリックしたら、中から出る
    if (focus && !this.index.ancestorsOf(target).includes(focus)) this.focusGroup(null)
    return target
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

  // ---- リサイズ・回転の対象（MAI-23） ----

  transformSelection(): TransformSelection | null {
    const entries = [...this.session.get().selectedIds].flatMap((id) => {
      const entry = this.index.get(id)
      return entry && !entry.node.locked ? [entry] : []
    })
    const frame = selectionFrame(entries)
    if (!frame) return null
    const targets = entries.map((entry) => {
      const type = this.getType(entry.node)
      return { node: this.toWorld(entry.node), type, frame: nodeFrame(entry) }
    })
    const single = targets.length === 1
    const hasGroup = targets.some((t) => t.type.container === 'group')
    return {
      frame,
      targets,
      canResize: targets.some((t) => t.type.resize || t.type.container === 'group'),
      canRotate: targets.every((t) => t.type.canRotate !== false),
      forceAspect: !single && (hasGroup || targets.some((t) => rightAngle(t.node.rotation) === null)),
      minSize: single ? (targets[0].type.minSize ?? { w: 1, h: 1 }) : { w: 1, h: 1 },
    }
  }

  // 選択枠を newFrame に変えたときの、各ノードの新しいレコード（親のローカル座標）。
  // group は中身を比例させて伸ばす（入れ子の group も、同じように中まで伸ばす）
  resizeSelection(selection: TransformSelection, newFrame: Frame): NodeRecord[] {
    const { frame: oldFrame, targets } = selection
    if (targets.length === 1 && targets[0].type.container === 'group') {
      const entry = this.index.get(targets[0].node.id)!
      // 枠はノードの向きに沿っているので、group のローカル座標で見れば回転していない箱になる
      const origin = applyMat(invert(entry.worldMatrix), { x: newFrame.x, y: newFrame.y })
      return this.resizeChildrenOf(entry.node.id, entry.localBounds, { x: origin.x, y: origin.y, w: newFrame.w, h: newFrame.h })
    }
    const out: NodeRecord[] = []
    const plain = targets.filter((t) => t.type.container !== 'group')
    if (plain.length > 0) {
      const resized = resizeNodes(plain, oldFrame, newFrame, targets.length === 1)
      for (const node of resized) out.push(this.fromWorld(node))
    }
    // 複数選択の中の group（縦横比を保って伸ばしているので、倍率は 1 つ）
    const s = oldFrame.w > 0 ? newFrame.w / oldFrame.w : 1
    for (const target of targets) {
      if (target.type.container !== 'group' || targets.length === 1) continue
      const entry = this.index.get(target.node.id)!
      const moved = { x: newFrame.x + (target.frame.x - oldFrame.x) * s, y: newFrame.y + (target.frame.y - oldFrame.y) * s }
      const origin = applyMat(invert(entry.worldMatrix), moved)
      const lb = entry.localBounds
      out.push(...this.resizeChildrenOf(entry.node.id, lb, { x: origin.x, y: origin.y, w: lb.w * s, h: lb.h * s }))
    }
    return out
  }

  // 親（group）のローカル座標で、箱 oldBox を newBox に伸ばしたときの、子の新しいレコード
  private resizeChildrenOf(parentId: string, oldBox: Box, newBox: Box): NodeRecord[] {
    const sx = oldBox.w > 0 ? newBox.w / oldBox.w : 1
    const sy = oldBox.h > 0 ? newBox.h / oldBox.h : 1
    const out: NodeRecord[] = []
    for (const childId of this.index.childrenOf(parentId)) {
      const entry = this.index.get(childId)
      if (!entry) continue
      const { node, localBounds: lb } = entry
      const type = this.getType(node)
      const m = transformOf(node.x, node.y, node.rotation)
      const origin = applyMat(m, { x: lb.x, y: lb.y })
      const moved = { x: newBox.x + (origin.x - oldBox.x) * sx, y: newBox.y + (origin.y - oldBox.y) * sy }
      const angle = rightAngle(node.rotation)
      const g = Math.sqrt(sx * sy)
      const [kw, kh] = angle === 'straight' ? [sx, sy] : angle === 'turned' ? [sy, sx] : [g, g]
      if (type.container === 'group') {
        // 入れ子の group は、自分の位置はそのままに、中身を伸ばす
        const local = applyMat(invert(m), moved)
        out.push(...this.resizeChildrenOf(childId, lb, { x: local.x, y: local.y, w: lb.w * kw, h: lb.h * kh }))
      } else if (type.resize) {
        const min = type.minSize ?? { w: 1, h: 1 }
        const w = Math.max(lb.w * kw, min.w)
        const h = Math.max(lb.h * kh, min.h)
        out.push({ ...node, x: moved.x, y: moved.y, props: type.resize(node, { w, h }) })
      } else {
        out.push({ ...node, x: moved.x, y: moved.y })
      }
    }
    return out
  }

  // 選択しているノードを pivot のまわりに delta だけ回したときの、新しいレコード（親のローカル座標）
  rotateSelection(selection: TransformSelection, pivot: Vec, delta: number): NodeRecord[] {
    return rotateNodes(
      selection.targets.map((t) => t.node),
      pivot,
      delta,
    ).map((node) => this.fromWorld(node))
  }

  // ---- 当たり判定（MAI-12） ----

  // ワールド座標の点に当たっている、最も手前のノード（group 以外）。marginWorld はワールド座標での余裕
  hitTest(point: Vec, marginWorld: number): NodeRecord | null {
    const zoom = this.session.get().camera.zoom
    const ids = this.index.search({
      x: point.x - marginWorld,
      y: point.y - marginWorld,
      w: marginWorld * 2,
      h: marginWorld * 2,
    })
    // フレームの名前は枠の外にあるので、名前の部分も探す（名前の高さ分、上に広げて探す）
    const labelIds = this.index.search({ x: point.x - marginWorld, y: point.y, w: marginWorld * 2, h: 24 / zoom })
    const ordered = this.index.sortByOrder([...new Set([...ids, ...labelIds])])
    for (let i = ordered.length - 1; i >= 0; i--) {
      const entry = this.index.get(ordered[i])
      if (!entry || entry.node.locked) continue
      // フレームの外にはみ出した子は、見えないので当たらない
      if (this.clippedAway(entry, point)) continue
      const local = applyMat(invert(entry.worldMatrix), point)
      if (this.getType(entry.node).hitTest(entry.node, local, marginWorld, zoom)) return entry.node
    }
    return null
  }

  // ワールド座標の点を含む、最も奥の（入れ子の深い）フレーム。exclude とその子孫は除く
  frameAt(point: Vec, exclude: ReadonlySet<string> = new Set()): string | null {
    const ordered = this.index.sortByOrder(this.index.search({ x: point.x, y: point.y, w: 0, h: 0 }))
    for (let i = ordered.length - 1; i >= 0; i--) {
      const entry = this.index.get(ordered[i])
      if (!entry || !this.isContainer(entry.node, 'frame')) continue
      if ([ordered[i], ...this.index.ancestorsOf(ordered[i])].some((id) => exclude.has(id))) continue
      // group の中のフレームには入れない（group の子を勝手に動かさない）
      if (this.index.ancestorsOf(ordered[i]).some((id) => this.isContainer(this.store.get(id)!, 'group'))) continue
      const local = applyMat(invert(entry.worldMatrix), point)
      if (boxContains(entry.localBounds, local)) return ordered[i]
    }
    return null
  }

  // 祖先のフレームの外にある点か
  private clippedAway(entry: IndexEntry, point: Vec): boolean {
    for (const ancestor of this.index.ancestorsOf(entry.node.id)) {
      const a = this.index.get(ancestor)
      if (!a || !this.isContainer(a.node, 'frame')) continue
      if (!boxContains(a.localBounds, applyMat(invert(a.worldMatrix), point))) return true
    }
    return false
  }

  // 範囲選択：枠に少しでも触れたノードを、今の階層で選べる形にして返す（MAI-25）
  nodesInBrush(box: Box): string[] {
    const out = new Set<string>()
    for (const id of this.index.search(box)) {
      const entry = this.index.get(id)
      if (!entry || entry.node.locked) continue
      // フレームは、枠に丸ごと入ったときだけ選ぶ（フレームの中で範囲選択を始められるように）
      if (this.isContainer(entry.node, 'frame') && !containsBox(box, entry.worldBounds)) continue
      const focus = this.session.get().focusedGroupId
      if (focus && !this.index.ancestorsOf(id).includes(focus)) continue
      let target = id
      for (const ancestor of this.index.ancestorsOf(id)) {
        if (ancestor === focus) break
        const node = this.store.get(ancestor)
        if (node && this.isContainer(node, 'group')) target = ancestor
      }
      out.add(target)
    }
    return [...out]
  }
}

function containsBox(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h
  )
}
