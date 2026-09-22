import {
  History,
  Store,
  createId,
  isBindingRecord,
  isCanvasRecord,
  isDocumentRecord,
  isFileRecord,
  isNodeRecord,
  type BindingRecord,
  type CanvasRecord,
  type DocumentRecord,
  type FileRecord,
  type NodeRecord,
  type Patch,
  type Transaction,
  type WorkspaceRecord,
} from '@canvcode/core'
import { builtinNodeTypes, type AnyNodeTypeDef, type ArrowProps, type DocumentReference } from '@canvcode/nodes'
import { BindingIndex, resolveArrow, unbind, type NodeLookup } from './bindings.ts'

// ワークスペース（MAI-8、MAI-11）。
// - ストアはワークスペースに 1 つ。Canvas・Node・Binding をすべて入れる。履歴は Canvas ごと（scope）に分ける
// - どの Canvas にも関係する決まりごと（子孫の削除、矢印のつながり、空の group、Portal と階層、ゴミ箱）は、
//   ここのストアのフックで守る。フックで起きた変更は、操作したトランザクションに入り、1 回の Undo で戻る
// - 1 つの Canvas を編集する入口は Editor。Editor はこのワークスペースを共有する
// 段階 11 までは永続化せず、ブラウザのメモリ内だけで動く。

export interface HistoryMeta {
  selectionBefore: string[]
  selectionAfter?: string[]
  // 持ち主（Portal やカード）を消したとき、参照先の Canvas・File をどうするか（MAI-8）。既定は 'unplace'
  ownerPortalDeletion?: OwnerPortalDeletion
}

// 'trash'：参照先とその子孫をゴミ箱に送る / 'unplace'：参照先を「未配置」にする
export type OwnerPortalDeletion = 'trash' | 'unplace'

export interface WorkspaceOptions {
  rootCanvasId?: string
  rootTitle?: string
  types?: AnyNodeTypeDef[]
}

// ノードの親 → 子（ワークスペース全体）。トランザクションの途中でも引けるよう、フックと知らせの両方で更新する
class NodeTree {
  private readonly children = new Map<string, Set<string>>()

  apply(before: WorkspaceRecord | undefined, after: WorkspaceRecord | undefined, id: string): void {
    if (isNodeRecord(before)) {
      const set = this.children.get(before.parentId)
      set?.delete(id)
      if (set && set.size === 0) this.children.delete(before.parentId)
    }
    if (isNodeRecord(after)) {
      let set = this.children.get(after.parentId)
      if (!set) {
        set = new Set()
        this.children.set(after.parentId, set)
      }
      set.add(id)
    }
  }

  childrenOf(id: string): string[] {
    return [...(this.children.get(id) ?? [])]
  }

  descendantsOf(id: string): string[] {
    const out: string[] = []
    const visit = (parent: string) => {
      for (const child of this.children.get(parent) ?? []) {
        out.push(child)
        visit(child)
      }
    }
    visit(id)
    return out
  }
}

export class Workspace implements NodeLookup {
  readonly store = new Store<WorkspaceRecord>()
  // 消すレコードに、差分に入っていない子（あとで別の操作で入れたもの。子の Canvas の中身など）が残るなら、取り消さない
  readonly history = new History(this.store, { validate: (patch) => this.leavesNoOrphans(patch) })
  readonly types: Map<string, AnyNodeTypeDef>
  readonly bindings = new BindingIndex()
  readonly tree = new NodeTree()
  readonly rootCanvasId: string

