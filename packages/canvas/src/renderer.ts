import { expandBox, viewportBounds, type Box, type Camera, type Mat, type NodeRecord } from '@canvcode/core'
import {
  arrowPolyline,
  HIDDEN_SLIDE_OPACITY,
  isHiddenSlide,
  requestAssetImage,
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
import type { GapGuide } from './gapSnapping.ts'
import type { Axis } from './arrange.ts'
import { arrowHandles, selectionHandles, spacingHandles, type SpacingHandle } from './tools.ts'
import type { ScreenHandles } from './transform.ts'
import { gradientHandles, type GradientHandles } from './gradientHandles.ts'
import { cropHandles, type CropHandles } from './cropHandles.ts'
import { CORNER_HANDLE_RADIUS_PX, cornerHandles, type CornerHandles } from './cornerHandles.ts'
import { BLOCK_ARROW_HANDLE_SIZE_PX, blockArrowHandles, type BlockArrowHandles } from './blockArrowHandles.ts'

// シーンとオーバーレイの描画（MAI-5、MAI-14）。
// - 画面に見えているノードだけを、重なり順に描く
// - 画面上で極端に小さいノードは、塗りつぶしの矩形として簡略に描く
// - ドラッグ中のノードはシーンから外し、オーバーレイに描く（シーンを描き直さずに済む）

// 画面上の大きさがこれより小さいノードは簡略に描く（CSS ピクセル）
const ROUGH_THRESHOLD_PX = 4
// 描くノードがこれより多いときは、影などの効果を省く（MAI-86。影のぼかしは重いので、ノードが多い全体表示を軽くする）
export const EFFECTS_NODE_LIMIT = 2000
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
// 移動中の距離の線：ほかの間隔と同じでない距離は薄く描く。両端の印の長さ（CSS ピクセル、片側）
const GAP_GUIDE_FAINT_COLOR = 'rgba(230, 73, 128, 0.45)'
const GAP_GUIDE_CAP_PX = 4
// グラデーションのハンドル（MAI-82）：始点・終点（中心・半径）は白い丸、止め色はその色の丸（選んでいるものは大きく、青い縁）
const GRADIENT_END_RADIUS_PX = 5
// 切り抜きモードの、窓の外の画像の不透明度と、画像全体の角の丸の半径（CSS ピクセル）
const CROP_OUTSIDE_OPACITY = 0.35
const CROP_CORNER_RADIUS_PX = 5
const GRADIENT_STOP_RADIUS_PX = 6
const GRADIENT_SELECTED_STOP_RADIUS_PX = 7.5
// 文字があふれているセルの印（スライド v2）：赤い枠線。倍率によらず 2 CSS ピクセル
const OVERFLOW_COLOR = '#e03131'
const OVERFLOW_LINE_PX = 2

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
  // PDF に出す画像を描くか（スライド v2）。型に RenderInfo.print で渡し、非表示のスライドも薄くしない
  print?: boolean
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
    // スライドの番号は Editor が計算する（スライド v2）
    slides: editor.slides,
    print: view.print,
    noEffects: ids.length > EFFECTS_NODE_LIMIT,
  }
  let drawn = 0
  let lastRoughColor = ''
  for (const id of ids) {
    if (skip?.has(id)) continue
    const entry = editor.index.get(id)
    if (!entry) continue
    const { node, worldBounds, worldMatrix } = entry
    const type = editor.getType(node)
    const ancestors = editor.index.ancestorsOf(id)
    // 非表示のスライドは、枠と中身（子孫）をまとめて薄く描く（スライド v2）。PDF に出す画像では薄くしない
    ctx.globalAlpha = !view.print && inHiddenSlide(editor, node, ancestors) ? node.opacity * HIDDEN_SLIDE_OPACITY : node.opacity
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
      const clipped = clipToFrames(ctx, editor, ancestors, view)
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

// ノードそのものか祖先（近い順の ancestors）が、非表示のスライドか
function inHiddenSlide(editor: Editor, node: NodeRecord, ancestors: readonly string[]): boolean {
  if (isHiddenSlide(node)) return true
  return ancestors.some((ancestorId) => {
    const ancestor = editor.index.get(ancestorId)?.node
    return ancestor !== undefined && isHiddenSlide(ancestor)
  })
}

// 祖先（近い順の ancestors）のフレームの枠で切り抜く。切り抜いたら true を返す（呼び出し側で restore する）
function clipToFrames(ctx: CanvasRenderingContext2D, editor: Editor, ancestors: readonly string[], view: Viewport): boolean {
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
  // 移動中の、隣・フレームの辺までの距離の線
  gapGuides?: readonly GapGuide[]
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

  // 文字があふれているセル（スライド v2）。選択の枠より下に描く。PDF に出す画像には描かない
  if (!view.print) drawSlideOverflows(ctx, editor, view)

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

  // ホバー中のノードは、形の縁（角丸・楕円。型の outline）をなぞる。選んでいるノードは箱の枠（Figma と同じ。MAI-84）
  if (state.hoveredId && !state.selectedIds.has(state.hoveredId)) {
    outlineNode(ctx, editor, state.hoveredId, view, true)
  }
  for (const id of state.selectedIds) outlineNode(ctx, editor, id, view)

  // 選択枠とハンドル（MAI-23）。1 つならノードの向きに沿った枠、複数なら全体を囲む枠
  const found = editor.session.get().editingId ? null : selectionHandles(editor)
  if (found) drawSelectionHandles(ctx, found.handles, found.selection.targets.length > 1, view.dpr)
  // 角丸のハンドル（MAI-84）
  const corners = cornerHandles(editor)
  if (corners) drawCornerHandles(ctx, corners, view.dpr)
  // ブロック矢印の形のハンドル（MAI-87）
  const arrowShape = blockArrowHandles(editor)
  if (arrowShape) drawBlockArrowHandles(ctx, arrowShape, view.dpr)
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

  // 塗りのグラデーションのハンドル（MAI-82）
  const gradient = gradientHandles(editor)
  if (gradient) drawGradientHandles(ctx, gradient, view.dpr)
  // 画像の切り抜きモード：窓の外の画像（薄く）と、窓・画像全体の枠とハンドル
  const crop = cropHandles(editor)
  if (crop) drawCropOverlay(ctx, crop, view)

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
  if (state.gapGuides && state.gapGuides.length > 0) drawGapGuides(ctx, state.gapGuides, view)
  return drawn
}

// 距離の線：両端に軸と直角の短い印を付けた 1 CSS ピクセルの線と、真ん中に距離（整数）のラベル。
// ほかの間隔と同じ距離は濃く、それ以外は薄く描く
function drawGapGuides(ctx: CanvasRenderingContext2D, guides: readonly GapGuide[], view: Viewport): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.lineWidth = view.dpr
  const cap = GAP_GUIDE_CAP_PX * view.dpr
  // 薄いものを先に描き、濃いものを上に重ねる
  const ordered = [...guides].sort((a, b) => Number(a.equal) - Number(b.equal))
  for (const guide of ordered) {
    const color = guide.equal ? SNAP_GUIDE_COLOR : GAP_GUIDE_FAINT_COLOR
    const span =
      guide.axis === 'x'
        ? { x: guide.from, y: guide.at, w: guide.to - guide.from, h: 0 }
        : { x: guide.at, y: guide.from, w: 0, h: guide.to - guide.from }
    const r = deviceRect(span, view)
    // 半ピクセルに寄せて、にじまないようにする
    const x = Math.round(r.x) + 0.5
    const y = Math.round(r.y) + 0.5
    const w = Math.round(r.w)
    const h = Math.round(r.h)
    ctx.strokeStyle = color
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + w, y + h)
    if (guide.axis === 'x') {
      for (const end of [x, x + w]) {
        ctx.moveTo(end, y - cap)
        ctx.lineTo(end, y + cap)
      }
    } else {
      for (const end of [y, y + h]) {
        ctx.moveTo(x - cap, end)
        ctx.lineTo(x + cap, end)
      }
    }
    ctx.stroke()
    drawValueLabel(ctx, String(Math.round(guide.to - guide.from)), x + w / 2, y + h / 2, view.dpr, 'center', color)
  }
}

