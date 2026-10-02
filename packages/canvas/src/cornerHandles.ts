import { applyMat, dist, invert, worldToScreen, type NodeRecord, type Transaction, type Vec, type WorkspaceRecord } from '@canvcode/core'
import { canRoundCorners, cornerRadii, effectiveCornerRadii, toCornerRadius, type CornerRadii, type GeoProps } from '@canvcode/nodes'
import { nodeIn, type Editor } from './editor.ts'
import { paintEditingTarget } from './gradientHandles.ts'

// 角丸のハンドル（MAI-84）。角丸を持てる図形（矩形）を 1 つだけ選び、ポインタがその図形の上にあるとき（Figma と同じ。
// session.cornerHandlesId。選択ツールがポインタの動きで決める）、4 つの角の内側に小さな丸いハンドルを出す。
// - ハンドルは角から対角線の向きに、半径（箱に収めたもの）だけ内側。半径が小さいときも角から CORNER_HANDLE_MIN_INSET_PX は離し、
//   リサイズの角のハンドル・辺の当たり判定と重ならないようにする。大きいときは図形の中心の手前で止める
// - 図形が画面上で小さすぎる（短い辺が CORNER_HANDLE_MIN_SIZE_PX 未満。ズームアウト時など）ときは出さない
// - 文字の編集中・塗りのグラデーションの編集中（MAI-82。そのハンドルだけを出す）・ロック中は出さない
// - ドラッグは対角線に沿って半径を変える（動かした量だけ。つかんだ位置で跳ねない）。4 つの角を一緒に変え、Alt を押している間は
//   つかんだ角だけを変える（Figma と同じ）。半径は短い辺の半分まで。1 つのトランザクション（Undo 1 回）
// - 描画と当たり判定で同じ位置を使う（renderer.ts の drawCornerHandles と、tools.ts の SelectTool）

// ハンドルを角から離す最小の距離（縦横それぞれ。CSS ピクセル）
export const CORNER_HANDLE_MIN_INSET_PX = 12
// ハンドルを出す、図形の短い辺の画面上の最小の長さ（CSS ピクセル）
export const CORNER_HANDLE_MIN_SIZE_PX = 60
// ハンドルをつかめる範囲（CSS ピクセル）
export const CORNER_HANDLE_HIT_PX = 6
// ハンドルの丸の半径（CSS ピクセル）
export const CORNER_HANDLE_RADIUS_PX = 4

// 角（左上・右上・右下・左下）から内側への向き
const INWARD: readonly Vec[] = [
  { x: 1, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: -1 },
  { x: 1, y: -1 },
]

export interface CornerHandles {
  nodeId: string
  // 4 つの角のハンドル（画面上の位置。CSS ピクセル）。番号は CornerRadii の番号
  points: Vec[]
  // 箱に収めた半径
  radii: CornerRadii
}

// 角丸のハンドルを出せる図形（ポインタの位置は見ない）。出せないときは null
export function cornerRadiusTarget(editor: Editor): NodeRecord<GeoProps> | null {
  const { selectedIds, editingId, camera } = editor.session.get()
  if (editingId || selectedIds.size !== 1 || paintEditingTarget(editor)) return null
  const [id] = selectedIds
  const entry = editor.index.get(id)
  if (!entry || entry.node.locked || !canRoundCorners(entry.node)) return null
  const { w, h } = entry.node.props
  if (Math.min(w, h) * camera.zoom < CORNER_HANDLE_MIN_SIZE_PX) return null
  return entry.node
}

// 角の位置（ローカル座標）
function cornerPoint(props: GeoProps, corner: number): Vec {
  return { x: corner === 1 || corner === 2 ? props.w : 0, y: corner >= 2 ? props.h : 0 }
}

// ポインタ（ワールド座標）が、ハンドルを出せる図形の上（ハンドルをつかめる幅だけ広げた箱の中）にあれば、その図形の id
export function cornerHandlesFor(editor: Editor, world: Vec): string | null {
  const node = cornerRadiusTarget(editor)
  const entry = node && editor.index.get(node.id)
  if (!node || !entry) return null
  const local = applyMat(invert(entry.worldMatrix), world)
  const margin = CORNER_HANDLE_HIT_PX / editor.session.get().camera.zoom
  const { w, h } = node.props
  return local.x >= -margin && local.y >= -margin && local.x <= w + margin && local.y <= h + margin ? node.id : null
}

// ポインタを合わせてあれば出す
export function updateCornerHandles(editor: Editor, world: Vec): void {
  const id = cornerHandlesFor(editor, world)
  if (id !== editor.session.get().cornerHandlesId) editor.session.set({ cornerHandlesId: id })
}

