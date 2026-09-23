import {
  applyMat,
  invert,
  transformOf,
  unionBoxes,
  type Mat,
  type NodeRecord,
  type Vec,
} from '@canvcode/core'
import type { AnyNodeTypeDef } from '@canvcode/nodes'

// リサイズと回転の座標計算（MAI-23）。DOM に依存しない純粋な関数だけを置く。
//
// 選択枠（Frame）は「原点（枠の左上の角のワールド座標）・幅・高さ・回転」で表す。
// 1 つだけ選んでいるときは、ノードの向きに沿った枠。複数のときは、全体を囲む回転 0 の枠。

export interface Frame {
  x: number
  y: number
  w: number
  h: number
  rotation: number
}

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

// ハンドルが枠のどちら側にあるか（-1：左・上、0：中央、1：右・下）
export function handleSides(handle: Handle): { hx: -1 | 0 | 1; hy: -1 | 0 | 1 } {
  const hx = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0
  const hy = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0
  return { hx, hy }
}

export function frameMatrix(frame: Frame): Mat {
  return transformOf(frame.x, frame.y, frame.rotation)
}

export function frameCenter(frame: Frame): Vec {
  return applyMat(frameMatrix(frame), { x: frame.w / 2, y: frame.h / 2 })
}

// ハンドルのワールド座標
export function handlePosition(frame: Frame, handle: Handle): Vec {
  const { hx, hy } = handleSides(handle)
  return applyMat(frameMatrix(frame), { x: ((hx + 1) / 2) * frame.w, y: ((hy + 1) / 2) * frame.h })
}

// 索引の項目（ノードと、そのワールドの行列・ローカルの大きさ）
export interface NodeEntryLike {
  node: NodeRecord
  worldMatrix: Mat
  // ノードのローカル座標での大きさ（group は子から計算したもの）
  localBounds: { x: number; y: number; w: number; h: number }
  worldBounds: { x: number; y: number; w: number; h: number }
}

// ノードの向きに沿った枠（ワールド座標）
export function nodeFrame(entry: NodeEntryLike): Frame {
  const origin = applyMat(entry.worldMatrix, { x: entry.localBounds.x, y: entry.localBounds.y })
  const rotation = Math.atan2(entry.worldMatrix.b, entry.worldMatrix.a)
  return { x: origin.x, y: origin.y, w: entry.localBounds.w, h: entry.localBounds.h, rotation }
}

// 選択枠。1 つならノードの向きに沿った枠、複数なら全体を囲む枠
export function selectionFrame(entries: NodeEntryLike[]): Frame | null {
  if (entries.length === 0) return null
  if (entries.length === 1) return nodeFrame(entries[0])
  const box = unionBoxes(entries.map((entry) => entry.worldBounds))
  return box ? { ...box, rotation: 0 } : null
}

export interface ResizeOptions {
  keepAspect: boolean
  fromCenter: boolean
  minW: number
  minH: number
}

// ハンドルをワールド座標の点まで動かしたときの、新しい枠。
// 反対側の辺（fromCenter なら中心）を固定し、枠のローカル座標で計算する。
// 最小サイズより小さくはならない（反転はしない）。
export function resizeFrame(frame: Frame, handle: Handle, pointer: Vec, options: ResizeOptions): Frame {
  const { hx, hy } = handleSides(handle)
  const p = applyMat(invert(frameMatrix(frame)), pointer)
  const cx = frame.w / 2
  const cy = frame.h / 2

  // ハンドルのある側を動かした後の、縦と横の大きさ
  let w = frame.w
  let h = frame.h
  if (hx === 1) w = options.fromCenter ? (p.x - cx) * 2 : p.x
  if (hx === -1) w = options.fromCenter ? (cx - p.x) * 2 : frame.w - p.x
  if (hy === 1) h = options.fromCenter ? (p.y - cy) * 2 : p.y
  if (hy === -1) h = options.fromCenter ? (cy - p.y) * 2 : frame.h - p.y

  if (options.keepAspect && frame.w > 0 && frame.h > 0) {
    // 角なら大きく動かした方に合わせ、辺ならその辺の向きに合わせる
    const sx = w / frame.w
    const sy = h / frame.h
    const s = hx === 0 ? sy : hy === 0 ? sx : Math.max(sx, sy)
    const minS = Math.max(options.minW / frame.w, options.minH / frame.h)
    const scale = Math.max(s, minS)
    w = frame.w * scale
    h = frame.h * scale
  } else {
    w = Math.max(w, options.minW)
    h = Math.max(h, options.minH)
  }

  // 固定する側に合わせて、新しい枠の原点（ローカル座標）を決める。
  // ハンドルのない向き（辺のハンドルの横方向など）は、中心を保つ
  const x0 = options.fromCenter || hx === 0 ? cx - w / 2 : hx === 1 ? 0 : frame.w - w
  const y0 = options.fromCenter || hy === 0 ? cy - h / 2 : hy === 1 ? 0 : frame.h - h
  const origin = applyMat(frameMatrix(frame), { x: x0, y: y0 })
  return { x: origin.x, y: origin.y, w, h, rotation: frame.rotation }
}

