import { applyMat, invert, type Box, type NodeRecord, type Vec } from '@canvcode/core'
import { aiNoteMeta } from './answers.ts'
import type { Editor } from './editor.ts'
import type { Viewport } from './renderer.ts'

// 付箋の角の三角（答えを見るボタン。docs/canvas-answer-panel-plan.md の 3）。
// - 答えを持つ付箋（meta.ai.answer）と、答えを作っている付箋（session の answeringIds）の右上に出す。押すと、答えのパネルを開く（送るボタンとは別）
// - 付箋の中身ではなく、ハンドルと同じ画面の部品。オーバーレイの層に描き、書き出し・サムネイル・render_canvas には入れない
// - 大きさはワールドで AI_CORNER_SIZE（付箋が小さければ縮める）。キャンバスを縮小しても、見た目はそのまま（付箋と一緒に小さくなる）で、
//   当たり判定だけを画面で AI_CORNER_HIT_PX 以上にする。ただし付箋の半分を超えない（付箋そのものも選べるように）
// - マウスを乗せると AI_CORNER_HOVER_SCALE 倍で描く。答えを作っている間は、不透明度を行き来させて点滅させる
// - 付箋が画面で AI_CORNER_MIN_NOTE_PX より小さいときは、描かず、当たりもない
// - 回転した付箋でも、付箋の向きに合わせる（付箋のローカル座標で決める）

// 三角の辺の長さ（ワールド。モックの付箋 220 に 21.6）
export const AI_CORNER_SIZE = 22
// 当たり判定の最小（画面の CSS ピクセル）
export const AI_CORNER_HIT_PX = 24
export const AI_CORNER_HOVER_SCALE = 1.25
export const AI_CORNER_COLOR = '#1d4ed8'
// 点滅の周期（ミリ秒）と、いちばん薄いときの不透明度
export const AI_CORNER_BLINK_MS = 1200
export const AI_CORNER_MIN_ALPHA = 0.35
// これより小さく見える付箋（画面の短い辺。CSS ピクセル）には出さない
export const AI_CORNER_MIN_NOTE_PX = 16

// 三角を出す付箋か
export function hasAiCorner(node: NodeRecord | undefined, answeringIds: ReadonlySet<string>): boolean {
  if (node?.type !== 'note') return false
  return answeringIds.has(node.id) || aiNoteMeta(node)?.answer !== undefined
}

// 三角の辺の長さ（ワールド）。付箋の短い辺の 1/3 まで
export function aiCornerSize(w: number, h: number): number {
  return Math.min(AI_CORNER_SIZE, Math.min(w, h) / 3)
}

// 当たり判定の四角の辺の長さ（ワールド）。三角より小さくせず、画面で AI_CORNER_HIT_PX 以上。付箋の短い辺の半分まで
export function aiCornerHitSize(w: number, h: number, zoom: number): number {
  return Math.min(Math.max(aiCornerSize(w, h), AI_CORNER_HIT_PX / zoom), Math.min(w, h) / 2)
}

// 点滅の不透明度（now はミリ秒）。AI_CORNER_MIN_ALPHA と 1 の間を、AI_CORNER_BLINK_MS で行き来する（0 で 1）
export function aiCornerAlpha(now: number): number {
  const phase = (now % AI_CORNER_BLINK_MS) / AI_CORNER_BLINK_MS
  return AI_CORNER_MIN_ALPHA + (1 - AI_CORNER_MIN_ALPHA) * (0.5 + 0.5 * Math.cos(phase * Math.PI * 2))
}

// ワールド座標の点にある三角の付箋（いちばん手前のもの）。なければ null
export function hitAiCorner(editor: Editor, point: Vec, answeringIds: ReadonlySet<string> = editor.session.get().answeringIds): string | null {
  const zoom = editor.session.get().camera.zoom
  const reach = AI_CORNER_HIT_PX / zoom
  const ids = editor.index.search({ x: point.x - reach, y: point.y - reach, w: reach * 2, h: reach * 2 })
  const ordered = editor.index.sortByOrder(ids)
  for (let i = ordered.length - 1; i >= 0; i--) {
    const entry = editor.index.get(ordered[i]!)
    if (!entry || !hasAiCorner(entry.node, answeringIds)) continue
    const { w, h } = noteSize(editor, entry.node)
    if (Math.min(w, h) * zoom < AI_CORNER_MIN_NOTE_PX) continue
    const local = applyMat(invert(entry.worldMatrix), point)
    const hit = aiCornerHitSize(w, h, zoom)
    if (local.x >= w - hit && local.x <= w && local.y >= 0 && local.y <= hit) return entry.node.id
  }
  return null
}

export interface AiCornerState {
  answeringIds: ReadonlySet<string>
  // マウスを乗せている三角の付箋
  hoveredId: string | null
  // 点滅に使う時刻（ミリ秒）
  now: number
}

// 画面に見えている付箋の三角を描く（オーバーレイの層。ctx はデバイスのピクセル）。描いた数を返す
export function drawAiCorners(ctx: CanvasRenderingContext2D, editor: Editor, view: Viewport, state: AiCornerState): number {
  const { camera, dpr } = view
  const visible: Box = { x: camera.x, y: camera.y, w: view.width / camera.zoom, h: view.height / camera.zoom }
  const s = camera.zoom * dpr
  const toDevice = (p: Vec) => ({ x: (p.x - camera.x) * s, y: (p.y - camera.y) * s })
  let drawn = 0
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = AI_CORNER_COLOR
  for (const id of editor.index.sortByOrder(editor.index.search(visible))) {
    const entry = editor.index.get(id)
    if (!entry || !hasAiCorner(entry.node, state.answeringIds)) continue
    const { w, h } = noteSize(editor, entry.node)
    if (Math.min(w, h) * camera.zoom < AI_CORNER_MIN_NOTE_PX) continue
    const size = aiCornerSize(w, h) * (state.hoveredId === id ? AI_CORNER_HOVER_SCALE : 1)
    // 右上の角を直角にした三角（付箋のローカル座標）
    const points = [
      { x: w - size, y: 0 },
      { x: w, y: 0 },
      { x: w, y: size },
    ].map((p) => toDevice(applyMat(entry.worldMatrix, p)))
    ctx.globalAlpha = state.answeringIds.has(id) ? aiCornerAlpha(state.now) : 1
    ctx.beginPath()
    ctx.moveTo(points[0]!.x, points[0]!.y)
    for (const p of points.slice(1)) ctx.lineTo(p.x, p.y)
    ctx.closePath()
    ctx.fill()
    drawn++
  }
  ctx.restore()
  return drawn
}

// 付箋の大きさ（文字に合わせた高さも。ローカル座標の箱の原点は (0, 0)）
function noteSize(editor: Editor, node: NodeRecord): { w: number; h: number } {
  const { w, h } = editor.getType(node).getBounds(node)
  return { w, h }
}
