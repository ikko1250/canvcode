import {
  applyMat,
  dist,
  invert,
  transformOf,
  worldToScreen,
  type Box,
  type Mat,
  type NodeRecord,
  type Transaction,
  type Vec,
  type WorkspaceRecord,
} from '@canvcode/core'
import { coverCrop, FULL_CROP, normalizeCrop, toFill, type ImageCrop, type ImagePaint, type ImageProps } from '@canvcode/nodes'
import { nodeIn, type Editor } from './editor.ts'
import { HANDLES, handleCursor, hitHandle, type Handle, type ScreenHandles } from './transform.ts'

// 画像のトリミング（切り抜き）。画像ノード（props.crop）と、画像の塗りを持つ図形（スライドの画像枠など。fill.crop）を、
// ダブルクリックで入る「切り抜きモード」（session.cropEditing）で、キャンバスの上で切り抜く（Figma・PowerPoint と同じ）。
// - どちらも「画像の crop の範囲（画像全体を 0〜1 とした割合）を、ノードの箱に写して描く」ので、同じ 2 つの矩形で扱える：
//   窓（見えている範囲＝ノードの箱）と、画像全体（窓の外まで広げた、画像の全体の矩形）。どちらもノードのローカル座標
// - 画像全体の内側をドラッグすると画像を動かす（パン）。画像全体の角をドラッグすると、縦横比を保って大きさを変える。
//   どちらも、画像が窓を覆わなくなるところでは止める
// - 画像ノードだけ、窓の 8 つのハンドルで窓（ノードの箱）を変えられる（画像全体の外には出さない）。
//   図形（スライドの画像枠）は、スライドの配置を崩さないよう、窓は変えない
// - 位置はノードのワールド行列で写すので、回転したノードでも動く。ドラッグは 1 つのトランザクション（Undo 1 回）
// - 編集している間は、選択枠・角丸などのハンドルを出さない（selectionHandles など）
// - 描画と当たり判定で同じ位置を使う（renderer.ts の drawCropOverlay と、tools.ts の SelectTool）

// 切り抜きモードのノードと、画像の塗りが切り抜き（crop）でないときに始める範囲（今の見た目と同じ範囲。入るときに決める）
export interface CropEditing {
  nodeId: string
  seed: ImageCrop
}

export type CropKind = 'image' | 'fill'

export interface CropTarget {
  node: NodeRecord
  kind: CropKind
  assetId: string
  crop: ImageCrop
  // 窓（ノードの箱。ローカル座標）
  box: Box
  worldMatrix: Mat
}

// ハンドルをつかめる範囲（CSS ピクセル）
export const CROP_HANDLE_HIT_PX = 8

// 切り抜きモードに入れるノードなら、その種類。画像ノードと、画像の塗りを持つ図形
export function cropKindOf(node: NodeRecord): CropKind | null {
  if (node.type === 'image') return (node.props as ImageProps).assetId ? 'image' : null
  if (node.type === 'geo' && toFill((node.props as { fill?: unknown }).fill)?.type === 'image') return 'fill'
  return null
}

// 切り抜きモードに入る。assets は画像の元の大きさ（画素）を引くのに使う（画像の塗りが切り抜きでないとき、今の見た目（塗りつぶし）の範囲から始める）。
// 入れたら true
export function startCropEditing(editor: Editor, nodeId: string, assets?: { get(assetId: string): { width: number; height: number } | undefined }): boolean {
  const node = editor.getNode(nodeId)
  if (!node || node.locked) return false
  const kind = cropKindOf(node)
  if (!kind) return false
  const props = node.props as { w: number; h: number; fill?: unknown }
  let seed = { ...FULL_CROP }
  if (kind === 'fill') {
    const paint = toFill(props.fill) as ImagePaint
    const image = assets?.get(paint.assetId)
    if (paint.scaleMode === 'crop') seed = normalizeCrop(paint.crop)
    else if (image) seed = coverCrop(image, { w: props.w, h: props.h })
  }
  if (editor.session.get().editingId) return false
  editor.setSelection([nodeId])
  editor.session.set({ cropEditing: { nodeId, seed }, paintEditing: null })
  return true
}

