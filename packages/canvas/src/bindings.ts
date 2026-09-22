import {
  IDENTITY,
  applyMat,
  createId,
  invert,
  isBindingRecord,
  multiply,
  transformOf,
  type ArrowBindingProps,
  type BindingRecord,
  type CanvasRecord,
  type Mat,
  type NodeRecord,
  type Transaction,
  type Vec,
} from '@canvcode/core'
import { arcGeometry, arcPoint, bendThrough, type ArcGeometry, type ArrowProps } from '@canvcode/nodes'
import type { Editor } from './editor.ts'

// 矢印とノードのつながり（MAI-7 の Binding、MAI-28）。
// - 矢印の「曲げる前の端」は、つながっている先のノードの中心（isPrecise なら anchor）に合わせる
// - 見える範囲（clip）は、つながっている先のノードの縁で切る
// どちらも、トランザクションの途中経過を知らせる直前（Store の beforeFlush）に計算し直すので、
// ノードをドラッグしている間も矢印がついてくる。計算した結果は矢印の props に入り、同じ Undo で戻る。

// ---- 索引 ----

// 矢印 → その端の Binding、つながっている先のノード → Binding。
// トランザクションの途中でも引けるよう、ストアのフックと知らせの両方で更新する（どちらから当てても同じ結果になる）
export class BindingIndex {
  private readonly byArrow = new Map<string, Set<string>>()
  private readonly byTarget = new Map<string, Set<string>>()

  apply(before: CanvasRecord | undefined, after: CanvasRecord | undefined): void {
    if (isBindingRecord(before)) {
      remove(this.byArrow, before.fromId, before.id)
      remove(this.byTarget, before.toId, before.id)
    }
    if (isBindingRecord(after)) {
      add(this.byArrow, after.fromId, after.id)
      add(this.byTarget, after.toId, after.id)
    }
  }

  get isEmpty(): boolean {
    return this.byArrow.size === 0
  }

  ofArrow(arrowId: string): string[] {
    return [...(this.byArrow.get(arrowId) ?? [])]
  }

  toTarget(nodeId: string): string[] {
    return [...(this.byTarget.get(nodeId) ?? [])]
  }
}

function remove(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key)
  if (!set) return
  set.delete(value)
  if (set.size === 0) map.delete(key)
}

function add(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key)
  if (!set) {
    set = new Set()
    map.set(key, set)
  }
  set.add(value)
}

// ---- 位置の計算 ----

// ストアの今の値から、ノードのローカル座標 → ワールド座標の行列を作る（索引は途中経過の知らせまで古いままなので使わない）
function liveWorldMatrix(editor: Editor, id: string): Mat | null {
  let node = editor.getNode(id)
  if (!node) return null
  let m = transformOf(node.x, node.y, node.rotation)
  for (let guard = 0; guard < 10_000 && node.parentId !== editor.canvasId; guard++) {
    const parent = editor.getNode(node.parentId)
    if (!parent) return null
    m = multiply(transformOf(parent.x, parent.y, parent.rotation), m)
    node = parent
  }
  return m
}

function liveParentMatrix(editor: Editor, node: NodeRecord): Mat {
  return node.parentId === editor.canvasId ? IDENTITY : (liveWorldMatrix(editor, node.parentId) ?? IDENTITY)
}

// ノードの縁（ローカル座標の多角形）
function outlineOf(editor: Editor, node: NodeRecord): Vec[] {
  const type = editor.getType(node)
  if (type.outline) return type.outline(node)
  const b = type.getBounds(node)
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h },
  ]
}

function insidePolygon(polygon: Vec[], p: Vec): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

// ワールド座標の点を、つながっている先のノードの箱の中での位置（0〜1）にする
export function normalizedAnchorAt(editor: Editor, target: NodeRecord, world: Vec): Vec {
  const m = liveWorldMatrix(editor, target.id) ?? IDENTITY
  const local = applyMat(invert(m), world)
  const b = editor.getType(target).getBounds(target)
  return {
    x: b.w > 0 ? Math.max(0, Math.min(1, (local.x - b.x) / b.w)) : 0.5,
    y: b.h > 0 ? Math.max(0, Math.min(1, (local.y - b.y) / b.h)) : 0.5,
  }
}

// Binding が向いている点（ワールド座標）
function bindingPoint(editor: Editor, target: NodeRecord, props: ArrowBindingProps): Vec | null {
  const m = liveWorldMatrix(editor, target.id)
  if (!m) return null
  const b = editor.getType(target).getBounds(target)
  const anchor = props.isPrecise ? props.normalizedAnchor : { x: 0.5, y: 0.5 }
  return applyMat(m, { x: b.x + b.w * anchor.x, y: b.y + b.h * anchor.y })
}

const CLIP_SAMPLES = 64
const CLIP_BISECT = 12

// 円弧の上を from（0 か 1）から進んで、inside の外に出る位置。from がもう外なら from、最後まで出なければ null
function exitParam(g: ArcGeometry, from: 0 | 1, inside: (p: Vec) => boolean): number | null {
  if (!inside(arcPoint(g, from))) return from
  const dir = from === 0 ? 1 : -1
  let prev: number = from
  for (let i = 1; i <= CLIP_SAMPLES; i++) {
    const t = from + (dir * i) / CLIP_SAMPLES
    if (!inside(arcPoint(g, t))) {
      // prev（中）と t（外）の間を二分して、縁の位置を詰める
      let lo = prev
      let hi = t
      for (let k = 0; k < CLIP_BISECT; k++) {
        const mid = (lo + hi) / 2
        if (inside(arcPoint(g, mid))) lo = mid
        else hi = mid
      }
      return hi
    }
    prev = t
  }
  return null
}