// 数値のラベル：色の付いた四角に白い文字。x・y は縦の真ん中で、align の基準（左端か真ん中）。デバイスピクセル
function drawValueLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  dpr: number,
  align: 'left' | 'center',
  color: string,
): void {
  ctx.font = `${SPACING_LABEL_FONT_PX * dpr}px system-ui, sans-serif`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  const width = ctx.measureText(text).width
  const pad = 4 * dpr
  const h = (SPACING_LABEL_FONT_PX + 6) * dpr
  const left = align === 'center' ? x - width / 2 : x
  ctx.fillStyle = color
  ctx.fillRect(left - pad, y - h / 2, width + pad * 2, h)
  ctx.fillStyle = '#ffffff'
  ctx.fillText(text, left, y)
}

// スライドの中の、文字があふれているセルの箱を赤い枠線でなぞる（Editor.slideOverflows）
function drawSlideOverflows(ctx: CanvasRenderingContext2D, editor: Editor, view: Viewport): void {
  const overflows = editor.slideOverflows()
  if (overflows.size === 0) return
  ctx.strokeStyle = OVERFLOW_COLOR
  ctx.lineWidth = OVERFLOW_LINE_PX * view.dpr
  for (const { nodes } of overflows.values()) for (const id of nodes) outlineNode(ctx, editor, id, view)
}

