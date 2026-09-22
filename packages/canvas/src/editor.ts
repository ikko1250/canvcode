import {
  applyMat,
  boxContains,
  createId,
  indexBetween,
  indicesBetween,
  invert,
  isNodeRecord,
  multiply,
  transformOf,
  unionBoxes,
  type BindingRecord,
  type Box,
  type WorkspaceRecord,
  type Change,
  type Mat,
  type NodeRecord,
  type Patch,
  type Transaction,
  type Vec,
} from '@canvcode/core'
import {
  PDF_POINT_SCALE,
  PORTAL_DEFAULT_SIZE,
  QUOTE_CARD_DEFAULT_WIDTH,
  type AnyNodeTypeDef,
  type PdfPageProps,
  type QuoteCardProps,
} from '@canvcode/nodes'
import { unbind } from './bindings.ts'
import { NodeIndex, type IndexEntry } from './nodeIndex.ts'
import type { QuoteDraft } from './quotes.ts'
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
import { Workspace, type HistoryMeta, type OwnerPortalDeletion } from './workspace.ts'

// 1 つの Canvas を編集するための入口（MAI-11）。ストアと履歴はワークスペース（Workspace）が持ち、
// Editor はその Canvas のセッション（カメラ・選択など）と空間の索引を持って、名前の付いたコマンドを提供する。
// ツールや React の UI は、ここを通して変更する。Undo はこの Canvas の操作だけを取り消す。

// トランザクションの中での、今のノード（Binding は除く）
export function nodeIn(tx: Transaction<WorkspaceRecord>, id: string): NodeRecord | undefined {
  const record = tx.get(id)
  return isNodeRecord(record) ? record : undefined
}

export type { HistoryMeta } from './workspace.ts'

// PDF のページの並べ方（MAI-32：横 4 枚ずつの格子）
const PDF_COLUMNS = 4
const PDF_PAGE_GAP = 40

// 引用ノートを出典の横に置くときの間隔（MAI-33）
const QUOTE_GAP = 24

// 子キャンバスに移したノードを、移す先にすでにあるものの右に置くときの間隔（MAI-38）
const MOVE_TO_CANVAS_GAP = 80

// File の種類ごとの、カードの型（MAI-7）
const FILE_CARD_TYPES: Record<string, string> = { markdown: 'markdown-card', code: 'code-card' }

// 選択しているノードをリサイズ・回転するときの対象（MAI-23）
export interface TransformSelection {
  frame: Frame
  // ワールドでの形にしたノード（x・y・rotation はワールドの値）。変形したら fromWorld で親の座標に戻す
  targets: ResizeTarget[]
  // 1 つだけのときは、その型がリサイズできるか（group は中身を伸ばせるのでできる）。複数のときは、どれか 1 つでもできるか
  canResize: boolean
  canRotate: boolean
  // 斜めに回転したノードや group を含む複数選択と、縦横比を保つ型（画像）は、縦横比を保って伸ばす
  forceAspect: boolean
  minSize: { w: number; h: number }
}

export interface EditorOptions {
  // 渡さなければ、この Canvas をルートにしたワークスペースを作る（テストや、1 枚だけ使うとき）
  workspace?: Workspace
  canvasId?: string
  types?: AnyNodeTypeDef[]
}

export class Editor {
  readonly workspace: Workspace
  readonly canvasId: string
  readonly session = new Session()
  readonly index: NodeIndex
  private readonly unlisten: () => void