  constructor(options: WorkspaceOptions = {}) {
    this.types = new Map((options.types ?? builtinNodeTypes).map((type) => [type.type, type]))
    this.rootCanvasId = options.rootCanvasId ?? createId('canvas')
    this.store.setHooks({
      afterCreate: (record, tx) => {
        this.track(undefined, record, record.id)
        if (isNodeRecord(record) && tx.options.source === 'user') this.ownerPlaced(tx, record)
      },
      afterUpdate: (prev, next, tx) => {
        this.track(prev, next, next.id)
        if (isNodeRecord(next) && tx.options.source === 'user') this.ownerPlaced(tx, next)
      },
      afterDelete: (record, tx) => {
        this.track(record, undefined, record.id)
        // Undo・Redo や別のタブからの差分には、元の操作で起きた変更がすべて入っているので、ここでは何もしない
        if (tx.options.source !== 'user') return
        if (isNodeRecord(record)) this.nodeDeleted(tx, record)
        if (isCanvasRecord(record)) {
          // Canvas を完全に削除したら、その中身も消す
          for (const childId of this.tree.childrenOf(record.id)) tx.remove(childId)
        }
      },
      // 子がいなくなった group は消す（MAI-25）
      beforeCommit: (patch, tx) => {
        if (tx.options.source !== 'user') return
        const groups = new Set<string>()
        for (const change of patch.values()) {
          if (!isNodeRecord(change.before)) continue
          const parentId = change.before.parentId
          if (parentId !== (isNodeRecord(change.after) ? change.after.parentId : undefined)) groups.add(parentId)
        }
        for (const id of groups) {
          const group = this.getNode(id)
          if (group && this.types.get(group.type)?.container === 'group' && this.tree.childrenOf(id).length === 0) {
            tx.remove(id)
          }
        }
      },
      // 変わったノードにつながっている矢印の端を、知らせる前に合わせ直す（MAI-28）
      beforeFlush: (pending, tx) => this.updateArrows(pending, tx),
    })
    // 取り消し（cancel）はフックを通らないので、索引はここでも合わせる（どちらから当てても同じ結果になる）
    this.store.listen((event) => {
      for (const [id, change] of event.patch) this.track(change.before, change.after, id)
    })
    this.store.transact(
      'create root',
      (tx) => tx.put(makeCanvas(this.rootCanvasId, options.rootTitle ?? 'ホーム')),
      { history: 'ignore' },
    )
  }

  private leavesNoOrphans(patch: Patch<WorkspaceRecord>): boolean {
    for (const [id, change] of patch) {
      if (change.after !== undefined) continue
      for (const childId of this.tree.childrenOf(id)) {
        const childChange = patch.get(childId)
        const stays = !childChange || (isNodeRecord(childChange.after) && childChange.after.parentId === id)
        if (stays) return false
      }
    }
    return true
  }

  private track(before: WorkspaceRecord | undefined, after: WorkspaceRecord | undefined, id: string): void {
    this.bindings.apply(before, after)
    this.tree.apply(before, after, id)
  }

  // ---- 読み出し ----

  getNode(id: string): NodeRecord | undefined {
    const record = this.store.get(id)
    return isNodeRecord(record) ? record : undefined
  }

  getType(node: NodeRecord): AnyNodeTypeDef {
    const type = this.types.get(node.type)
    if (!type) throw new Error(`Unknown node type: ${node.type}`)
    return type
  }

  getBinding(id: string): BindingRecord | undefined {
    const record = this.store.get(id)
    return isBindingRecord(record) ? record : undefined
  }

  getCanvas(id: string): CanvasRecord | undefined {
    const record = this.store.get(id)
    return isCanvasRecord(record) ? record : undefined
  }

  getFile(id: string): FileRecord | undefined {
    const record = this.store.get(id)
    return isFileRecord(record) ? record : undefined
  }

  // Canvas か File（Portal やカードの参照先）
  getDocument(id: string): DocumentRecord | undefined {
    const record = this.store.get(id)
    return isDocumentRecord(record) ? record : undefined
  }

  // ノードが参照している Canvas・File と、その持ち主か
  referenceOf(node: NodeRecord): DocumentReference | null {
    return this.types.get(node.type)?.reference?.(node) ?? null
  }

  bindingsOfArrow(arrowId: string): BindingRecord[] {
    return this.bindings.ofArrow(arrowId).flatMap((id) => this.getBinding(id) ?? [])
  }

  // Canvas の一覧（数は多くないので、ストアを調べる）
  canvases(): CanvasRecord[] {
    const out: CanvasRecord[] = []
    for (const record of this.store.values()) if (isCanvasRecord(record)) out.push(record)
    return out
  }

  // Canvas と File の一覧
  documents(): DocumentRecord[] {
    const out: DocumentRecord[] = []
    for (const record of this.store.values()) if (isDocumentRecord(record)) out.push(record)
    return out
  }

