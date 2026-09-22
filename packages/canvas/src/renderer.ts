import { expandBox, viewportBounds, type Box, type Camera, type Mat } from '@canvcode/core'
import type { ImageRequester, RenderInfo } from '@canvcode/nodes'
import type { Editor } from './editor.ts'
import { selectionHandles } from './tools.ts'
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

export interface Viewport {
  camera: Camera
  width: number
  height: number
  dpr: number
  images?: ImageRequester
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
  const info: RenderInfo = { zoom: view.camera.zoom, devicePixelRatio: view.dpr, detail: 'full', images: view.images }
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
      setNodeTransform(ctx, worldMatrix, view)
      type.render(ctx, node, info)
      lastRoughColor = ''
    }
    drawn++
  }
  ctx.globalAlpha = 1
  return drawn
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

  if (state.hoveredId && !state.selectedIds.has(state.hoveredId)) {
    outlineNode(ctx, editor, state.hoveredId, view)
  }
  for (const id of state.selectedIds) outlineNode(ctx, editor, id, view)

  // 選択枠とハンドル（MAI-23）。1 つならノードの向きに沿った枠、複数なら全体を囲む枠
  const found = selectionHandles(editor)
  if (found) drawSelectionHandles(ctx, found.handles, found.selection.targets.length > 1, view.dpr)
  return drawn
}

function outlineNode(ctx: CanvasRenderingContext2D, editor: Editor, id: string, view: Viewport): void {
  const entry = editor.index.get(id)
  if (!entry) return
  const local = editor.getType(entry.node).getBounds(entry.node)
  // 線の太さを倍率によらず一定にするため、角の位置だけを行列で写して、単位行列で描く
  const s = view.camera.zoom * view.dpr
  const m = entry.worldMatrix
  const corner = (x: number, y: number) => ({
    x: (m.a * x + m.c * y + m.e - view.camera.x) * s,
    y: (m.b * x + m.d * y + m.f - view.camera.y) * s,
  })
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