  constructor(options: EditorOptions = {}) {
    this.workspace = options.workspace ?? new Workspace({ rootCanvasId: options.canvasId, types: options.types })
    this.canvasId = options.canvasId ?? this.workspace.rootCanvasId
    this.index = new NodeIndex(this.canvasId, this.types)
    const nodes: NodeRecord[] = []
    for (const record of this.store.values()) if (isNodeRecord(record)) nodes.push(record)
    this.index.load(nodes)
    this.unlisten = this.store.listen((event) => {
      const nodes: Patch<NodeRecord> = new Map()
      for (const [id, change] of event.patch) {
        if (isNodeRecord(change.before) || isNodeRecord(change.after)) nodes.set(id, change as Change<NodeRecord>)
      }
      if (nodes.size > 0) this.index.applyPatch(nodes)
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

  // 使い終わったら呼ぶ（ストアの購読をやめる）
  dispose(): void {
    this.unlisten()
  }

  get store() {
    return this.workspace.store
  }

  get history() {
    return this.workspace.history
  }

  get types(): Map<string, AnyNodeTypeDef> {
    return this.workspace.types
  }

  get bindings() {
    return this.workspace.bindings
  }

  getNode(id: string): NodeRecord | undefined {
    return this.workspace.getNode(id)
  }

  getType(node: NodeRecord): AnyNodeTypeDef {
    return this.workspace.getType(node)
  }

  isContainer(node: NodeRecord, kind?: 'group' | 'frame'): boolean {
    const container = this.types.get(node.type)?.container
    return kind ? container === kind : container !== undefined
  }

  // ---- 矢印とつながり（MAI-28） ----

  getBinding(id: string): BindingRecord | undefined {
    return this.workspace.getBinding(id)
  }

  // 矢印の端の Binding
  bindingsOfArrow(arrowId: string): BindingRecord[] {
    return this.workspace.bindingsOfArrow(arrowId)
  }

  // 動かすノードに含まれる矢印のうち、つながっている先が一緒に動かないものは、つながりを外す（tldraw と同じ）
  detachArrows(tx: Transaction<WorkspaceRecord>, ids: Iterable<string>): void {
    if (this.bindings.isEmpty) return
    const moving = new Set<string>()
    for (const id of ids) {
      moving.add(id)
      for (const child of this.index.descendantsOf(id)) moving.add(child)
    }
    for (const id of moving) {
      for (const binding of this.bindingsOfArrow(id)) {
        const follows = moving.has(binding.toId) || this.index.ancestorsOf(binding.toId).some((a) => moving.has(a))
        if (!follows) unbind(tx, binding)
      }
    }
  }

  // ---- トランザクション ----

  // 長く続く操作（ドラッグなど）用。終えるときは finish か cancel を呼ぶ。履歴はこの Canvas に入る
  begin(label: string, extra: Partial<HistoryMeta> = {}): Transaction<WorkspaceRecord> {
    const meta: HistoryMeta = { selectionBefore: [...this.session.get().selectedIds], ...extra }
    return this.store.begin(label, { scope: this.canvasId, meta })
  }

  finish(tx: Transaction<WorkspaceRecord>): void {
    const meta = tx.options.meta as HistoryMeta | undefined
    tx.commit()
    if (meta) meta.selectionAfter = [...this.session.get().selectedIds]
  }

  transact<T>(label: string, fn: (tx: Transaction<WorkspaceRecord>) => T, extra: Partial<HistoryMeta> = {}): T {
    const tx = this.begin(label, extra)
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

  // ownerPortals：消すものに持ち主の Portal が含まれるとき、参照先をゴミ箱に送るか、未配置にするか（MAI-8）
  deleteNodes(ids: Iterable<string>, options: { ownerPortals?: OwnerPortalDeletion; label?: string } = {}): void {
    const list = [...ids].filter((id) => this.store.has(id))
    if (list.length === 0) return
    this.transact(
      options.label ?? 'delete',
      (tx) => {
        for (const id of list) tx.remove(id)
      },
      { ownerPortalDeletion: options.ownerPortals },
    )
  }

  deleteSelected(options: { ownerPortals?: OwnerPortalDeletion } = {}): void {
    this.deleteNodes(this.session.get().selectedIds, options)
  }

  // ids とその子孫に含まれる、持ち主（Portal やカード）とその参照先（消す前に、参照先をどうするか尋ねるため）
  ownersIn(ids: Iterable<string>): { node: NodeRecord; targetId: string }[] {
    const out: { node: NodeRecord; targetId: string }[] = []
    for (const id of ids) {
      for (const nodeId of [id, ...this.index.descendantsOf(id)]) {
        const node = this.getNode(nodeId)
        const ref = node && this.workspace.referenceOf(node)
        if (node && ref?.role === 'owner' && this.workspace.getDocument(ref.targetId)?.ownerNodeId === node.id) {
          out.push({ node, targetId: ref.targetId })
        }
      }
    }
    return out
  }

  moveNodes(ids: Iterable<string>, dx: number, dy: number, label = 'move'): void {
    const list = [...ids].flatMap((id) => {
      const node = this.getNode(id)
      return node && !node.locked ? [node] : []
    })
    if (list.length === 0) return
    this.transact(label, (tx) => {
      this.detachArrows(tx, list.map((n) => n.id))
      for (const node of list) {
        const world = this.toWorld(node)
        tx.put(this.fromWorld({ ...world, x: world.x + dx, y: world.y + dy }))
      }
    })
  }

  // ノードの親を付け替える（ワールドでの位置と向きは変えない）。親の中では最も手前に置く
  reparent(tx: Transaction<WorkspaceRecord>, ids: string[], parentId: string): void {
    const nodes = ids.flatMap((id) => {
      const node = nodeIn(tx, id)
      return node && node.parentId !== parentId && !this.isAncestorOrSelf(id, parentId) ? [node] : []
    })
    if (nodes.length === 0) return
    // 今の重なり順を保ったまま、新しい親の最も手前に並べる
    const ordered = this.index.sortByOrder(nodes.map((n) => n.id))
    const indices = indicesBetween(this.index.topmost(parentId)?.index ?? null, null, ordered.length)
    for (const [i, id] of ordered.entries()) {
      const node = nodeIn(tx, id)!
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
      const node = this.getNode(id)
      return node ? [node] : []
    })
    if (selected.length < 2) return null
    const parentId = selected[0].parentId
    const members = this.index.sortByOrder(selected.filter((n) => n.parentId === parentId).map((n) => n.id))
    if (members.length < 2) return null
    const topmost = this.getNode(members.at(-1)!)!
    // group は親の原点に置く（回転なし）。そうすれば、子は座標を変えずにそのまま入れられる
    const group = this.makeNode('group', { x: 0, y: 0, parentId, index: topmost.index })
    this.transact('group', (tx) => {
      // 一番手前の子の index を group に譲るので、その子の index を振り直す
      tx.put(group)
      const indices = indicesBetween(null, null, members.length)
      for (const [i, id] of members.entries()) {
        const node = nodeIn(tx, id)!
        tx.put({ ...node, parentId: group.id, index: indices[i] })
      }
      this.setSelection([group.id])
    })
    return group.id
  }

  // 選んでいる group を解除する（Ctrl+Shift+G）。子は、ワールドでの位置を保ったまま group の親に戻す
  ungroupSelected(): void {
    const groups = [...this.session.get().selectedIds].flatMap((id) => {
      const node = this.getNode(id)
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
        const before = at > 0 ? this.getNode(siblings[at - 1])!.index : null
        const after = at >= 0 && at < siblings.length - 1 ? this.getNode(siblings[at + 1])!.index : null
        const indices = indicesBetween(before, after, children.length)
        for (const [i, id] of children.entries()) {
          const child = nodeIn(tx, id)!
          tx.put({ ...this.fromWorld(this.toWorld(child), group.parentId), index: indices[i] })
          released.push(id)
        }
        tx.remove(group.id)
      }
      this.setSelection(released)
    })
  }

  // documentId を参照しているノード（Portal やカード）の形を計算し直す。変わったものの id を返す（MAI-30）
  refreshReferences(documentId: string): string[] {
    const ids: string[] = []
    for (const id of this.index.nodeIds()) {
      const node = this.getNode(id)
      if (node && this.workspace.referenceOf(node)?.targetId === documentId) ids.push(id)
    }
    if (ids.length > 0) this.index.refresh(ids)
    return ids
  }

  // ノードを固定する・固定を外す（MAI-32）。固定したノードは選べず、動かせない
  setLocked(ids: Iterable<string>, locked: boolean): void {
    const nodes = [...ids].flatMap((id) => this.getNode(id) ?? []).filter((n) => n.locked !== locked)
    if (nodes.length === 0) return
    this.transact(locked ? 'lock' : 'unlock', (tx) => {
      for (const node of nodes) tx.put({ ...node, locked })
      this.setSelection(locked ? [] : nodes.map((n) => n.id))
    })
  }

  // ---- PDF（MAI-7、MAI-10、MAI-32） ----

  // PDF を取り込む：PDF の File、ページを並べた Canvas（横 4 枚ずつの格子。ページは固定する）、
  // その持ち主の Portal（この Canvas の center）を 1 回の操作で作る（1 回の Undo で戻る）
  importPdf(options: {
    title: string
    asset: { id: string; hash: string; size: number }
    // ページの大きさ（ポイント）
    pageSizes: { width: number; height: number }[]
    center: Vec
  }): { portalId: string; canvasId: string; fileId: string } {
    const { title, asset, pageSizes, center } = options
    return this.transact('import pdf', (tx) => {
      const canvas = this.workspace.createCanvas(tx, title)
      const now = Date.now()
      const fileId = createId('file')
      tx.put({
        typeName: 'file',
        id: fileId,
        kind: 'pdf',
        title,
        path: '',
        size: asset.size,
        mtime: now,
        hash: asset.hash,
        missing: false,
        assetId: asset.id,
        pagesCanvasId: canvas.id,
        pageCount: pageSizes.length,
        parentCanvasId: null,
        ownerNodeId: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        trash: null,
      })
      // 格子に並べる。列の幅と行の高さは、その中で最も大きいページに合わせる
      const sizes = pageSizes.map((p) => ({ w: p.width * PDF_POINT_SCALE, h: p.height * PDF_POINT_SCALE }))
      const columnW = Math.max(...sizes.map((s) => s.w), 1)
      const indices = indicesBetween(null, null, sizes.length)
      let y = 0
      for (let row = 0; row * PDF_COLUMNS < sizes.length; row++) {
        const rowSizes = sizes.slice(row * PDF_COLUMNS, (row + 1) * PDF_COLUMNS)
        for (const [col, size] of rowSizes.entries()) {
          const pageIndex = row * PDF_COLUMNS + col
          tx.put({
            ...this.makeNode('pdf-page', {
              x: col * (columnW + PDF_PAGE_GAP),
              y,
              parentId: canvas.id,
              index: indices[pageIndex],
              props: { assetId: asset.id, fileId, pageIndex, w: size.w, h: size.h },
            }),
            locked: true,
          })
        }
        y += Math.max(...rowSizes.map((s) => s.h)) + PDF_PAGE_GAP
      }
      const portalId = this.putPortal(tx, canvas.id, 'owner', center, PORTAL_DEFAULT_SIZE)
      this.setSelection([portalId])
      return { portalId, canvasId: canvas.id, fileId }
    })
  }

  // ---- 引用（MAI-33） ----

  // 引用ノートを、左上が topLeft（ワールド座標）になるように置く。draft から新しい SourceAnchor も作る（1 回の Undo で戻る）
  createQuoteNote(draft: QuoteDraft, topLeft: Vec, options: { width?: number; label?: string } = {}): string {
    return this.transact(options.label ?? 'create quote', (tx) => {
      const anchorId = createId('anchor')
      tx.put({ typeName: 'anchor', id: anchorId, fileId: draft.fileId, locator: draft.locator, quote: draft.quote, createdAt: Date.now() })
      const parentId = this.frameAt(topLeft) ?? this.canvasId
      const local = this.worldToParent(parentId, topLeft)
      const props: QuoteCardProps = {
        anchorId,
        fileId: draft.fileId,
        quote: draft.quote,
        figure: draft.figure,
        memo: '',
        w: options.width ?? QUOTE_CARD_DEFAULT_WIDTH,
      }
      const node = this.makeNode('quote-card', { x: local.x, y: local.y, parentId, props })
      tx.put(node)
      this.setSelection([node.id])
      return node.id
    })
  }

  // 出典のノード（PDF のページ、Markdown カード）の右に、引用ノートを置く。高さは y（ワールド座標）から。
  // すでにある引用ノートと重なるなら、その下にずらす
  placeQuoteBeside(sourceNodeId: string, draft: QuoteDraft, y: number): string | null {
    const source = this.index.get(sourceNodeId)
    if (!source) return null
    const x = source.worldBounds.x + source.worldBounds.w + QUOTE_GAP
    const w = QUOTE_CARD_DEFAULT_WIDTH
    let top = y
    for (let guard = 0; guard < 100; guard++) {
      const blocking = this.index
        .search({ x, y: top, w, h: 1 })
        .flatMap((id) => {
          const entry = this.index.get(id)
          return entry && entry.node.type === 'quote-card' ? [entry.worldBounds] : []
        })
      if (blocking.length === 0) break
      top = Math.max(...blocking.map((b) => b.y + b.h)) + 12
    }
    return this.createQuoteNote(draft, { x, y: top })
  }

  // ワールド座標の点にある、PDF のページの上の引用した範囲（SourceAnchor）。固定したページにも当てる
  citationsAt(point: Vec): string[] {
    const zoom = this.session.get().camera.zoom
    const page = this.hitTest(point, 0, { includeLocked: true })
    if (!page || page.type !== 'pdf-page' || zoom <= 0) return []
    const entry = this.index.get(page.id)
    if (!entry) return []
    const { fileId, pageIndex, w, h } = page.props as PdfPageProps
    const local = applyMat(invert(entry.worldMatrix), point)
    const u = { x: local.x / w, y: local.y / h }
    return this.workspace.anchorsOfFile(fileId).flatMap((anchor) => {
      const loc = anchor.locator
      if (loc.kind !== 'pdf' || loc.pageIndex !== pageIndex) return []
      const inside = u.x >= loc.rect.x && u.x <= loc.rect.x + loc.rect.w && u.y >= loc.rect.y && u.y <= loc.rect.y + loc.rect.h
      return inside ? [anchor.id] : []
    })
  }

  // ---- Portal と階層（MAI-8、MAI-29） ----

  // ワールド座標の点を中心に、新しい子の Canvas と、その持ち主の Portal を作る。フレームの上なら、フレームの中に置く
  createPortal(center: Vec, options: { title?: string; size?: { w: number; h: number } } = {}): { portalId: string; canvasId: string } {
    const size = options.size ?? PORTAL_DEFAULT_SIZE
    return this.transact('create portal', (tx) => {
      const canvas = this.workspace.createCanvas(tx, options.title)
      const portalId = this.putPortal(tx, canvas.id, 'owner', center, size)
      this.setSelection([portalId])
      return { portalId, canvasId: canvas.id }
    })
  }

  // 未配置の Canvas・File を、この Canvas に置く（持ち主の Portal・カードを作る）。Canvas は自分自身や自分の祖先には置けない
  placeCanvas(documentId: string, center: Vec): string | null {
    const doc = this.workspace.getDocument(documentId)
    if (!doc || doc.ownerNodeId !== null || doc.deletedAt !== null) return null
    if (doc.typeName === 'file') return this.createFileCard(documentId, center)
    if (this.workspace.isSameOrInside(this.canvasId, documentId)) return null
    return this.transact('place canvas', (tx) => {
      const portalId = this.putPortal(tx, documentId, 'owner', center, PORTAL_DEFAULT_SIZE)
      this.setSelection([portalId])
      return portalId
    })
  }

  // File のカード（Markdown カードなど）を、上端の中央が top になるように置く（MAI-30）。
  // 参照先にまだ持ち主がいなければ持ち主、いればショートカットになる。フレームの上なら、フレームの中に置く
  createFileCard(fileId: string, top: Vec, options: { width?: number } = {}): string | null {
    const file = this.workspace.getFile(fileId)
    const type = file ? FILE_CARD_TYPES[file.kind] : undefined
    if (!file || !type || !this.types.has(type)) return null
    const role = file.ownerNodeId === null && file.deletedAt === null ? 'owner' : 'shortcut'
    const w = options.width ?? (this.types.get(type)!.defaultProps() as { w: number }).w
    return this.transact('create card', (tx) => {
      const parentId = this.frameAt(top) ?? this.canvasId
      const local = this.worldToParent(parentId, top)
      const node = this.makeNode(type, { x: local.x - w / 2, y: local.y, parentId, props: { fileId, w, role } })
      tx.put(node)
      this.setSelection([node.id])
      return node.id
    })
  }

  private putPortal(
    tx: Transaction<WorkspaceRecord>,
    targetId: string,
    role: 'owner' | 'shortcut',
    center: Vec,
    size: { w: number; h: number },
    parentId = this.frameAt(center) ?? this.canvasId,
    index?: string,
  ): string {
    const local = this.worldToParent(parentId, center)
    const portal = this.makeNode('portal', {
      x: local.x - size.w / 2,
      y: local.y - size.h / 2,
      parentId,
      index,
      props: { targetId, role, w: size.w, h: size.h },
    })
    tx.put(portal)
    return portal.id
  }

  // 選んでいるノードを、新しい Canvas に切り出す（MAI-8 の「選択範囲を Canvas に昇格」）。
  // 元の場所には、その Canvas の持ち主の Portal を置く。選択に含まれる持ち主の Portal は、新しい Canvas の子になる。
  // 切り出すノードと残るノードの間の矢印のつながりは外す（矢印は最後の位置のまま）
  promoteSelection(title?: string): { portalId: string; canvasId: string } | null {
    const selected = new Set(this.session.get().selectedIds)
    const roots = this.index.sortByOrder(
      [...selected].filter((id) => {
        const node = this.getNode(id)
        return node && !node.locked && !this.index.ancestorsOf(id).some((a) => selected.has(a))
      }),
    )
    if (roots.length === 0) return null
    const boxes = roots.flatMap((id) => this.index.get(id)?.worldBounds ?? [])
    const bounds = unionBoxes(boxes)!
    const center = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 }
    const moving = new Set(roots.flatMap((id) => [id, ...this.index.descendantsOf(id)]))
    // すべて同じ親（フレームなど）の中にあれば、Portal もそこに置く
    const parents = new Set(roots.map((id) => this.getNode(id)!.parentId))
    const [onlyParent] = parents
    const portalParent = parents.size === 1 && !this.isGroupId(onlyParent) ? onlyParent : this.canvasId
    const topmost = this.getNode(roots.at(-1)!)!
    return this.transact('promote', (tx) => {
      const canvas = this.workspace.createCanvas(tx, title)
      this.unbindCrossing(tx, moving)
      // ワールドでの位置のまま、新しい Canvas の直下に移す（子孫は親のローカル座標のままでよい）
      const indices = indicesBetween(null, null, roots.length)
      for (const [i, id] of roots.entries()) {
        const world = this.toWorld(nodeIn(tx, id)!)
        tx.put({ ...world, parentId: canvas.id, index: indices[i] })
      }
      const portalId = this.putPortal(tx, canvas.id, 'owner', center, PORTAL_DEFAULT_SIZE, portalParent, portalParent === topmost.parentId ? topmost.index : undefined)
      this.setSelection([portalId])
      return { portalId, canvasId: canvas.id }
    })
  }

  // 動かすノードの集まり moving と、残るノードの間の矢印のつながりを外す（別の Canvas に移すとき）
  private unbindCrossing(tx: Transaction<WorkspaceRecord>, moving: ReadonlySet<string>): void {
    for (const id of moving) {
      for (const binding of this.bindingsOfArrow(id)) if (!moving.has(binding.toId)) unbind(tx, binding)
      for (const bindingId of this.bindings.toTarget(id)) {
        const binding = this.getBinding(bindingId)
        if (binding && !moving.has(binding.fromId)) unbind(tx, binding)
      }
    }
  }

  // ---- 子キャンバスへの移動（MAI-38） ----

  // ids のうち、ほかの Canvas に移せるもの（固定していないもの。祖先も含まれるものは祖先と一緒に移るので除く）。重なり順
  private movableRoots(ids: Iterable<string>): string[] {
    const set = new Set(ids)
    return this.index.sortByOrder(
      [...set].filter((id) => {
        const node = this.getNode(id)
        return node && !node.locked && !this.index.ancestorsOf(id).some((a) => set.has(a))
      }),
    )
  }

  // ids（とその子孫）を canvasId に移せるか。移す先は、ゴミ箱の中でない、この Canvas 以外の Canvas。
  // 持ち主の Portal を移すと参照先の Canvas も移す先の子になるので、参照先自身やその子孫には移せない（循環になる）
  canMoveToCanvas(ids: Iterable<string>, canvasId: string): boolean {
    const target = this.workspace.getCanvas(canvasId)
    if (!target || target.deletedAt !== null || canvasId === this.canvasId) return false
    const roots = this.movableRoots(ids)
    if (roots.length === 0) return false
    return this.ownersIn(roots).every(({ targetId }) => !this.workspace.isSameOrInside(canvasId, targetId))
  }

  // ワールド座標の点にある、ids を落として移せる Portal（参照先が Canvas のもの。ids とその子孫は除く）。
  // いちばん手前の Portal の参照先に ids を移せない（循環になるなど）ときは null
  canvasDropTarget(point: Vec, ids: Iterable<string>): { portalId: string; canvasId: string } | null {
    const list = [...ids]
    const exclude = new Set(list)
    const ordered = this.index.sortByOrder(this.index.search({ x: point.x, y: point.y, w: 0, h: 0 }))
    for (let i = ordered.length - 1; i >= 0; i--) {
      const entry = this.index.get(ordered[i])
      if (!entry || entry.node.type !== 'portal') continue
      if ([ordered[i], ...this.index.ancestorsOf(ordered[i])].some((id) => exclude.has(id))) continue
      if (this.clippedAway(entry, point)) continue
      const local = applyMat(invert(entry.worldMatrix), point)
      if (!this.getType(entry.node).hitTest(entry.node, local, 0, this.session.get().camera.zoom)) continue
      const ref = this.workspace.referenceOf(entry.node)
      if (!ref || !this.canMoveToCanvas(list, ref.targetId)) return null
      return { portalId: entry.node.id, canvasId: ref.targetId }
    }
    return null
  }

  // ids（とその子孫）を、別の Canvas（子の Canvas など）の直下に移す（1 回の Undo で戻る。履歴はこの Canvas に入る）。
  // 並びは保ったまま、移す先にすでにあるものの右に置く（空なら、今のワールドでの位置のまま）。
  // 移すノードと残るノードの間の矢印のつながりは外す。持ち主の Portal を移すと、参照先は移す先の子になる（フック）。
  // 移したノードの id を返す。移せなければ null
  moveToCanvas(ids: Iterable<string>, canvasId: string): string[] | null {
    const list = [...ids]
    if (!this.canMoveToCanvas(list, canvasId)) return null
    const roots = this.movableRoots(list)
    const bounds = unionBoxes(roots.flatMap((id) => this.index.get(id)?.worldBounds ?? []))!
    const moving = new Set(roots.flatMap((id) => [id, ...this.index.descendantsOf(id)]))
    // 移す先の中身（直下のノードとその子孫）の索引。置く位置と重なり順を決める
    const target = new NodeIndex(canvasId, this.types)
    target.load(this.workspace.tree.descendantsOf(canvasId).flatMap((id) => this.getNode(id) ?? []))
    const content = unionBoxes(target.allIds().flatMap((id) => target.get(id)?.worldBounds ?? []))
    const offset = content
      ? { x: content.x + content.w + MOVE_TO_CANVAS_GAP - bounds.x, y: content.y - bounds.y }
      : { x: 0, y: 0 }
    const owners = this.ownersIn(roots)
    return this.transact('move to canvas', (tx) => {
      this.unbindCrossing(tx, moving)
      // 移す先の最も手前に、今の重なり順のまま並べる（子孫は親のローカル座標のままでよい）
      const indices = indicesBetween(target.topmost()?.index ?? null, null, roots.length)
      for (const [i, id] of roots.entries()) {
        const world = this.toWorld(nodeIn(tx, id)!)
        tx.put({ ...world, parentId: canvasId, x: world.x + offset.x, y: world.y + offset.y, index: indices[i] })
      }
      // 持ち主の Portal の参照先を、移す先の子にする。直下のものはフックでも付け直すが、フレームの中などで
      // レコードの変わらないものがあるので、ここでまとめて行う
      for (const { targetId } of owners) {
        const doc = this.workspace.getDocument(targetId)
        if (doc && doc.parentCanvasId !== canvasId) tx.put({ ...doc, parentCanvasId: canvasId, updatedAt: Date.now() })
      }
      this.setSelection([])
      return roots
    })
  }

  private isGroupId(id: string | undefined): boolean {
    const node = id ? this.getNode(id) : undefined
    return node !== undefined && this.isContainer(node, 'group')
  }

  // ---- 選択 ----

  setSelection(ids: Iterable<string>): void {
    this.session.set({ selectedIds: new Set(ids) })
  }

  // 今の階層（中に入っている group の中、そうでなければ Canvas 直下）のノードをすべて選ぶ
  selectAll(): void {
    const parent = this.session.get().focusedGroupId ?? this.canvasId
    this.setSelection(this.index.childrenOf(parent).filter((id) => !this.getNode(id)?.locked))
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
      const node = this.getNode(ancestor)
      if (node && this.isContainer(node, 'group')) target = ancestor
    }
    // 中に入っている group の外のノードをクリックしたら、中から出る
    if (focus && !this.index.ancestorsOf(target).includes(focus)) this.focusGroup(null)
    return target
  }

