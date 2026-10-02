import { applyMat, dist, invert, worldToScreen, type NodeRecord, type Transaction, type Vec, type WorkspaceRecord } from '@canvcode/core'
import {
  blockArrowGeometry,
  blockArrowParams,
  blockArrowRef,
  clampBlockArrowRatio,
  isBlockArrow,
  type BlockArrowGeometry,
  type BlockArrowShape,
  type GeoProps,
} from '@canvcode/nodes'
import { nodeIn, type Editor } from './editor.ts'
import { paintEditingTarget } from './gradientHandles.ts'

// ブロック矢印の形のハンドル（MAI-87）。ブロック矢印の図形を 1 つだけ選んでいるとき、形の上に小さなひし形のハンドルを出す
// （PowerPoint の調整ハンドルと同じ。角丸のハンドル（cornerHandles.ts）と違い、ホバーしていなくても出す）。
// - 軸（shaft）：軸の太さ。まっすぐな矢印は軸の上の縁の真ん中（上下に動かす。軸は上下対称に太る）、
//   曲がった矢印は縦の軸の右の縁（左右に動かす）
// - 矢じり（head）：矢じりの根もとの角。左右で矢じりの長さ、上下で矢じりの幅（まっすぐな矢印は上下対称）。
//   シェブロンは切り込みの先（左右で切り込みの深さ）だけ
// - ドラッグは動かした量だけ値を変える（つかんだ位置で跳ねない）。値は箱に対する割合で書く（blockArrow.ts）。1 つのトランザクション（Undo 1 回）
// - 画面に出す位置は、箱の縁から BLOCK_ARROW_HANDLE_MIN_INSET_PX は内側に収め、リサイズの角・辺の当たり判定と重ならないようにする
//   （値が箱の縁にある（矢じりの幅が箱の高さいっぱいなど）ときも、つかめる）。当たり判定は選択枠のハンドルより先に調べる
// - 図形が画面上で小さすぎるとき（短い辺が BLOCK_ARROW_HANDLE_MIN_SIZE_PX 未満）・文字の編集中・グラデーションの編集中・ロック中は出さない
// - 描画と当たり判定で同じ位置を使う（renderer.ts の drawBlockArrowHandles と、tools.ts の SelectTool）

export const BLOCK_ARROW_HANDLE_MIN_SIZE_PX = 40
export const BLOCK_ARROW_HANDLE_MIN_INSET_PX = 10
export const BLOCK_ARROW_HANDLE_HIT_PX = 6
// ひし形の中心から角までの長さ（CSS ピクセル）
export const BLOCK_ARROW_HANDLE_SIZE_PX = 5

export type BlockArrowHandleKind = 'shaft' | 'head'

export interface BlockArrowHandle {
  kind: BlockArrowHandleKind
  // 画面上の位置（CSS ピクセル）
  point: Vec
}

export interface BlockArrowHandles {
  nodeId: string
  handles: BlockArrowHandle[]
}

// ハンドルを出せるブロック矢印。出せないときは null
export function blockArrowTarget(editor: Editor): NodeRecord<GeoProps> | null {
  const { selectedIds, editingId, camera } = editor.session.get()
  if (editingId || selectedIds.size !== 1 || paintEditingTarget(editor)) return null
  const [id] = selectedIds
  const entry = editor.index.get(id)
  if (!entry || entry.node.locked || !isBlockArrow(entry.node)) return null
  const { w, h } = entry.node.props
  if (Math.min(w, h) * camera.zoom < BLOCK_ARROW_HANDLE_MIN_SIZE_PX) return null
  return entry.node
}

function geometryOf(props: GeoProps): BlockArrowGeometry {
  const shape = props.shape as BlockArrowShape
  return blockArrowGeometry(shape, props.w, props.h, blockArrowParams(shape, props))
}

// ハンドルの位置（ローカル座標。値そのものの位置）
export function blockArrowHandlePoints(g: BlockArrowGeometry): { kind: BlockArrowHandleKind; point: Vec }[] {
  const { w, h, shaft, headLength, headWidth } = g
  switch (g.shape) {
    case 'blockArrow':
    case 'blockArrowBoth': {
      const left = g.shape === 'blockArrowBoth' ? headLength : 0
      const back = w - headLength
      return [
        { kind: 'shaft', point: { x: (left + back) / 2, y: h / 2 - shaft / 2 } },
        { kind: 'head', point: { x: back, y: h / 2 - headWidth / 2 } },
      ]
    }
    case 'blockArrowBent': {
      const bottom = headWidth / 2 + shaft / 2
      return [
        { kind: 'shaft', point: { x: shaft, y: (bottom + h) / 2 } },
        { kind: 'head', point: { x: w - headLength, y: headWidth } },
      ]
    }
    case 'chevron':
      return [{ kind: 'head', point: { x: headLength, y: h / 2 } }]
  }
}

export function blockArrowHandles(editor: Editor): BlockArrowHandles | null {
  const node = blockArrowTarget(editor)
  const entry = node && editor.index.get(node.id)
  if (!node || !entry) return null
  const camera = editor.session.get().camera
  const { w, h } = node.props
  const inset = BLOCK_ARROW_HANDLE_MIN_INSET_PX / camera.zoom
  // 箱の縁から inset だけ内側に収める（箱が小さければ真ん中）
  const fit = (v: number, size: number) => (size <= inset * 2 ? size / 2 : Math.min(size - inset, Math.max(inset, v)))
  const handles = blockArrowHandlePoints(geometryOf(node.props)).map(({ kind, point }) => ({
    kind,
    point: worldToScreen(camera, applyMat(entry.worldMatrix, { x: fit(point.x, w), y: fit(point.y, h) })),
  }))
  return { nodeId: node.id, handles }
}

