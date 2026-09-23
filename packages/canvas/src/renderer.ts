import { expandBox, viewportBounds, type Box, type Camera, type Mat } from '@canvcode/core'
import {
  arrowPolyline,
  type ArrowProps,
  type AssetResolver,
  type CitationResolver,
  type DocumentResolver,
  type FileContentSource,
  type ImageRequester,
  type RenderInfo,
} from '@canvcode/nodes'
import type { Editor } from './editor.ts'
import type { SnapGuide } from './snapping.ts'
import type { Axis } from './arrange.ts'
import { arrowHandles, selectionHandles, spacingHandles, type SpacingHandle } from './tools.ts'
import type { ScreenHandles } from './transform.ts'

// シーンとオーバーレイの描画（MAI-5、MAI-14）。
// - 画面に見えているノードだけを、重なり順に描く
// - 画面上で極端に小さいノードは、塗りつぶしの矩形として簡略に描く
// - ドラッグ中のノードはシーンから外し、オーバーレイに描く（シーンを描き直さずに済む）

// 画面上の大きさがこれより小さいノードは簡略に描く（CSS ピクセル）
const ROUGH_THRESHOLD_PX = 4
// 線の太さ分だけ画面より少し広く探す（CSS ピクセル）
const CULL_MARGIN_PX = 16

const SELECTION_COLOR = '#2f6fed'
const HANDLE_SIZE_PX = 8
const ARROW_HANDLE_RADIUS_PX = 5
// 吸い付いた線の色（MAI-53）
const SNAP_GUIDE_COLOR = '#e64980'
// 間隔のハンドル（MAI-54）：ピンクの棒。ホバー中・ドラッグ中は太くする
const SPACING_COLOR = '#e64980'
const SPACING_BAR_PX = 2
const SPACING_BAR_HOVER_PX = 4
const SPACING_LABEL_FONT_PX = 12

export interface Viewport {
  camera: Camera
  width: number
  height: number
  dpr: number
  images?: ImageRequester
  assets?: AssetResolver
  documents?: DocumentResolver
  files?: FileContentSource
  citations?: CitationResolver
  // 文字を編集中のノード。文字以外（付箋の紙や図形）は描き、文字だけを描かない
  editingId?: string | null
}

// ノードのローカル座標 → 物理ピクセルの行列を ctx に設定する。
// カメラ位置は JS の 64 ビット浮動小数点数で引いてから渡す（MAI-6）。
function setNodeTransform(ctx: CanvasRenderingContext2D, m: Mat, view: Viewport): void {
  const s = view.camera.zoom * view.dpr
  ctx.setTransform(
    m.a * s,
    m.b * s,
    m.c * s,
    m.d * s,
    (m.e - view.camera.x) * s,
    (m.f - view.camera.y) * s,
  )
}

function deviceRect(box: Box, view: Viewport): Box {
  const s = view.camera.zoom * view.dpr
  return {
    x: (box.x - view.camera.x) * s,
    y: (box.y - view.camera.y) * s,
    w: box.w * s,
    h: box.h * s,
  }
}

export function visibleIds(editor: Editor, view: Viewport): string[] {
  const bounds = expandBox(
    viewportBounds(view.camera, view.width, view.height),
    CULL_MARGIN_PX / view.camera.zoom,
  )
  return editor.index.sortByOrder(editor.index.search(bounds))
}