  // ---- Undo / Redo（Canvas ごと） ----

  // 最後の Undo / Redo ができなかった理由。'conflict' は、そのあとの別の操作（ほかの Canvas での編集など）と重なるため
  lastHistoryFailure: 'empty' | 'conflict' | null = null

  undo(): boolean {
    const result = this.history.undo(this.canvasId)
    this.lastHistoryFailure = result.ok ? null : result.reason
    if (!result.ok) return false
    const meta = result.entry.meta as HistoryMeta | undefined
    if (meta) this.setSelection(meta.selectionBefore.filter((id) => this.store.has(id)))
    return true
  }

  redo(): boolean {
    const result = this.history.redo(this.canvasId)
    this.lastHistoryFailure = result.ok ? null : result.reason
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
      // 画像のように縦横比を保つ型を含むときも、縦横比を保つ（MAI-26）
      forceAspect:
        targets.some((t) => t.type.lockAspectRatio) ||
        (!single && (hasGroup || targets.some((t) => rightAngle(t.node.rotation) === null))),
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
  // includeLocked：固定したノードも当てる（右クリックで固定を外すため。MAI-32）
  hitTest(point: Vec, marginWorld: number, options: { includeLocked?: boolean } = {}): NodeRecord | null {
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
      if (!entry || (entry.node.locked && !options.includeLocked)) continue
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
      if (this.index.ancestorsOf(ordered[i]).some((id) => this.isContainer(this.getNode(id)!, 'group'))) continue
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
        const node = this.getNode(ancestor)
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