export function stopCropEditing(editor: Editor): boolean {
  if (!editor.session.get().cropEditing) return false
  editor.session.set({ cropEditing: null })
  return true
}

// ノードの今の切り抜き範囲（種類ごと）
function cropOf(node: NodeRecord, kind: CropKind, seed: ImageCrop): ImageCrop {
  if (kind === 'image') {
    const crop = (node.props as ImageProps).crop
    return crop ? normalizeCrop(crop) : { ...FULL_CROP }
  }
  const paint = toFill((node.props as { fill?: unknown }).fill) as ImagePaint
  return paint.scaleMode === 'crop' ? normalizeCrop(paint.crop) : seed
}

// 切り抜きモードのノード。モードでない・選び方が違う・切り抜けないノードのときは null
export function cropEditingTarget(editor: Editor): CropTarget | null {
  const { cropEditing, selectedIds, editingId } = editor.session.get()
  if (!cropEditing || editingId || selectedIds.size !== 1 || !selectedIds.has(cropEditing.nodeId)) return null
  const entry = editor.index.get(cropEditing.nodeId)
  if (!entry || entry.node.locked) return null
  const kind = cropKindOf(entry.node)
  if (!kind) return null
  const { w, h } = entry.node.props as { w: number; h: number }
  if (!(w > 0 && h > 0)) return null
  const props = entry.node.props as { assetId?: string; fill?: unknown }
  const assetId = kind === 'image' ? props.assetId! : (toFill(props.fill) as ImagePaint).assetId
  return {
    node: entry.node,
    kind,
    assetId,
    crop: cropOf(entry.node, kind, cropEditing.seed),
    box: { x: 0, y: 0, w, h },
    worldMatrix: entry.worldMatrix,
  }
}

// ---- 矩形の計算（純粋な関数） ----

// 窓 box に crop の範囲を写したときの、画像全体の矩形（box と同じ座標）
export function fullImageRect(box: Box, crop: ImageCrop): Box {
  const w = box.w / crop.w
  const h = box.h / crop.h
  return { x: box.x - crop.x * w, y: box.y - crop.y * h, w, h }
}

// 窓と画像全体の矩形から、切り抜く範囲
export function cropFromRects(window: Box, full: Box): ImageCrop {
  return normalizeCrop({ x: (window.x - full.x) / full.w, y: (window.y - full.y) / full.h, w: window.w / full.w, h: window.h / full.h })
}

// 画像全体を delta だけ動かす。窓を覆わなくなるところで止める
export function panImage(window: Box, full: Box, delta: Vec): Box {
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
  return {
    ...full,
    x: clamp(full.x + delta.x, window.x + window.w - full.w, window.x),
    y: clamp(full.y + delta.y, window.y + window.h - full.h, window.y),
  }
}

export type ImageCorner = 'nw' | 'ne' | 'se' | 'sw'
export const IMAGE_CORNERS: readonly ImageCorner[] = ['nw', 'ne', 'se', 'sw']

function cornerOf(box: Box, corner: ImageCorner): Vec {
  return { x: corner.includes('e') ? box.x + box.w : box.x, y: corner.includes('s') ? box.y + box.h : box.y }
}

const OPPOSITE: Record<ImageCorner, ImageCorner> = { nw: 'se', ne: 'sw', se: 'nw', sw: 'ne' }

// 画像全体の角 corner を point へ動かす。向かいの角は動かさず、縦横比を保つ。窓を覆わなくなる大きさより小さくはしない
export function scaleImage(window: Box, full: Box, corner: ImageCorner, point: Vec): Box {
  const anchor = cornerOf(full, OPPOSITE[corner])
  const sx = corner.includes('e') ? 1 : -1
  const sy = corner.includes('s') ? 1 : -1
  // ポインタの位置から決まる倍率（縦横の大きい方）
  let s = Math.max(((point.x - anchor.x) * sx) / full.w, ((point.y - anchor.y) * sy) / full.h)
  // 窓を覆う最小の倍率（向かいの角から、窓の遠い辺まで）
  const needX = sx > 0 ? window.x + window.w - anchor.x : anchor.x - window.x
  const needY = sy > 0 ? window.y + window.h - anchor.y : anchor.y - window.y
  s = Math.max(s, needX / full.w, needY / full.h)
  const w = full.w * s
  const h = full.h * s
  return { x: sx > 0 ? anchor.x : anchor.x - w, y: sy > 0 ? anchor.y : anchor.y - h, w, h }
}