  // 持ち主による子の File（ゴミ箱の中のものは除く）。ツリーでは葉になる。
  // PDF はページを並べた Canvas として表すので、ここには入れない
  childFiles(canvasId: string): FileRecord[] {
    const out: FileRecord[] = []
    for (const record of this.store.values()) {
      if (isFileRecord(record) && record.kind !== 'pdf' && record.parentCanvasId === canvasId && record.deletedAt === null) out.push(record)
    }
    return out.sort((a, b) => a.title.localeCompare(b.title, 'ja'))
  }

  // 持ち主による子の Canvas（ゴミ箱の中のものは除く）
  childCanvases(canvasId: string): CanvasRecord[] {
    return this.canvases()
      .filter((c) => c.parentCanvasId === canvasId && c.deletedAt === null)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
  }

  // 未配置：持ち主がなく、ゴミ箱にも入っていない Canvas・File（ルートは除く）。
  // 外で作られた .md / .py も、ここに入る（MAI-10）
  unplacedDocuments(): DocumentRecord[] {
    return this.documents()
      .filter((d) => d.id !== this.rootCanvasId && d.ownerNodeId === null && d.deletedAt === null)
      .filter((d) => !(isFileRecord(d) && d.kind === 'pdf'))
      .sort((a, b) => a.title.localeCompare(b.title, 'ja'))
  }

  unplacedCanvases(): CanvasRecord[] {
    return this.unplacedDocuments().filter(isCanvasRecord)
  }

  // ゴミ箱：一緒に入れたまとまりの根
  trashedDocuments(): DocumentRecord[] {
    return this.documents()
      .filter((d) => d.deletedAt !== null && isTrashRoot(this, d))
      .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
  }

  trashedCanvases(): CanvasRecord[] {
    return this.trashedDocuments().filter(isCanvasRecord)
  }

  // ルートから canvasId までの Canvas（パンくずリスト）。未配置なら、たどれるところまで
  canvasPath(canvasId: string): CanvasRecord[] {
    const path: CanvasRecord[] = []
    let current = this.getCanvas(canvasId)
    for (let guard = 0; current && guard < 1000; guard++) {
      path.unshift(current)
      current = current.parentCanvasId ? this.getCanvas(current.parentCanvasId) : undefined
    }
    return path
  }

  // a が b 自身か、b の子孫か（持ち主の Portal を、自分や自分の子孫に置かないため）
  isSameOrInside(a: string, b: string): boolean {
    return this.canvasPath(a).some((c) => c.id === b)
  }

  // ノードが属する Canvas
  canvasOf(nodeId: string): string | null {
    let id = nodeId
    for (let guard = 0; guard < 10_000; guard++) {
      const record = this.store.get(id)
      if (isCanvasRecord(record)) return record.id
      if (!isNodeRecord(record)) return null
      id = record.parentId
    }
    return null
  }

  // Portal やカードの参照先の状態
  targetStatus(targetId: string): 'ok' | 'trashed' | 'missing' | 'nofile' {
    const doc = this.getDocument(targetId)
    if (!doc) return 'missing'
    if (doc.deletedAt !== null) return 'trashed'
    return isFileRecord(doc) && doc.missing ? 'nofile' : 'ok'
  }

  nextCanvasTitle(): string {
    const used = new Set(this.canvases().map((c) => c.title))
    for (let n = 1; ; n++) {
      const title = `新しいキャンバス ${n}`
      if (!used.has(title)) return title
    }
  }

  // ---- 操作（どれも呼び出し側のトランザクションの中で行い、その Canvas の履歴に入る） ----

  createCanvas(tx: Transaction<WorkspaceRecord>, title = this.nextCanvasTitle()): CanvasRecord {
    const canvas = makeCanvas(createId('canvas'), title)
    tx.put(canvas)
    return canvas
  }

  renameCanvas(tx: Transaction<WorkspaceRecord>, canvasId: string, title: string): void {
    const canvas = this.getCanvas(canvasId)
    if (canvas && title && canvas.title !== title) tx.put({ ...canvas, title, updatedAt: Date.now() })
  }

