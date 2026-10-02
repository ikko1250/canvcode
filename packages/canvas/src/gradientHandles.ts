import { applyMat, dist, invert, worldToScreen, type Box, type NodeRecord, type Transaction, type Vec, type WorkspaceRecord } from '@canvcode/core'
import { clamp01, colorAtPosition, gradientStop, isGradientPaint, sortStops, toFill, type GradientPaint, type GradientStop } from '@canvcode/nodes'
import { nodeIn, type Editor } from './editor.ts'
import { distanceToSegment } from './transform.ts'

// グラデーションのハンドル（MAI-82）。塗りを編集している間（session.paintEditing。デザインパネルでグラデーションの塗りを開いている間）、
// 選んでいる図形の上に、線形なら始点・終点、円形なら中心・半径のハンドルと、その間の線の上に止め色（stop）のハンドルを出す。
// - 位置は塗り（paint.ts）と同じく箱に対する割合で持つので、ノードのワールド行列で写すだけで、回転・大きさの変更に付いてくる
// - 編集している間は、図形のリサイズ・回転のハンドルを出さない（selectionHandles。Figma と同じ。始点・終点が辺の中点のハンドルと重なるので）
// - ドラッグは 1 つのトランザクション（Undo 1 回）。止め色は線の上を動かす。線の上（ハンドルのない所）をクリックすると止め色を足す
// - 描画と当たり判定で同じ位置を使う（renderer.ts の drawGradientHandles と、tools.ts の SelectTool）

// 塗りを編集している図形と、選んでいる止め色の番号（stops の並び＝位置の順での番号）
export interface PaintEditing {
  nodeId: string
  stop: number
}

export interface GradientHandles {
  nodeId: string
  paint: GradientPaint
  // 線形の始点・終点、円形の中心・半径（画面上の位置。CSS ピクセル）
  start: Vec
  end: Vec
  // 止め色（画面上の位置）。番号は stops の番号
  stops: { index: number; point: Vec; stop: GradientStop }[]
  selectedStop: number
}

export type GradientHandleHit = { handle: 'start' | 'end' } | { handle: 'stop'; index: number } | { handle: 'line'; position: number }

// ハンドルをつかめる範囲（CSS ピクセル）
export const GRADIENT_HANDLE_HIT_PX = 8
// 線の上をクリックして止め色を足せる範囲（CSS ピクセル）
const GRADIENT_LINE_HIT_PX = 4

// 塗りを編集している図形の、塗り・箱・ワールド行列。編集していない・選び方が違う・グラデーションでないときは null
export function paintEditingTarget(editor: Editor): { node: NodeRecord; paint: GradientPaint; box: Box; editing: PaintEditing } | null {
  const { paintEditing, selectedIds, editingId } = editor.session.get()
  if (!paintEditing || editingId || selectedIds.size !== 1 || !selectedIds.has(paintEditing.nodeId)) return null
  const entry = editor.index.get(paintEditing.nodeId)
  if (!entry || entry.node.locked) return null
  const paint = toFill((entry.node.props as { fill?: unknown }).fill)
  if (!isGradientPaint(paint)) return null
  const box = entry.localBounds
  if (box.w <= 0 || box.h <= 0) return null
  return { node: entry.node, paint, box, editing: paintEditing }
}

// 箱に対する割合の点 → ローカル座標
function localOf(box: Box, p: Vec): Vec {
  return { x: box.x + p.x * box.w, y: box.y + p.y * box.h }
}

// 線形は始点・終点、円形は中心と、中心から（ローカルの）右へ半径の点
export function gradientEnds(paint: GradientPaint): { start: Vec; end: Vec } {
  if (paint.type === 'linear') return { start: paint.start, end: paint.end }
  return { start: paint.center, end: { x: paint.center.x + paint.radius, y: paint.center.y } }
}

