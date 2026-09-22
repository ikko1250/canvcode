import RBush from 'rbush'
import {
  IDENTITY,
  multiply,
  transformBox,
  transformOf,
  type Box,
  type Mat,
  type NodeRecord,
  type Patch,
} from '@canvcode/core'
import type { AnyNodeTypeDef } from '@canvcode/nodes'

// ノードの索引（MAI-14）。
// - rbush による空間インデックス（カリング・当たり判定・範囲選択に使う）
// - ワールド座標での行列とバウンディングボックスのキャッシュ
// - 重なり順（描画順）の番号のキャッシュ。重なり順が変わったときだけ並べ直す

interface IndexItem {
  minX: number
  minY: number
  maxX: number
  maxY: number
  id: string
}

interface Entry {
  node: NodeRecord
  item: IndexItem
  worldMatrix: Mat
  worldBounds: Box
}

export class NodeIndex {
  private readonly tree = new RBush<IndexItem>()
  private readonly entries = new Map<string, Entry>()
  private readonly types: Map<string, AnyNodeTypeDef>
  private readonly canvasId: string
  private order: string[] = []
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
    const items: IndexItem[] = []
    for (const node of nodes) {
      if (!this.belongsHere(node)) continue
      const entry = this.makeEntry(node)
      this.entries.set(node.id, entry)
      items.push(entry.item)
    }
    this.tree.load(items)
    this.orderDirty = true
  }

  // 差分に合わせて更新する。重なり順が変わったかどうかを返す
  applyPatch(patch: Patch<NodeRecord>): void {
    for (const [id, change] of patch) {
      const existing = this.entries.get(id)
      if (existing) {
        this.tree.remove(existing.item)
        this.entries.delete(id)
      }
      const node = change.after
      if (node && this.belongsHere(node)) {
        const entry = this.makeEntry(node)
        this.entries.set(id, entry)
        this.tree.insert(entry.item)
      }
      if (!existing || !node || existing.node.index !== node.index || existing.node.parentId !== node.parentId) {
        this.orderDirty = true
      }
    }
  }

  get(id: string): Entry | undefined {
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

  // 重なり順で最も手前にあるノード（新しいノードの index を決めるのに使う）
  topmost(): NodeRecord | undefined {
    this.ranks()
    const id = this.order.at(-1)
    return id ? this.entries.get(id)?.node : undefined
  }

  allIds(): string[] {
    this.ranks()
    return this.order
  }

  private ranks(): Map<string, number> {
    if (this.orderDirty) {
      // 段階 2 では Canvas 直下のノードだけを扱う。group / frame の入れ子は段階 5 で対応する
      this.order = [...this.entries.values()]
        .map((entry) => entry.node)
        .sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : a.id < b.id ? -1 : 1))
        .map((node) => node.id)
      this.orderRank = new Map(this.order.map((id, i) => [id, i]))
      this.orderDirty = false
    }
    return this.orderRank
  }

  private belongsHere(node: NodeRecord): boolean {
    return node.parentId === this.canvasId
  }

  private makeEntry(node: NodeRecord): Entry {
    const type = this.types.get(node.type)
    if (!type) throw new Error(`Unknown node type: ${node.type}`)
    const worldMatrix = multiply(IDENTITY, transformOf(node.x, node.y, node.rotation))
    const worldBounds = transformBox(worldMatrix, type.getBounds(node))
    return {
      node,
      worldMatrix,
      worldBounds,
      item: {
        minX: worldBounds.x,
        minY: worldBounds.y,
        maxX: worldBounds.x + worldBounds.w,
        maxY: worldBounds.y + worldBounds.h,
        id: node.id,
      },
    }
  }
}