const RIGHT_ANGLE_EPSILON = 1e-6

// 回転が 90° 刻みかどうか。0 / 180° なら 'straight'、90 / 270° なら 'turned'、それ以外は null
export function rightAngle(rotation: number): 'straight' | 'turned' | null {
  const quarter = rotation / (Math.PI / 2)
  const rounded = Math.round(quarter)
  if (Math.abs(quarter - rounded) > RIGHT_ANGLE_EPSILON) return null
  return rounded % 2 === 0 ? 'straight' : 'turned'
}

export interface ResizeTarget {
  node: NodeRecord
  frame: Frame
  type: AnyNodeTypeDef
}

// 枠を oldFrame から newFrame に変えたとき、各ノードをどう変えるか。
// 1 つだけなら、そのノードの枠を newFrame にする。
// 複数なら、枠の中での位置と大きさを比例させる（回転していないか 90° 刻みのものは縦横別々、
// 斜めのものは縦横比を保つ。呼び出し側は、斜めのものがあれば keepAspect で枠を計算しておく）。
// single は、選択が 1 つだけかどうか（複数選択のうちの一部だけを渡すときは false にする）
export function resizeNodes(
  targets: ResizeTarget[],
  oldFrame: Frame,
  newFrame: Frame,
  single = targets.length === 1,
): NodeRecord[] {
  if (single && targets.length === 1) {
    const { node, type } = targets[0]
    return [resizeNode(node, type, newFrame.x, newFrame.y, newFrame.w, newFrame.h)]
  }
  const sx = oldFrame.w > 0 ? newFrame.w / oldFrame.w : 1
  const sy = oldFrame.h > 0 ? newFrame.h / oldFrame.h : 1
  return targets.map(({ node, frame, type }) => {
    const x = newFrame.x + (frame.x - oldFrame.x) * sx
    const y = newFrame.y + (frame.y - oldFrame.y) * sy
    const angle = rightAngle(node.rotation)
    const [scaleW, scaleH] =
      angle === 'straight' ? [sx, sy] : angle === 'turned' ? [sy, sx] : [Math.sqrt(sx * sy), Math.sqrt(sx * sy)]
    if (!type.resize) return { ...node, x, y }
    return resizeNode(node, type, x, y, frame.w * scaleW, frame.h * scaleH)
  })
}

function resizeNode(node: NodeRecord, type: AnyNodeTypeDef, x: number, y: number, w: number, h: number): NodeRecord {
  if (!type.resize) return node
  const min = type.minSize ?? { w: 1, h: 1 }
  return {
    ...node,
    x,
    y,
    props: type.resize(node, { w: Math.max(w, min.w), h: Math.max(h, min.h) }),
  }
}

// 角度を -π〜π に収める
export function normalizeAngle(angle: number): number {
  const twoPi = Math.PI * 2
  let a = ((angle % twoPi) + twoPi) % twoPi
  if (a >= Math.PI) a -= twoPi
  return a
}

export const ROTATION_SNAP = Math.PI / 12 // 15°

// 回転の軸 pivot を中心に、各ノードを delta だけ回す
export function rotateNodes(nodes: NodeRecord[], pivot: Vec, delta: number): NodeRecord[] {
  const cos = Math.cos(delta)
  const sin = Math.sin(delta)
  return nodes.map((node) => {
    const dx = node.x - pivot.x
    const dy = node.y - pivot.y
    return {
      ...node,
      x: pivot.x + dx * cos - dy * sin,
      y: pivot.y + dx * sin + dy * cos,
      rotation: normalizeAngle(node.rotation + delta),
    }
  })
}

