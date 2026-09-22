import RBush from 'rbush'
import {
  IDENTITY,
  multiply,
  transformBox,
  transformOf,
  unionBoxes,
  type Box,
  type Mat,
  type NodeRecord,
  type Patch,
} from '@canvcode/core'
import type { AnyNodeTypeDef } from '@canvcode/nodes'

// ノードの索引（MAI-14、MAI-25）。
// - 入れ子（group / frame）をたどったワールドの行列と、バウンディングボックスのキャッシュ
// - group の大きさは、子の大きさから計算する
// - rbush による空間インデックス（カリング・当たり判定・範囲選択に使う）。group 自体は見た目がないので入れない
// - 描画の順番（深さ優先で、親の次にその子を index の順に）のキャッシュ
//
// 変更があったら、そのノードが属する「木」（Canvas 直下のノードとその子孫）だけを計算し直す。
// 入れ子のない 1 万ノードなら、これまでどおり変わったノードの分だけで済む。

interface IndexItem {
  minX: number
  minY: number
  maxX: number
  maxY: number
  id: string
}

export interface IndexEntry {
  node: NodeRecord
  // ノードのローカル座標 → ワールド座標
  worldMatrix: Mat
  // ノードのローカル座標でのバウンディングボックス（group は子から計算したもの）
  localBounds: Box
  worldBounds: Box
  // 属する木の根（Canvas 直下のノード）
  root: string
  item: IndexItem | null
}

const EMPTY_BOX: Box = { x: 0, y: 0, w: 0, h: 0 }

export class NodeIndex {
  private readonly tree = new RBush<IndexItem>()
  private readonly entries = new Map<string, IndexEntry>()
  // ストアにあるこの Canvas のノード（親をたどれないものも含む）
  private readonly nodes = new Map<string, NodeRecord>()
  private readonly children = new Map<string, Set<string>>()
  // 木の根 → その木に属するノード
  private readonly members = new Map<string, Set<string>>()
  private readonly types: Map<string, AnyNodeTypeDef>
  private readonly canvasId: string
  private orderRank = new Map<string, number>()
  private orderDirty = true

  constructor(canvasId: string, types: Map<string, AnyNodeTypeDef>) {
    this.canvasId = canvasId
    this.types = types
  }

  get size(): number {
    return this.entries.size
  }

  // Canvas を開いたときにまとめて作る（rbush の一括読み込みは 1 件ずつより速い）
  load(nodes: Iterable<NodeRecord>): void {
    this.tree.clear()
    this.entries.clear()
    this.nodes.clear()
    this.children.clear()
    this.members.clear()
    for (const node of nodes) this.addToMaps(node)
    const items: IndexItem[] = []
    for (const rootId of this.children.get(this.canvasId) ?? []) this.buildTree(rootId, items)
    this.tree.load(items)
    this.orderDirty = true
  }

  applyPatch(patch: Patch<NodeRecord>): void {
    // 変更の前と後で、そのノードが属していた木の根を集め、その木をまるごと計算し直す
    const roots = new Set<string>()
    for (const [id, change] of patch) {
      const before = this.entries.get(id)?.root
      if (before) roots.add(before)
      else if (change.before) {
        const root = this.rootOf(change.before.parentId)
        if (root) roots.add(root)
      }
    }
    for (const [id, change] of patch) {
      const previous = this.nodes.get(id)
      if (previous) this.removeFromMaps(previous)
      if (change.after) this.addToMaps(change.after)
      if (!previous || !change.after || previous.index !== change.after.index || previous.parentId !== change.after.parentId) {
        this.orderDirty = true
      }
    }
    for (const [id, change] of patch) {
      if (!change.after) continue
      const root = change.after.parentId === this.canvasId ? id : this.rootOf(change.after.parentId)
      if (root) roots.add(root)
    }
    for (const root of roots) this.rebuildTree(root)
  }

  get(id: string): IndexEntry | undefined {
    return this.entries.get(id)
  }

  search(box: Box): string[] {
    return this.tree
      .search({ minX: box.x, minY: box.y, maxX: box.x + box.w, maxY: box.y + box.h })
      .map((item) => item.id)
  }