// 窓のハンドル handle を point へ動かす（画像ノードだけ）。画像全体の外には出さず、min より小さくはしない
export function resizeWindow(window: Box, full: Box, handle: Handle, point: Vec, min: { w: number; h: number }): Box {
  let left = window.x
  let top = window.y
  let right = window.x + window.w
  let bottom = window.y + window.h
  const minW = Math.min(min.w, full.w)
  const minH = Math.min(min.h, full.h)
  if (handle.includes('w')) left = Math.min(Math.max(point.x, full.x), right - minW)
  if (handle.includes('e')) right = Math.max(Math.min(point.x, full.x + full.w), left + minW)
  if (handle.includes('n')) top = Math.min(Math.max(point.y, full.y), bottom - minH)
  if (handle.includes('s')) bottom = Math.max(Math.min(point.y, full.y + full.h), top + minH)
  return { x: left, y: top, w: right - left, h: bottom - top }
}

// ---- 画面上のハンドル ----

export interface CropHandles {
  target: CropTarget
  // 画像全体の矩形（ローカル座標）
  full: Box
  // 窓の角とハンドル（画像ノードだけ。図形では handles が空）
  window: ScreenHandles
  // 画像全体の 4 つの角（画面上）
  corners: { corner: ImageCorner; point: Vec }[]
  // 画像全体の 4 つの角（左上から時計回り。画面上）
  outline: Vec[]
}

export type CropHandleHit = { handle: 'window'; which: Handle } | { handle: 'corner'; corner: ImageCorner } | { handle: 'pan' }

function rectCorners(box: Box): Vec[] {
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ]
}

export function cropHandles(editor: Editor): CropHandles | null {
  const target = cropEditingTarget(editor)
  if (!target) return null
  const camera = editor.session.get().camera
  const toScreen = (p: Vec) => worldToScreen(camera, applyMat(target.worldMatrix, p))
  const full = fullImageRect(target.box, target.crop)
  const { box } = target
  const local: Record<Handle, Vec> = {
    nw: { x: box.x, y: box.y },
    n: { x: box.x + box.w / 2, y: box.y },
    ne: { x: box.x + box.w, y: box.y },
    e: { x: box.x + box.w, y: box.y + box.h / 2 },
    se: { x: box.x + box.w, y: box.y + box.h },
    s: { x: box.x + box.w / 2, y: box.y + box.h },
    sw: { x: box.x, y: box.y + box.h },
    w: { x: box.x, y: box.y + box.h / 2 },
  }
  const rotation = Math.atan2(target.worldMatrix.b, target.worldMatrix.a)
  const window: ScreenHandles = {
    frame: { x: 0, y: 0, w: box.w, h: box.h, rotation },
    corners: rectCorners(box).map(toScreen),
    handles: target.kind === 'image' ? HANDLES.map((handle) => ({ handle, point: toScreen(local[handle]) })) : [],
    rotate: null,
  }
  return {
    target,
    full,
    window,
    corners: IMAGE_CORNERS.map((corner) => ({ corner, point: toScreen(cornerOf(full, corner)) })),
    outline: rectCorners(full).map(toScreen),
  }
}

// 画面上の点 screen にあるハンドル。窓のハンドル → 画像全体の角 → 画像全体の内側（パン）の順に調べる。
// どれでもない（画像の外）なら null
export function hitCropHandle(editor: Editor, screen: Vec, world: Vec): { handles: CropHandles; hit: CropHandleHit } | null {
  const handles = cropHandles(editor)
  if (!handles) return null
  const windowHit = hitHandle(handles.window, screen)
  if (windowHit?.kind === 'resize') return { handles, hit: { handle: 'window', which: windowHit.handle } }
  for (const { corner, point } of handles.corners) {
    if (dist(point, screen) <= CROP_HANDLE_HIT_PX) return { handles, hit: { handle: 'corner', corner } }
  }
  const local = applyMat(invert(handles.target.worldMatrix), world)
  const { full } = handles
  if (local.x >= full.x && local.y >= full.y && local.x <= full.x + full.w && local.y <= full.y + full.h) return { handles, hit: { handle: 'pan' } }
  return null
}