// shape なら、型の outline（角丸・楕円の縁）があればそれをなぞる。なければ箱の枠
function outlineNode(ctx: CanvasRenderingContext2D, editor: Editor, id: string, view: Viewport, shape = false): void {
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
  const outline = shape ? editor.getType(entry.node).outline?.(entry.node) : undefined
  const points = outline
    ? outline.map((p) => corner(p.x, p.y))
    : [
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

// 角丸のハンドル：角の内側の小さな白い丸（青い縁）
function drawCornerHandles(ctx: CanvasRenderingContext2D, handles: CornerHandles, dpr: number): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = '#ffffff'
  ctx.strokeStyle = SELECTION_COLOR
  ctx.lineWidth = 1.5 * dpr
  for (const point of handles.points) {
    ctx.beginPath()
    ctx.arc(point.x * dpr, point.y * dpr, CORNER_HANDLE_RADIUS_PX * dpr, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }
}

// ブロック矢印の形のハンドル：黄色のひし形（青い縁。角丸・選択枠のハンドルと見分ける。PowerPoint の調整ハンドルと同じ色）
function drawBlockArrowHandles(ctx: CanvasRenderingContext2D, found: BlockArrowHandles, dpr: number): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = '#ffd43b'
  ctx.strokeStyle = SELECTION_COLOR
  ctx.lineWidth = 1.5 * dpr
  const r = BLOCK_ARROW_HANDLE_SIZE_PX * dpr
  for (const { point } of found.handles) {
    const x = point.x * dpr
    const y = point.y * dpr
    ctx.beginPath()
    ctx.moveTo(x, y - r)
    ctx.lineTo(x + r, y)
    ctx.lineTo(x, y + r)
    ctx.lineTo(x - r, y)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
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
      const mid = { x: ((handle.a.x + handle.b.x) / 2) * dpr, y: ((handle.a.y + handle.b.y) / 2) * dpr }
      // 棒の真ん中の右に出す（縦の間隔の横棒なら、少し下にずらして棒に重ねない）
      const x = mid.x + 8 * dpr
      const y = handle.axis === 'x' ? mid.y : mid.y + 12 * dpr
      drawValueLabel(ctx, String(Math.round(drag.gap)), x, y, dpr, 'left', SPACING_COLOR)
    }
  }
  ctx.lineCap = 'butt'
}