// 矢印の Binding から、曲げる前の端と見える範囲を計算し直す。変わらなければ null
export function resolveArrow(editor: Editor, arrow: NodeRecord<ArrowProps>, bindings: BindingRecord[]): ArrowProps | null {
  const props = arrow.props
  const toLocal = invert(multiply(liveParentMatrix(editor, arrow), transformOf(arrow.x, arrow.y, arrow.rotation)))
  const toWorld = invert(toLocal)
  let start = props.start
  let end = props.end
  const targets: { terminal: 'start' | 'end'; node: NodeRecord }[] = []
  for (const binding of bindings) {
    const target = editor.getNode(binding.toId)
    if (!target) continue
    const point = bindingPoint(editor, target, binding.props)
    if (!point) continue
    const local = applyMat(toLocal, point)
    if (binding.props.terminal === 'start') start = local
    else end = local
    targets.push({ terminal: binding.props.terminal, node: target })
  }

  let clip: [number, number] = [0, 1]
  if (targets.length > 0) {
    const g = arcGeometry(start, end, props.bend)
    let t0 = 0
    let t1 = 1
    for (const { terminal, node } of targets) {
      // 矢印のローカル座標の点を、つながっている先のノードのローカル座標にして、縁の内側かを調べる
      const m = multiply(invert(liveWorldMatrix(editor, node.id) ?? IDENTITY), toWorld)
      const polygon = outlineOf(editor, node)
      const inside = (p: Vec) => insidePolygon(polygon, applyMat(m, p))
      const t = exitParam(g, terminal === 'start' ? 0 : 1, inside)
      if (t === null) continue
      if (terminal === 'start') t0 = t
      else t1 = t
    }
    // 重なったノードどうしをつないだときなど、見える部分がなくなるなら、端から端まで描く
    clip = t0 < t1 ? [t0, t1] : [0, 1]
  }

  if (samePoint(start, props.start) && samePoint(end, props.end) && props.clip[0] === clip[0] && props.clip[1] === clip[1]) {
    return null
  }
  return { ...props, start, end, clip }
}

function samePoint(a: Vec, b: Vec): boolean {
  return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9
}

// つながりを外した端を、今見えている位置に固定する（外したあとも矢印の見た目が変わらないように）
export function freezeTerminal(props: ArrowProps, terminal: 'start' | 'end'): ArrowProps {
  const g = arcGeometry(props.start, props.end, props.bend)
  const [t0, t1] = props.clip
  if (terminal === 'start') {
    const start = arcPoint(g, t0)
    const bend = bendThrough(start, props.end, arcPoint(g, (t0 + 1) / 2))
    // 残った側の範囲は、次の計算で付け直される
    return { ...props, start, bend, clip: [0, t1 >= 1 ? 1 : (t1 - t0) / (1 - t0)] }
  }
  const end = arcPoint(g, t1)
  const bend = bendThrough(props.start, end, arcPoint(g, t1 / 2))
  return { ...props, end, bend, clip: [t0 <= 0 ? 0 : t0 / t1, 1] }
}

// ---- 操作 ----

export function makeBinding(arrowId: string, toId: string, props: ArrowBindingProps): BindingRecord {
  return { typeName: 'binding', id: createId('binding'), type: 'arrow', fromId: arrowId, toId, props }
}

// Binding を外す。矢印が残っていれば、その端を今見えている位置に固定する
export function unbind(tx: Transaction<CanvasRecord>, binding: BindingRecord): void {
  const arrow = tx.get(binding.fromId)
  if (arrow?.typeName === 'node' && arrow.type === 'arrow') {
    const node = arrow as NodeRecord<ArrowProps>
    tx.put({ ...node, props: freezeTerminal(node.props, binding.props.terminal) })
  }
  tx.remove(binding.id)
}

// ワールド座標の点の下にある、矢印をつなげられる最も手前のノード（exclude は除く）。
// ノードの縁の内側にあればよい（フレームの中の空いている所も含む。フレームの子は手前にあるので先に見つかる）
export function bindTargetAt(editor: Editor, point: Vec, exclude: string | null): string | null {
  const ids = editor.index.sortByOrder(editor.index.search({ x: point.x, y: point.y, w: 0, h: 0 }))
  for (let i = ids.length - 1; i >= 0; i--) {
    const entry = editor.index.get(ids[i])
    if (!entry || ids[i] === exclude || entry.node.locked) continue
    const type = editor.getType(entry.node)
    if (type.canBind === false) continue
    // フレームの外にはみ出して見えない部分には、つながない
    const clipped = editor.index.ancestorsOf(ids[i]).some((a) => {
      const frame = editor.index.get(a)
      if (!frame || !editor.isContainer(frame.node, 'frame')) return false
      return !insidePolygon(outlineOf(editor, frame.node), applyMat(invert(frame.worldMatrix), point))
    })
    if (clipped) continue
    if (insidePolygon(outlineOf(editor, entry.node), applyMat(invert(entry.worldMatrix), point))) return ids[i]
  }
  return null
}