// ids を重なり順に描き、描いたノード数を返す
export function drawNodes(
  ctx: CanvasRenderingContext2D,
  editor: Editor,
  ids: string[],
  view: Viewport,
  skip?: ReadonlySet<string>,
): number {
  const info: RenderInfo = {
    zoom: view.camera.zoom,
    devicePixelRatio: view.dpr,
    detail: 'full',
    images: view.images,
    assets: view.assets,
    documents: view.documents,
    files: view.files,
    citations: view.citations,
  }
  let drawn = 0
  let lastRoughColor = ''
  for (const id of ids) {
    if (skip?.has(id)) continue
    const entry = editor.index.get(id)
    if (!entry) continue
    const { node, worldBounds, worldMatrix } = entry
    const type = editor.getType(node)
    ctx.globalAlpha = node.opacity
    const screenSize = Math.max(worldBounds.w, worldBounds.h) * view.camera.zoom
    if (screenSize < ROUGH_THRESHOLD_PX) {
      if (type.renderRough) {
        setNodeTransform(ctx, worldMatrix, view)
        type.renderRough(ctx, node, { ...info, detail: 'rough' })
      } else {
        const color = type.roughColor?.(node) ?? '#999999'
        if (color !== lastRoughColor) {
          ctx.fillStyle = color
          lastRoughColor = color
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        const r = deviceRect(worldBounds, view)
        ctx.fillRect(r.x, r.y, Math.max(r.w, 1), Math.max(r.h, 1))
      }
    } else {
      // フレームの中のノードは、フレームの枠で切り抜いて描く（MAI-25）
      const clipped = clipToFrames(ctx, editor, id, view)
      setNodeTransform(ctx, worldMatrix, view)
      type.render(ctx, node, id === view.editingId ? { ...info, editing: true } : info)
      if (clipped) ctx.restore()
      lastRoughColor = ''
    }
    drawn++
  }
  ctx.globalAlpha = 1
  return drawn
}

// 祖先のフレームの枠で切り抜く。切り抜いたら true を返す（呼び出し側で restore する）
function clipToFrames(ctx: CanvasRenderingContext2D, editor: Editor, id: string, view: Viewport): boolean {
  const ancestors = editor.index.ancestorsOf(id)
  if (ancestors.length === 0) return false
  let saved = false
  // 外側のフレームから順に切り抜く
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const entry = editor.index.get(ancestors[i])
    if (!entry || !editor.isContainer(entry.node, 'frame')) continue
    if (!saved) {
      ctx.save()
      saved = true
    }
    setNodeTransform(ctx, entry.worldMatrix, view)
    ctx.beginPath()
    const b = entry.localBounds
    ctx.rect(b.x, b.y, b.w, b.h)
    ctx.clip()
  }
  return saved
}

export function clearCanvas(ctx: CanvasRenderingContext2D): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
}

export function drawScene(
  ctx: CanvasRenderingContext2D,
  editor: Editor,
  view: Viewport,
  hidden: ReadonlySet<string>,
): number {
  clearCanvas(ctx)
  return drawNodes(ctx, editor, visibleIds(editor, view), view, hidden)
}

export interface OverlayState {
  // ドラッグ中などでシーンから外しているノード
  lifted: ReadonlySet<string>
  selectedIds: ReadonlySet<string>
  hoveredId: string | null
  // 範囲選択の枠（ワールド座標）と、中に入っている group（MAI-25）
  brush: Box | null
  focusedGroupId: string | null
  // 引用する範囲（MAI-33）
  quoteRegion?: Box | null
  // 移動中に吸い付いた線（MAI-53）
  snapGuides?: readonly SnapGuide[]
  // 間隔のハンドル（MAI-54）：ホバー中の隙間と、ドラッグ中の間隔
  hoveredSpacing?: { axis: Axis; gapIndex: number } | null
  spacingDrag?: { axis: Axis; gap: number } | null
}