export function cornerHandles(editor: Editor): CornerHandles | null {
  const node = cornerRadiusTarget(editor)
  if (!node || editor.session.get().cornerHandlesId !== node.id) return null
  const entry = editor.index.get(node.id)!
  const camera = editor.session.get().camera
  const { w, h } = node.props
  const radii = effectiveCornerRadii(node.props.cornerRadius, w, h)
  const min = CORNER_HANDLE_MIN_INSET_PX / camera.zoom
  // 中心の手前で止める（4 つのハンドルが重ならないよう、中心から縦横 CORNER_HANDLE_HIT_PX 以上は離す）
  const max = Math.max(min, Math.min(w, h) / 2 - CORNER_HANDLE_HIT_PX / camera.zoom)
  const points = radii.map((r, corner) => {
    const inset = Math.min(max, Math.max(min, r))
    const at = cornerPoint(node.props, corner)
    const local = { x: at.x + INWARD[corner].x * inset, y: at.y + INWARD[corner].y * inset }
    return worldToScreen(camera, applyMat(entry.worldMatrix, local))
  })
  return { nodeId: node.id, points, radii }
}

// 画面上の点 screen にあるハンドル（いちばん近いもの）
export function hitCornerHandle(editor: Editor, screen: Vec): { nodeId: string; corner: number } | null {
  const handles = cornerHandles(editor)
  if (!handles) return null
  let best = -1
  let bestDistance = CORNER_HANDLE_HIT_PX
  handles.points.forEach((point, corner) => {
    const d = dist(point, screen)
    if (d <= bestDistance) {
      best = corner
      bestDistance = d
    }
  })
  return best >= 0 ? { nodeId: handles.nodeId, corner: best } : null
}

// 角の半径を変えた props。single なら corner の角だけ、そうでなければ 4 つの角を radius にする
export function withCornerRadius(props: GeoProps, corner: number, radius: number, single: boolean): GeoProps {
  const r = Math.max(0, radius)
  if (!single) return props.cornerRadius === r ? props : { ...props, cornerRadius: r }
  const radii = cornerRadii(props.cornerRadius)
  radii[corner] = r
  return { ...props, cornerRadius: toCornerRadius(radii) }
}

// ハンドルのドラッグ。begin で作ったトランザクションに書き、終わりは呼ぶ側が finish・cancel する
export class CornerRadiusDrag {
  private readonly editor: Editor
  private readonly tx: Transaction<WorkspaceRecord>
  readonly nodeId: string
  readonly corner: number
  // つかんだときの図形と、そのときの半径（箱に収めたもの）・対角線上の位置
  private readonly initial: NodeRecord<GeoProps>
  private readonly startRadius: number
  private readonly startDepth: number

  constructor(editor: Editor, tx: Transaction<WorkspaceRecord>, nodeId: string, corner: number, world: Vec) {
    this.editor = editor
    this.tx = tx
    this.nodeId = nodeId
    this.corner = corner
    this.initial = nodeIn(tx, nodeId) as NodeRecord<GeoProps>
    const { w, h, cornerRadius } = this.initial.props
    this.startRadius = effectiveCornerRadii(cornerRadius, w, h)[corner]
    this.startDepth = this.depth(world)
  }

  // ポインタ（ワールド座標）の、角から対角線に沿って内側への深さ（縦横それぞれの量）
  private depth(world: Vec): number {
    const entry = this.editor.index.get(this.nodeId)
    if (!entry) return 0
    const local = applyMat(invert(entry.worldMatrix), world)
    const at = cornerPoint(this.initial.props, this.corner)
    const inward = INWARD[this.corner]
    return ((local.x - at.x) * inward.x + (local.y - at.y) * inward.y) / 2
  }

  // 今の半径（ドラッグで決めたもの）
  radius(world: Vec): number {
    const { w, h } = this.initial.props
    const raw = this.startRadius + this.depth(world) - this.startDepth
    return Math.round(Math.min(Math.max(raw, 0), Math.min(w, h) / 2))
  }

  // world はポインタのワールド座標。single（Alt）なら、つかんだ角だけを変える
  move(world: Vec, single: boolean): void {
    const current = nodeIn(this.tx, this.nodeId) as NodeRecord<GeoProps> | undefined
    if (!current) return
    const props = withCornerRadius(this.initial.props, this.corner, this.radius(world), single)
    if (props === current.props) return
    this.tx.put({ ...current, props: { ...current.props, cornerRadius: props.cornerRadius } })
    this.tx.flush()
  }
}