  // サーバーから届いた File の情報を、レコードに入れる（MAI-30）。階層とゴミ箱の項目は、ブラウザ側の値を残す。
  // サーバーが正本なので、履歴には残さない
  applyServerFile(info: Pick<FileRecord, 'id' | 'kind' | 'title' | 'path' | 'size' | 'mtime' | 'hash' | 'missing'>): void {
    const existing = this.getFile(info.id)
    const now = Date.now()
    const next: FileRecord = existing
      ? { ...existing, ...info, updatedAt: now }
      : { typeName: 'file', ...info, parentCanvasId: null, ownerNodeId: null, createdAt: now, updatedAt: now, deletedAt: null, trash: null }
    if (existing && sameServerFields(existing, next)) return
    this.store.transact('server file', (tx) => tx.put(next), { history: 'ignore', source: 'remote' })
  }

  // ゴミ箱から元に戻す。一緒に入れたものもすべて戻し、持ち主（Portal やカード）を元の場所に置き直す。
  // 元の場所がもうなければ（その Canvas も消えた・ゴミ箱の中など）、未配置として戻す
  restoreCanvas(tx: Transaction<WorkspaceRecord>, documentId: string): void {
    const root = this.getDocument(documentId)
    if (!root?.trash) return
    const { batchId, portal } = root.trash
    for (const doc of this.documents()) {
      if (doc.trash?.batchId !== batchId) continue
      tx.put({ ...doc, deletedAt: null, trash: null, ...(doc.id === root.id ? { parentCanvasId: null, ownerNodeId: null } : {}) })
    }
    if (portal) {
      const parentCanvas = this.canvasOfParent(portal.parentId)
      if (parentCanvas && this.targetStatus(parentCanvas) === 'ok' && !this.store.has(portal.id)) {
        // 置き直すと、フック（portalPlaced）が持ち主と親を付け直す
        tx.put(portal)
      }
    }
  }

  // ゴミ箱から完全に削除する。一緒に入れたものと、その中身をすべて消す。これを指すショートカットは「リンク切れ」になる。
  // 消した File（.md・.py）の id を返す（呼び出し側が、サーバーに実ファイルの退避を頼む）
  deleteCanvasForever(tx: Transaction<WorkspaceRecord>, documentId: string): string[] {
    const root = this.getDocument(documentId)
    if (!root?.trash) return []
    const files: string[] = []
    const removed = new Set<string>()
    for (const doc of this.documents()) {
      if (doc.trash?.batchId !== root.trash.batchId) continue
      tx.remove(doc.id)
      removed.add(doc.id)
      if (isFileRecord(doc) && doc.kind !== 'pdf') files.push(doc.id)
    }
    // ページの Canvas を消したら、その PDF の File も消す（原本の Asset は、どこからも参照されなくなってからサーバーが消す）
    for (const doc of this.documents()) {
      if (isFileRecord(doc) && doc.kind === 'pdf' && doc.pagesCanvasId && removed.has(doc.pagesCanvasId)) tx.remove(doc.id)
    }
    return files
  }

  private canvasOfParent(parentId: string): string | null {
    return isCanvasRecord(this.store.get(parentId)) ? parentId : this.canvasOf(parentId)
  }

  // ---- フック ----

  // 持ち主（Portal やカード）が置かれた・動いた：参照先の持ち主と親を付け直す（MAI-8）
  private ownerPlaced(tx: Transaction<WorkspaceRecord>, node: NodeRecord): void {
    const ref = this.referenceOf(node)
    if (!ref || ref.role !== 'owner') return
    const target = this.getDocument(ref.targetId)
    const parentCanvasId = this.canvasOf(node.id)
    if (!target || !parentCanvasId) return
    if (target.ownerNodeId === node.id && target.parentCanvasId === parentCanvasId) return
    // 持ち主は 1 つだけ。別の持ち主がすでにあるなら、何もしない（貼り付けではショートカットにしてから置く）
    if (target.ownerNodeId !== null && target.ownerNodeId !== node.id) return
    tx.put({ ...target, ownerNodeId: node.id, parentCanvasId, updatedAt: Date.now() })
  }