// 回した量。snap なら、1 つだけのときはノードの向きが、複数のときは回した量が 15° 刻みになるようにする
export function rotationDelta(
  pivot: Vec,
  start: Vec,
  pointer: Vec,
  snap: boolean,
  baseRotation: number | null,
): number {
  const raw = Math.atan2(pointer.y - pivot.y, pointer.x - pivot.x) - Math.atan2(start.y - pivot.y, start.x - pivot.x)
  if (!snap) return raw
  if (baseRotation === null) return Math.round(raw / ROTATION_SNAP) * ROTATION_SNAP
  const target = Math.round((baseRotation + raw) / ROTATION_SNAP) * ROTATION_SNAP
  return target - baseRotation
}

// ハンドルの上のカーソル。枠の回転に合わせて、いちばん近い向きの矢印を選ぶ
const CURSORS = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'] as const
const HANDLE_ANGLES: Record<Handle, number> = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 }

export function handleCursor(handle: Handle, rotation: number): string {
  const degrees = HANDLE_ANGLES[handle] + (rotation * 180) / Math.PI
  const step = Math.round((((degrees % 180) + 180) % 180) / 45) % 4
  return CURSORS[step]
}

// ---- 画面上のハンドル（描画と当たり判定で共通に使う） ----

// 回転のハンドルを、枠の上辺の中央からどれだけ離すか（CSS ピクセル）
export const ROTATE_HANDLE_OFFSET_PX = 24
// ハンドルの当たり判定の半径、辺の当たり判定の幅（CSS ピクセル）
const HANDLE_HIT_PX = 8
const EDGE_HIT_PX = 5

export interface ScreenHandles {
  frame: Frame
  // 枠の角（左上から時計回り）
  corners: Vec[]
  handles: { handle: Handle; point: Vec }[]
  rotate: Vec | null
}

export function screenHandles(
  frame: Frame,
  toScreen: (p: Vec) => Vec,
  options: { resize: boolean; rotate: boolean },
): ScreenHandles {
  const corners = (['nw', 'ne', 'se', 'sw'] as Handle[]).map((h) => toScreen(handlePosition(frame, h)))
  const handles = options.resize ? HANDLES.map((handle) => ({ handle, point: toScreen(handlePosition(frame, handle)) })) : []
  let rotate: Vec | null = null
  if (options.rotate) {
    const top = toScreen(handlePosition(frame, 'n'))
    // 枠の「上」の向き（画面上。カメラは回転しないので、枠の回転だけで決まる）
    const up = { x: Math.sin(frame.rotation), y: -Math.cos(frame.rotation) }
    rotate = { x: top.x + up.x * ROTATE_HANDLE_OFFSET_PX, y: top.y + up.y * ROTATE_HANDLE_OFFSET_PX }
  }
  return { frame, corners, handles, rotate }
}

export type HandleHit = { kind: 'resize'; handle: Handle } | { kind: 'rotate' }

// 画面上の点が、どのハンドルに当たっているか。回転 → 角 → 辺の中央 → 辺の順に調べる
export function hitHandle(handles: ScreenHandles, p: Vec): HandleHit | null {
  const near = (q: Vec, r: number) => Math.hypot(p.x - q.x, p.y - q.y) <= r
  if (handles.rotate && near(handles.rotate, HANDLE_HIT_PX + 1)) return { kind: 'rotate' }
  for (const { handle, point } of handles.handles) {
    if (handle.length === 2 && near(point, HANDLE_HIT_PX)) return { kind: 'resize', handle }
  }
  for (const { handle, point } of handles.handles) {
    if (handle.length === 1 && near(point, HANDLE_HIT_PX)) return { kind: 'resize', handle }
  }
  if (handles.handles.length === 0) return null
  // 辺のどこをつかんでもリサイズできる
  const edges: [Handle, Vec, Vec][] = [
    ['n', handles.corners[0], handles.corners[1]],
    ['e', handles.corners[1], handles.corners[2]],
    ['s', handles.corners[2], handles.corners[3]],
    ['w', handles.corners[3], handles.corners[0]],
  ]
  for (const [handle, a, b] of edges) {
    if (distanceToSegment(p, a, b) <= EDGE_HIT_PX) return { kind: 'resize', handle }
  }
  return null
}

export function distanceToSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length2 = dx * dx + dy * dy
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}