export function gradientHandles(editor: Editor): GradientHandles | null {
  const target = paintEditingTarget(editor)
  if (!target) return null
  const entry = editor.index.get(target.node.id)!
  const camera = editor.session.get().camera
  const toScreen = (p: Vec) => worldToScreen(camera, applyMat(entry.worldMatrix, localOf(target.box, p)))
  const ends = gradientEnds(target.paint)
  const start = toScreen(ends.start)
  const end = toScreen(ends.end)
  const stops = target.paint.stops.map((stop, index) => ({
    index,
    stop,
    point: { x: start.x + (end.x - start.x) * stop.position, y: start.y + (end.y - start.y) * stop.position },
  }))
  return { nodeId: target.node.id, paint: target.paint, start, end, stops, selectedStop: target.editing.stop }
}

// 画面上の点 screen にあるハンドル。始点・終点を止め色より先に調べる（位置 0・1 の止め色と重なるので。
// その止め色は、パネルの帯で動かす）。止め色は選んでいるものを先に調べる
export function hitGradientHandle(editor: Editor, screen: Vec): { handles: GradientHandles; hit: GradientHandleHit } | null {
  const handles = gradientHandles(editor)
  if (!handles) return null
  for (const handle of ['start', 'end'] as const) {
    if (dist(handles[handle], screen) <= GRADIENT_HANDLE_HIT_PX) return { handles, hit: { handle } }
  }
  const order = [...handles.stops].sort((a, b) => Number(b.index === handles.selectedStop) - Number(a.index === handles.selectedStop))
  for (const { index, point } of order) {
    if (dist(point, screen) <= GRADIENT_HANDLE_HIT_PX) return { handles, hit: { handle: 'stop', index } }
  }
  if (distanceToSegment(screen, handles.start, handles.end) <= GRADIENT_LINE_HIT_PX) {
    return { handles, hit: { handle: 'line', position: projectOnSegment(screen, handles.start, handles.end) } }
  }
  return null
}

// 点を線分 a→b に写したときの位置（0〜1）
export function projectOnSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return 0
  return clamp01(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)
}

// 止め色を 1 つ動かしたあとの並びと、その止め色の新しい番号（位置の順に並べ直すので、番号が変わることがある）
export function moveStop(stops: readonly GradientStop[], index: number, position: number): { stops: GradientStop[]; index: number } {
  const moved = { ...stops[index], position: clamp01(position) }
  const next = stops.map((stop, i) => (i === index ? moved : stop))
  const sorted = sortStops(next)
  return { stops: sorted, index: sorted.indexOf(moved) }
}

// 位置 position に止め色を足す（色は、その位置のグラデーションの色）
export function addStop(stops: readonly GradientStop[], position: number): { stops: GradientStop[]; index: number } {
  const { color, opacity } = colorAtPosition(stops, position)
  const added = gradientStop(position, color, opacity)
  const sorted = sortStops([...stops, added])
  return { stops: sorted, index: sorted.indexOf(added) }
}

// 止め色を消す。2 つより少なくはしない（null）
export function removeStop(stops: readonly GradientStop[], index: number): { stops: GradientStop[]; index: number } | null {
  if (stops.length <= 2 || index < 0 || index >= stops.length) return null
  return { stops: stops.filter((_, i) => i !== index), index: Math.min(index, stops.length - 2) }
}

// ノードの塗りを書き換える（fill を持つ図形だけ）
export function withFill(node: NodeRecord, paint: GradientPaint): NodeRecord {
  return { ...node, props: { ...(node.props as object), fill: paint } }
}

// 選んでいる止め色を消す（塗りの編集中の Delete。MAI-82）。消せたら true
export function removeSelectedStop(editor: Editor): boolean {
  const target = paintEditingTarget(editor)
  if (!target) return false
  const removed = removeStop(target.paint.stops, target.editing.stop)
  if (!removed) return false
  editor.transact('remove gradient stop', (tx) => {
    tx.put(withFill(target.node, { ...target.paint, stops: removed.stops }))
  })
  editor.session.set({ paintEditing: { ...target.editing, stop: removed.index } })
  return true
}

// ハンドルのドラッグ。begin で作ったトランザクションに書き、終わりは呼ぶ側が finish・cancel する
export class GradientHandleDrag {
  private readonly editor: Editor
  private readonly tx: Transaction<WorkspaceRecord>
  private readonly nodeId: string
  private readonly hit: GradientHandleHit
  private stopIndex: number