export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  editor: Editor,
  view: Viewport,
  state: OverlayState,
): number {
  clearCanvas(ctx)
  let drawn = 0
  if (state.lifted.size > 0) {
    drawn = drawNodes(ctx, editor, editor.index.sortByOrder([...state.lifted]), view)
  }

  ctx.lineWidth = 1.5 * view.dpr
  ctx.strokeStyle = SELECTION_COLOR

  // 中に入っている group の外枠（点線）
  if (state.focusedGroupId) {
    ctx.setLineDash([3 * view.dpr, 3 * view.dpr])
    ctx.globalAlpha = 0.6
    outlineNode(ctx, editor, state.focusedGroupId, view)
    ctx.globalAlpha = 1
    ctx.setLineDash([])
  }

  if (state.hoveredId && !state.selectedIds.has(state.hoveredId)) {
    outlineNode(ctx, editor, state.hoveredId, view)
  }
  for (const id of state.selectedIds) outlineNode(ctx, editor, id, view)

  // 選択枠とハンドル（MAI-23）。1 つならノードの向きに沿った枠、複数なら全体を囲む枠
  const found = editor.session.get().editingId ? null : selectionHandles(editor)
  if (found) drawSelectionHandles(ctx, found.handles, found.selection.targets.length > 1, view.dpr)
  // 間隔のハンドル（MAI-54）。選択枠のハンドルの上に描く
  const spacing = editor.session.get().editingId ? [] : spacingHandles(editor)
  if (spacing.length > 0) drawSpacingHandles(ctx, spacing, state.hoveredSpacing ?? null, state.spacingDrag ?? null, view.dpr)
  // 矢印の端と曲がりのハンドル（MAI-28）
  const arrow = editor.session.get().editingId ? null : arrowHandles(editor)
  if (arrow) {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#ffffff'
    for (const [point, radius] of [
      [arrow.start, ARROW_HANDLE_RADIUS_PX],
      [arrow.end, ARROW_HANDLE_RADIUS_PX],
      [arrow.bend, ARROW_HANDLE_RADIUS_PX - 1.5],
    ] as const) {
      const s = view.camera.zoom * view.dpr
      ctx.beginPath()
      ctx.arc((point.x - view.camera.x) * s, (point.y - view.camera.y) * s, radius * view.dpr, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
  }

  // 範囲選択の枠
  if (state.brush) {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    const r = deviceRect(state.brush, view)
    ctx.fillStyle = 'rgba(47, 111, 237, 0.08)'
    ctx.fillRect(r.x, r.y, r.w, r.h)
    ctx.lineWidth = view.dpr
    ctx.strokeRect(r.x, r.y, r.w, r.h)
  }
  // 引用する範囲（PDF のページの上）
  if (state.quoteRegion) {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    const r = deviceRect(state.quoteRegion, view)
    ctx.fillStyle = 'rgba(212, 167, 44, 0.16)'
    ctx.fillRect(r.x, r.y, r.w, r.h)
    ctx.strokeStyle = '#b7861b'
    ctx.lineWidth = 1.5 * view.dpr
    ctx.setLineDash([5 * view.dpr, 3 * view.dpr])
    ctx.strokeRect(r.x, r.y, r.w, r.h)
    ctx.setLineDash([])
  }
  // 吸い付いた線（MAI-53）。倍率によらず 1 CSS ピクセルの線
  if (state.snapGuides && state.snapGuides.length > 0) {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.strokeStyle = SNAP_GUIDE_COLOR
    ctx.lineWidth = view.dpr
    ctx.beginPath()
    for (const guide of state.snapGuides) {
      const span =
        guide.axis === 'x'
          ? { x: guide.position, y: guide.from, w: 0, h: guide.to - guide.from }
          : { x: guide.from, y: guide.position, w: guide.to - guide.from, h: 0 }
      const r = deviceRect(span, view)
      // 半ピクセルに寄せて、にじまないようにする
      const x = Math.round(r.x) + 0.5
      const y = Math.round(r.y) + 0.5
      ctx.moveTo(x, y)
      ctx.lineTo(x + Math.round(r.w), y + Math.round(r.h))
    }
    ctx.stroke()
  }
  return drawn
}

function outlineNode(ctx: CanvasRenderingContext2D, editor: Editor, id: string, view: Viewport): void {
  const entry = editor.index.get(id)
  if (!entry) return
  // group の大きさは索引が子から計算しているので、索引の値を使う
  const local = entry.localBounds
  // 線の太さを倍率によらず一定にするため、角の位置だけを行列で写して、単位行列で描く
  const s = view.camera.zoom * view.dpr
  const m = entry.worldMatrix
  const corner = (x: number, y: number) => ({
    x: (m.a * x + m.c * y + m.e - view.camera.x) * s,
    y: (m.b * x + m.d * y + m.f - view.camera.y) * s,
  })
  if (entry.node.type === 'arrow') {
    // 矢印は箱ではなく、線そのものをなぞる
    const line = arrowPolyline(entry.node.props as ArrowProps).map((p) => corner(p.x, p.y))
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.beginPath()
    line.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
    ctx.stroke()
    return
  }
  const points = [
    corner(local.x, local.y),
    corner(local.x + local.w, local.y),
    corner(local.x + local.w, local.y + local.h),
    corner(local.x, local.y + local.h),
  ]
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.beginPath()
  ctx.moveTo(points[0].x, points[0].y)
  for (const p of points.slice(1)) ctx.lineTo(p.x, p.y)
  ctx.closePath()
  ctx.stroke()
}

function drawSelectionHandles(ctx: CanvasRenderingContext2D, handles: ScreenHandles, multiple: boolean, dpr: number): void {
  const d = (p: { x: number; y: number }) => ({ x: p.x * dpr, y: p.y * dpr })
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  if (multiple) {
    ctx.setLineDash([4 * dpr, 4 * dpr])
    ctx.beginPath()
    handles.corners.map(d).forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
    ctx.closePath()
    ctx.stroke()
    ctx.setLineDash([])
  }
  if (handles.rotate) {
    const top = d(handles.handles.find((h) => h.handle === 'n')?.point ?? handles.corners[0])
    const r = d(handles.rotate)
    ctx.beginPath()
    ctx.moveTo(top.x, top.y)
    ctx.lineTo(r.x, r.y)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(r.x, r.y, (HANDLE_SIZE_PX / 2 + 1) * dpr, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.stroke()
  }
  const size = HANDLE_SIZE_PX * dpr
  ctx.fillStyle = '#ffffff'
  for (const { point } of handles.handles) {
    const p = d(point)
    ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size)
    ctx.strokeRect(p.x - size / 2, p.y - size / 2, size, size)
  }
}

// 間隔のハンドル：隙間の真ん中に、軸と直角のピンクの棒（隣どうしの重なりの範囲だけ）。
// ホバー中・ドラッグ中の棒は太く、ドラッグ中は棒の横に今の間隔（整数）を出す
function drawSpacingHandles(
  ctx: CanvasRenderingContext2D,
  handles: SpacingHandle[],
  hovered: { axis: Axis; gapIndex: number } | null,
  drag: { axis: Axis; gap: number } | null,
  dpr: number,
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.strokeStyle = SPACING_COLOR
  ctx.lineCap = 'round'
  for (const handle of handles) {
    const active = hovered !== null && hovered.axis === handle.axis && hovered.gapIndex === handle.gapIndex
    ctx.lineWidth = (active ? SPACING_BAR_HOVER_PX : SPACING_BAR_PX) * dpr
    ctx.beginPath()
    ctx.moveTo(handle.a.x * dpr, handle.a.y * dpr)
    ctx.lineTo(handle.b.x * dpr, handle.b.y * dpr)
    ctx.stroke()
    if (active && drag && drag.axis === handle.axis) {
      const text = String(Math.round(drag.gap))
      ctx.font = `${SPACING_LABEL_FONT_PX * dpr}px system-ui, sans-serif`
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      const width = ctx.measureText(text).width
      const pad = 4 * dpr
      const mid = { x: ((handle.a.x + handle.b.x) / 2) * dpr, y: ((handle.a.y + handle.b.y) / 2) * dpr }
      // 棒の真ん中の右に出す（縦の間隔の横棒なら、少し下にずらして棒に重ねない）
      const x = mid.x + 8 * dpr
      const y = handle.axis === 'x' ? mid.y : mid.y + 12 * dpr
      const h = (SPACING_LABEL_FONT_PX + 6) * dpr
      ctx.fillStyle = SPACING_COLOR
      ctx.fillRect(x - pad, y - h / 2, width + pad * 2, h)
      ctx.fillStyle = '#ffffff'
      ctx.fillText(text, x, y)
    }
  }
  ctx.lineCap = 'butt'
}