  // 描画順（奥から手前）に並べる
  sortByOrder(ids: string[]): string[] {
    const rank = this.ranks()
    return ids.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0))
  }

  // 親の子を、重なり順（奥から手前）に返す
  childrenOf(parentId: string): string[] {
    const ids = [...(this.children.get(parentId) ?? [])].filter((id) => this.entries.has(id))
    return ids.sort((a, b) => compareIndex(this.nodes.get(a)!, this.nodes.get(b)!))
  }

  // 子孫（深さ優先、描画の順）
  descendantsOf(id: string): string[] {
    const out: string[] = []
    const visit = (parent: string) => {
      for (const child of this.childrenOf(parent)) {
        out.push(child)
        visit(child)
      }
    }
    visit(id)
    return out
  }

  // 祖先（近い順）。Canvas は含まない
  ancestorsOf(id: string): string[] {
    const out: string[] = []
    let parent = this.nodes.get(id)?.parentId
    while (parent && parent !== this.canvasId) {
      out.push(parent)
      parent = this.nodes.get(parent)?.parentId
    }
    return out
  }

  // 親の中で最も手前にあるノード（新しいノードの index を決めるのに使う）
  topmost(parentId = this.canvasId): NodeRecord | undefined {
    const id = this.childrenOf(parentId).at(-1)
    return id ? this.nodes.get(id) : undefined
  }

  // Canvas 直下のノード（重なり順）
  allIds(): string[] {
    return this.childrenOf(this.canvasId)
  }

  // 親のローカル座標 → ワールド座標の行列（Canvas 直下なら単位行列）
  parentMatrix(parentId: string): Mat {
    if (parentId === this.canvasId) return IDENTITY
    return this.entries.get(parentId)?.worldMatrix ?? IDENTITY
  }

  private ranks(): Map<string, number> {
    if (this.orderDirty) {
      const order: string[] = []
      const visit = (parent: string) => {
        for (const child of this.childrenOf(parent)) {
          order.push(child)
          visit(child)
        }
      }
      visit(this.canvasId)
      this.orderRank = new Map(order.map((id, i) => [id, i]))
      this.orderDirty = false
    }
    return this.orderRank
  }

  private addToMaps(node: NodeRecord): void {
    this.nodes.set(node.id, node)
    let set = this.children.get(node.parentId)
    if (!set) {
      set = new Set()
      this.children.set(node.parentId, set)
    }
    set.add(node.id)
  }

  private removeFromMaps(node: NodeRecord): void {
    this.nodes.delete(node.id)
    const set = this.children.get(node.parentId)
    set?.delete(node.id)
    if (set && set.size === 0) this.children.delete(node.parentId)
  }

  // 親をたどって、Canvas 直下の祖先を返す。Canvas までたどれなければ null
  private rootOf(id: string): string | null {
    if (id === this.canvasId) return null
    let current = id
    for (let guard = 0; guard < 10_000; guard++) {
      const node = this.nodes.get(current)
      if (!node) return null
      if (node.parentId === this.canvasId) return current
      current = node.parentId
    }
    return null
  }

  private rebuildTree(rootId: string): void {
    for (const id of this.members.get(rootId) ?? []) {
      const entry = this.entries.get(id)
      if (entry?.item) this.tree.remove(entry.item)
      this.entries.delete(id)
    }
    this.members.delete(rootId)
    const node = this.nodes.get(rootId)
    if (!node || node.parentId !== this.canvasId) return
    const items: IndexItem[] = []
    this.buildTree(rootId, items)
    for (const item of items) this.tree.insert(item)
  }

  // 木を、上から行列を、下から大きさを計算して作る
  private buildTree(rootId: string, items: IndexItem[]): void {
    const members = new Set<string>()
    const build = (id: string, parentMatrix: Mat): IndexEntry | null => {
      const node = this.nodes.get(id)
      if (!node) return null
      const type = this.types.get(node.type)
      if (!type) throw new Error(`Unknown node type: ${node.type}`)
      const localMatrix = transformOf(node.x, node.y, node.rotation)
      const worldMatrix = multiply(parentMatrix, localMatrix)
      const childEntries: IndexEntry[] = []
      for (const childId of this.children.get(id) ?? []) {
        const child = build(childId, worldMatrix)
        if (child) childEntries.push(child)
      }
      let localBounds: Box
      if (type.container === 'group') {
        // 子のローカルの箱を、group のローカル座標に写して合わせる
        localBounds =
          unionBoxes(
            childEntries.map((child) =>
              transformBox(transformOf(child.node.x, child.node.y, child.node.rotation), child.localBounds),
            ),
          ) ?? EMPTY_BOX
      } else {
        localBounds = type.getBounds(node)
      }
      const worldBounds = transformBox(worldMatrix, localBounds)
      const item =
        type.container === 'group'
          ? null
          : {
              minX: worldBounds.x,
              minY: worldBounds.y,
              maxX: worldBounds.x + worldBounds.w,
              maxY: worldBounds.y + worldBounds.h,
              id,
            }
      if (item) items.push(item)
      const entry: IndexEntry = { node, worldMatrix, localBounds, worldBounds, root: rootId, item }
      this.entries.set(id, entry)
      members.add(id)
      return entry
    }
    build(rootId, IDENTITY)
    this.members.set(rootId, members)
  }
}

function compareIndex(a: NodeRecord, b: NodeRecord): number {
  return a.index < b.index ? -1 : a.index > b.index ? 1 : a.id < b.id ? -1 : 1
}