  constructor(editor: Editor, tx: Transaction<WorkspaceRecord>, nodeId: string, hit: GradientHandleHit) {
    this.editor = editor
    this.tx = tx
    this.nodeId = nodeId
    this.hit = hit
    this.stopIndex = hit.handle === 'stop' ? hit.index : -1
    if (hit.handle === 'stop') this.select(hit.index)
    // 線の上を押したら、そこに止め色を足して、そのまま動かせるようにする
    if (hit.handle === 'line') {
      const current = this.current()
      if (current) {
        const added = addStop(current.paint.stops, hit.position)
        this.write(current.node, { ...current.paint, stops: added.stops })
        this.stopIndex = added.index
        this.select(added.index)
      }
    }
  }

  private current(): { node: NodeRecord; paint: GradientPaint; box: Box; matrix: ReturnType<typeof invert> } | null {
    const node = nodeIn(this.tx, this.nodeId)
    const entry = this.editor.index.get(this.nodeId)
    if (!node || !entry) return null
    const paint = toFill((node.props as { fill?: unknown }).fill)
    if (!isGradientPaint(paint)) return null
    return { node, paint, box: entry.localBounds, matrix: invert(entry.worldMatrix) }
  }

  private write(node: NodeRecord, paint: GradientPaint): void {
    this.tx.put(withFill(node, paint))
    this.tx.flush()
  }

  private select(stop: number): void {
    const editing = this.editor.session.get().paintEditing
    if (editing && editing.stop !== stop) this.editor.session.set({ paintEditing: { ...editing, stop } })
  }

  // world はポインタのワールド座標。snap（Shift）なら、線形の向きを 15° 刻みにする
  move(world: Vec, snap = false): void {
    const current = this.current()
    if (!current) return
    const { node, paint, box, matrix } = current
    const local = applyMat(matrix, world)
    const rel = { x: (local.x - box.x) / box.w, y: (local.y - box.y) / box.h }
    const round = (v: number) => Math.round(v * 1e4) / 1e4
    const point = { x: round(rel.x), y: round(rel.y) }
    const ends = gradientEnds(paint)
    if (this.hit.handle === 'start' || this.hit.handle === 'end') {
      if (paint.type === 'linear') {
        const fixed = this.hit.handle === 'start' ? paint.end : paint.start
        const moved = snap ? snapDirection(fixed, point, box) : point
        this.write(node, this.hit.handle === 'start' ? { ...paint, start: moved } : { ...paint, end: moved })
      } else if (this.hit.handle === 'start') {
        this.write(node, { ...paint, center: point })
      } else {
        this.write(node, { ...paint, radius: round(Math.hypot(point.x - paint.center.x, point.y - paint.center.y)) })
      }
      return
    }
    if (this.stopIndex < 0) return
    // 止め色：始点→終点の線に写した位置（箱の実際の大きさで測る）
    const a = { x: ends.start.x * box.w, y: ends.start.y * box.h }
    const b = { x: ends.end.x * box.w, y: ends.end.y * box.h }
    const position = round(projectOnSegment({ x: rel.x * box.w, y: rel.y * box.h }, a, b))
    const moved = moveStop(paint.stops, this.stopIndex, position)
    this.stopIndex = moved.index
    this.write(node, { ...paint, stops: moved.stops })
    this.select(moved.index)
  }
}

// fixed から point への向きを、箱の実際の大きさで見て 15° 刻みにする（長さはそのまま）
function snapDirection(fixed: Vec, point: Vec, box: Box): Vec {
  const dx = (point.x - fixed.x) * box.w
  const dy = (point.y - fixed.y) * box.h
  const length = Math.hypot(dx, dy)
  const step = Math.PI / 12
  const angle = Math.round(Math.atan2(dy, dx) / step) * step
  const round = (v: number) => Math.round(v * 1e4) / 1e4
  return { x: round(fixed.x + (Math.cos(angle) * length) / box.w), y: round(fixed.y + (Math.sin(angle) * length) / box.h) }
}