// ハンドルの上のカーソル
export function cropHandleCursor(hit: CropHandleHit, rotation: number): string {
  if (hit.handle === 'pan') return 'move'
  return handleCursor(hit.handle === 'window' ? hit.which : hit.corner, rotation)
}

// ---- ドラッグ ----

// 切り抜きのドラッグ。begin で作ったトランザクションに書き、終わりは呼ぶ側が finish・cancel する。
// つかんだときのノード・窓・画像全体から、毎回計算し直す（ノードの原点が動いても、つかんだときの座標で考える）
export class CropDrag {
  private readonly tx: Transaction<WorkspaceRecord>
  private readonly hit: CropHandleHit
  private readonly initial: NodeRecord
  private readonly kind: CropKind
  private readonly window: Box
  private readonly full: Box
  private readonly toLocal: Mat
  private readonly start: Vec
  private readonly minSize: { w: number; h: number }

  constructor(editor: Editor, tx: Transaction<WorkspaceRecord>, handles: CropHandles, hit: CropHandleHit, world: Vec) {
    this.tx = tx
    this.hit = hit
    const { target } = handles
    this.initial = nodeIn(tx, target.node.id) ?? target.node
    this.kind = target.kind
    this.window = target.box
    this.full = handles.full
    this.toLocal = invert(target.worldMatrix)
    this.start = applyMat(this.toLocal, world)
    this.minSize = editor.getType(target.node).minSize ?? { w: 1, h: 1 }
  }

  move(world: Vec): void {
    const point = applyMat(this.toLocal, world)
    let window = this.window
    let full = this.full
    switch (this.hit.handle) {
      case 'pan':
        full = panImage(window, full, { x: point.x - this.start.x, y: point.y - this.start.y })
        break
      case 'corner':
        full = scaleImage(window, full, this.hit.corner, point)
        break
      case 'window':
        window = resizeWindow(window, full, this.hit.which, point, this.minSize)
        break
    }
    this.write(window, full)
  }

  private write(window: Box, full: Box): void {
    const node = this.initial
    const crop = cropFromRects(window, full)
    if (this.kind === 'image') {
      // 窓の左上（つかんだときのローカル座標）を、親の座標に直して原点にする
      const origin = applyMat(transformOf(node.x, node.y, node.rotation), { x: window.x, y: window.y })
      const props: ImageProps = { ...(node.props as ImageProps), w: window.w, h: window.h, crop: isFull(crop) ? null : crop }
      this.tx.put({ ...node, x: origin.x, y: origin.y, props })
    } else {
      const paint = toFill((node.props as { fill?: unknown }).fill) as ImagePaint
      this.tx.put({ ...node, props: { ...(node.props as object), fill: { ...paint, scaleMode: 'crop', crop } } })
    }
    this.tx.flush()
  }
}

// 画像ノードの切り抜きをやめる。画像は動かさず、窓を画像全体に広げる（切り抜いていなければそのまま）
export function uncropImage(node: NodeRecord<ImageProps>): NodeRecord<ImageProps> {
  const { crop, w, h } = node.props
  if (!crop) return node
  const full = fullImageRect({ x: 0, y: 0, w, h }, normalizeCrop(crop))
  const origin = applyMat(transformOf(node.x, node.y, node.rotation), { x: full.x, y: full.y })
  return { ...node, x: origin.x, y: origin.y, props: { ...node.props, w: full.w, h: full.h, crop: null } }
}

function isFull(crop: ImageCrop): boolean {
  const eps = 1e-6
  return crop.x <= eps && crop.y <= eps && crop.w >= 1 - eps && crop.h >= 1 - eps
}