// 画像の切り抜きモード：窓の外にはみ出した画像を薄く描き（窓の中はシーンにある）、画像全体の枠（点線）と角の白い丸、
// 窓の枠とハンドル（画像ノードだけ）を描く
function drawCropOverlay(ctx: CanvasRenderingContext2D, found: CropHandles, view: Viewport): void {
  const { target, full } = found
  const asset = view.assets?.get(target.assetId)
  const raster = asset
    ? requestAssetImage({ images: view.images, assets: view.assets }, asset, Math.max(full.w, full.h) * view.camera.zoom * view.dpr)
    : null
  const { box } = target
  ctx.save()
  setNodeTransform(ctx, target.worldMatrix, view)
  ctx.beginPath()
  ctx.rect(full.x, full.y, full.w, full.h)
  ctx.rect(box.x, box.y, box.w, box.h)
  ctx.clip('evenodd')
  ctx.globalAlpha = CROP_OUTSIDE_OPACITY
  if (raster) {
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(raster.image, full.x, full.y, full.w, full.h)
  } else {
    ctx.fillStyle = '#9aa0a6'
    ctx.fillRect(full.x, full.y, full.w, full.h)
  }
  ctx.restore()

  const dpr = view.dpr
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.save()
  ctx.strokeStyle = SELECTION_COLOR
  ctx.lineWidth = 1 * dpr
  ctx.setLineDash([4 * dpr, 3 * dpr])
  ctx.beginPath()
  found.outline.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x * dpr, p.y * dpr) : ctx.lineTo(p.x * dpr, p.y * dpr)))
  ctx.closePath()
  ctx.stroke()
  ctx.setLineDash([])
  ctx.lineWidth = 1.5 * dpr
  ctx.beginPath()
  found.window.corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x * dpr, p.y * dpr) : ctx.lineTo(p.x * dpr, p.y * dpr)))
  ctx.closePath()
  ctx.stroke()
  ctx.restore()
  if (found.window.handles.length > 0) drawSelectionHandles(ctx, found.window, false, dpr)
  ctx.save()
  ctx.fillStyle = '#ffffff'
  ctx.strokeStyle = SELECTION_COLOR
  ctx.lineWidth = 1.5 * dpr
  for (const { point } of found.corners) {
    ctx.beginPath()
    ctx.arc(point.x * dpr, point.y * dpr, CROP_CORNER_RADIUS_PX * dpr, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }
  ctx.restore()
}

// グラデーションのハンドル：始点→終点の線（白に薄い影）、端の白い丸、線の上の止め色。
// 円形では、中心から半径の点への線と、その半径の楕円の目安（点線）を出す
function drawGradientHandles(ctx: CanvasRenderingContext2D, handles: GradientHandles, dpr: number): void {
  const d = (p: { x: number; y: number }) => ({ x: p.x * dpr, y: p.y * dpr })
  const start = d(handles.start)
  const end = d(handles.end)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.save()
  ctx.lineCap = 'round'
  // 線（どの地の色でも見えるよう、暗い縁取りの上に白）
  for (const [color, width] of [
    ['rgba(0, 0, 0, 0.35)', 3],
    ['#ffffff', 1.5],
  ] as const) {
    ctx.strokeStyle = color
    ctx.lineWidth = width * dpr
    ctx.beginPath()
    ctx.moveTo(start.x, start.y)
    ctx.lineTo(end.x, end.y)
    ctx.stroke()
  }
  const circle = (p: { x: number; y: number }, radius: number, fill: string, stroke: string, lineWidth: number) => {
    ctx.beginPath()
    ctx.arc(p.x, p.y, radius * dpr, 0, Math.PI * 2)
    ctx.fillStyle = fill
    ctx.fill()
    ctx.lineWidth = lineWidth * dpr
    ctx.strokeStyle = stroke
    ctx.stroke()
  }
  // 止め色（選んでいるものを最後に、上に描く）
  const stops = [...handles.stops].sort((a, b) => Number(a.index === handles.selectedStop) - Number(b.index === handles.selectedStop))
  for (const { index, point, stop } of stops) {
    const selected = index === handles.selectedStop
    const p = d(point)
    // 不透明度のある色が分かるよう、白の上に重ねる
    circle(p, selected ? GRADIENT_SELECTED_STOP_RADIUS_PX : GRADIENT_STOP_RADIUS_PX, '#ffffff', selected ? SELECTION_COLOR : '#ffffff', selected ? 2.5 : 2)
    ctx.beginPath()
    ctx.arc(p.x, p.y, (selected ? GRADIENT_SELECTED_STOP_RADIUS_PX : GRADIENT_STOP_RADIUS_PX) * dpr - 2 * dpr, 0, Math.PI * 2)
    ctx.globalAlpha = Math.max(0.15, stop.opacity)
    ctx.fillStyle = stop.color
    ctx.fill()
    ctx.globalAlpha = 1
  }
  // 端（位置 0・1 の止め色の上に重なるので、小さな丸で縁だけ見せる）
  for (const p of [start, end]) {
    ctx.beginPath()
    ctx.arc(p.x, p.y, GRADIENT_END_RADIUS_PX * dpr, 0, Math.PI * 2)
    ctx.lineWidth = 1.5 * dpr
    ctx.strokeStyle = SELECTION_COLOR
    ctx.stroke()
  }
  circle(start, 2.5, SELECTION_COLOR, '#ffffff', 1)
  ctx.restore()
}