  private nodeDeleted(tx: Transaction<WorkspaceRecord>, record: NodeRecord): void {
    // 親を消したら、子孫もまとめて消す（同じトランザクションの中なので、Undo で一緒に戻る）
    for (const childId of this.tree.childrenOf(record.id)) {
      const child = tx.get(childId)
      if (isNodeRecord(child) && child.parentId === record.id) tx.remove(childId)
    }
    // 矢印を消したら、その Binding も消す。つながっている先を消したら、矢印の端をその場に固定して外す
    for (const id of this.bindings.ofArrow(record.id)) tx.remove(id)
    for (const id of this.bindings.toTarget(record.id)) {
      const binding = tx.get(id)
      if (isBindingRecord(binding)) unbind(tx, binding)
    }
    // 持ち主（Portal やカード）を消したら、参照先をゴミ箱に送るか、未配置にする
    const ref = this.referenceOf(record)
    if (ref) {
      const target = this.getDocument(ref.targetId)
      if (ref.role !== 'owner' || !target || target.ownerNodeId !== record.id) return
      const mode = (tx.options.meta as HistoryMeta | undefined)?.ownerPortalDeletion ?? 'unplace'
      if (mode === 'trash') this.trash(tx, target, record)
      else tx.put({ ...target, ownerNodeId: null, parentCanvasId: null, updatedAt: Date.now() })
    }
  }

  // 参照先とその子孫（子の Canvas と、そこに置いた File）を、1 つのまとまりとしてゴミ箱に送る。実ファイルは動かさない（MAI-13）
  private trash(tx: Transaction<WorkspaceRecord>, target: DocumentRecord, owner: NodeRecord): void {
    const batchId = createId('canvas')
    const now = Date.now()
    const visit = (doc: DocumentRecord, isRoot: boolean) => {
      tx.put({
        ...doc,
        deletedAt: now,
        trash: { batchId, portal: isRoot ? owner : null },
        ...(isRoot ? { ownerNodeId: null } : {}),
      })
      if (!isCanvasRecord(doc)) return
      for (const child of this.childCanvases(doc.id)) visit(child, false)
      for (const file of this.childFiles(doc.id)) visit(file, false)
    }
    visit(target, true)
  }

  private updateArrows(pending: Patch<WorkspaceRecord>, tx: Transaction<WorkspaceRecord>): void {
    const arrows = new Set<string>()
    const hasBindings = !this.bindings.isEmpty
    for (const [id, change] of [...pending]) {
      for (const record of [change.before, change.after]) {
        if (isBindingRecord(record)) arrows.add(record.fromId)
      }
      const node = change.after
      if (!isNodeRecord(node)) continue
      if (node.type === 'arrow') arrows.add(id)
      if (!hasBindings) continue
      // 動いたノードと、その子孫（group ごと動かしたときなど）につながっている矢印
      for (const nodeId of [id, ...this.tree.descendantsOf(id)]) {
        for (const bindingId of this.bindings.toTarget(nodeId)) {
          const binding = this.getBinding(bindingId)
          if (binding) arrows.add(binding.fromId)
        }
      }
    }
    for (const arrowId of arrows) {
      const arrow = this.getNode(arrowId)
      if (!arrow || arrow.type !== 'arrow') continue
      const next = resolveArrow(this, arrow as NodeRecord<ArrowProps>, this.bindingsOfArrow(arrowId))
      if (next) tx.put({ ...arrow, props: next })
    }
  }
}

function makeCanvas(id: string, title: string): CanvasRecord {
  const now = Date.now()
  return {
    typeName: 'canvas',
    id,
    title,
    parentCanvasId: null,
    ownerNodeId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    trash: null,
  }
}

// まとまりの根か（持ち主の写しを持つもの。ただし、持ち主なしで入れたものは、親が同じまとまりにないもの）
function isTrashRoot(workspace: Workspace, doc: DocumentRecord): boolean {
  if (!doc.trash) return false
  if (doc.trash.portal) return true
  const parent = doc.parentCanvasId ? workspace.getCanvas(doc.parentCanvasId) : undefined
  return parent?.trash?.batchId !== doc.trash.batchId
}

function sameServerFields(a: FileRecord, b: FileRecord): boolean {
  return (
    a.kind === b.kind &&
    a.title === b.title &&
    a.path === b.path &&
    a.size === b.size &&
    a.mtime === b.mtime &&
    a.hash === b.hash &&
    a.missing === b.missing
  )
}