// 画面上の点 screen にあるハンドル（いちばん近いもの）
export function hitBlockArrowHandle(editor: Editor, screen: Vec): { nodeId: string; kind: BlockArrowHandleKind } | null {
  const found = blockArrowHandles(editor)
  if (!found) return null
  let best: BlockArrowHandleKind | null = null
  let bestDistance = BLOCK_ARROW_HANDLE_HIT_PX
  for (const handle of found.handles) {
    const d = dist(handle.point, screen)
    if (d <= bestDistance) {
      best = handle.kind
      bestDistance = d
    }
  }
  return best ? { nodeId: found.nodeId, kind: best } : null
}

const RATIO_DIGITS = 1e4

// 形の px の値（軸の太さ・矢じりの長さ・幅）を、箱に対する割合の props にする（変えたものだけ）
export function withBlockArrowSizes(props: GeoProps, sizes: { shaft?: number; headLength?: number; headWidth?: number }): GeoProps {
  const shape = props.shape as BlockArrowShape
  const ref = blockArrowRef(shape, props.w, props.h)
  if (ref <= 0) return props
  const toRatio = (px: number) => clampBlockArrowRatio(Math.round((Math.max(0, px) / ref) * RATIO_DIGITS) / RATIO_DIGITS)
  const next = { ...props }
  let changed = false
  const put = (key: 'arrowShaft' | 'arrowHeadLength' | 'arrowHeadWidth', px: number | undefined) => {
    if (px === undefined) return
    const value = toRatio(px)
    if (props[key] === value) return
    next[key] = value
    changed = true
  }
  put('arrowShaft', sizes.shaft)
  put('arrowHeadLength', sizes.headLength)
  put('arrowHeadWidth', sizes.headWidth)
  return changed ? next : props
}

// ハンドルのドラッグ。begin で作ったトランザクションに書き、終わりは呼ぶ側が finish・cancel する
export class BlockArrowHandleDrag {
  private readonly editor: Editor
  private readonly tx: Transaction<WorkspaceRecord>
  readonly nodeId: string
  readonly kind: BlockArrowHandleKind
  // つかんだときの図形と、そのときの形（箱に収めたもの）・ポインタ（ローカル座標）
  private readonly initial: NodeRecord<GeoProps>
  private readonly start: BlockArrowGeometry
  private readonly startLocal: Vec

  constructor(editor: Editor, tx: Transaction<WorkspaceRecord>, nodeId: string, kind: BlockArrowHandleKind, world: Vec) {
    this.editor = editor
    this.tx = tx
    this.nodeId = nodeId
    this.kind = kind
    this.initial = nodeIn(tx, nodeId) as NodeRecord<GeoProps>
    this.start = geometryOf(this.initial.props)
    this.startLocal = this.local(world)
  }

  private local(world: Vec): Vec {
    const entry = this.editor.index.get(this.nodeId)
    return entry ? applyMat(invert(entry.worldMatrix), world) : world
  }

  // 今の形の値（px。箱に収めたもの）
  sizes(world: Vec): { shaft?: number; headLength?: number; headWidth?: number } {
    const p = this.local(world)
    const dx = p.x - this.startLocal.x
    const dy = p.y - this.startLocal.y
    const g = this.start
    const { w, h } = g
    const clamp = (v: number, min: number, max: number) => Math.round(Math.min(Math.max(v, min), Math.max(min, max)))
    switch (g.shape) {
      case 'blockArrow':
      case 'blockArrowBoth':
        // 上の縁を動かすと、上下対称に変わる
        if (this.kind === 'shaft') return { shaft: clamp(g.shaft - dy * 2, 0, g.headWidth) }
        return {
          headLength: clamp(g.headLength - dx, 0, g.shape === 'blockArrowBoth' ? w / 2 : w),
          headWidth: clamp(g.headWidth - dy * 2, g.shaft, h),
        }
      case 'blockArrowBent':
        if (this.kind === 'shaft') return { shaft: clamp(g.shaft + dx, 0, Math.min(g.headWidth, w - g.headLength)) }
        return { headLength: clamp(g.headLength - dx, 0, w - g.shaft), headWidth: clamp(g.headWidth + dy, g.shaft, h) }
      case 'chevron':
        return { headLength: clamp(g.headLength + dx, 0, w) }
    }
  }

  move(world: Vec): void {
    const current = nodeIn(this.tx, this.nodeId) as NodeRecord<GeoProps> | undefined
    if (!current) return
    const props = withBlockArrowSizes(this.initial.props, this.sizes(world))
    const next = { ...current.props, arrowShaft: props.arrowShaft, arrowHeadLength: props.arrowHeadLength, arrowHeadWidth: props.arrowHeadWidth }
    if (next.arrowShaft === undefined) delete next.arrowShaft
    if (next.arrowHeadLength === undefined) delete next.arrowHeadLength
    if (next.arrowHeadWidth === undefined) delete next.arrowHeadWidth
    if (
      next.arrowShaft === current.props.arrowShaft &&
      next.arrowHeadLength === current.props.arrowHeadLength &&
      next.arrowHeadWidth === current.props.arrowHeadWidth
    ) {
      return
    }
    this.tx.put({ ...current, props: next })
    this.tx.flush()
  }
}
