import { unionBoxes, type Box } from '@canvcode/core'
import type { Editor } from './editor.ts'
import { activeBrush, type CanvasRefSource } from './refs.ts'
import { slideImageRegion } from './slideImage.ts'

// Canvas を画像にする（MAI-89。docs/canvas-image-plan.md）。描く範囲と大きさ、ファイル名を決める。
// DOM に依存しない純粋な関数だけを置く（描くのは CanvasView.renderImage）。
// - 右クリックの「画像として保存／画像をコピー」と、AI の render_canvas（サーバーがタブに頼む）が使う
// - 範囲選択なら範囲に見えるものを全部、ノードを選んだらそのノード（と子孫）だけ、スライドを 1 枚だけならスライドの枠どおり（印刷用）

// 何を描くか。canvas は Canvas のノード全体を囲む範囲（AI が範囲を決めずに、見ていない Canvas を頼んだとき）
export type ImageTarget =
  | { kind: 'rect'; rect: Box }
  | { kind: 'nodes'; ids: string[] }
  | { kind: 'slide'; id: string }
  | { kind: 'canvas' }

export interface ImageRegion {
  // 描く範囲（ワールド座標）
  box: Box
  // 描くノード（null なら範囲に見えるものを全部）
  only: Set<string> | null
  // 印刷用に描くか（スライドの名前と枠を描かない。Viewport.print）
  print: boolean
  // スライドを描くなら、その id（ファイル名の番号に使う）
  slideId?: string
  // 頼まれたが、この Canvas になかったノード
  missing: string[]
}

export interface ImageSize {
  width: number
  height: number
  // 1 ワールド単位あたりの画素
  scale: number
  // 上限で倍率を下げたか
  capped: boolean
}

// 画像の長い辺と面積の上限。面積は iPad の Safari の canvas の上限（4096×4096）。どの端末でも同じにする
export const IMAGE_MAX_EDGE = 8192
export const IMAGE_MAX_PIXELS = 16_777_216
// 長い辺で決めるとき（AI）に、小さい範囲を大きくしすぎない（ぼやけるだけなので。refImageSize と同じ）
const MAX_FIT_SCALE = 2
// ノードを囲む範囲に足す余白（長い辺の割合と、ワールド単位での下限・上限）
const MARGIN_RATIO = 0.02
const MARGIN_MIN = 8
const MARGIN_MAX = 40

// 描く範囲と、描くノード。描くものがなければ null（範囲が空・ノードが 1 つもない・スライドでない）
export function imageRegion(editor: Editor, target: ImageTarget): ImageRegion | null {
  if (target.kind === 'rect') {
    const { rect } = target
    if (![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) || !(rect.w > 0) || !(rect.h > 0)) return null
    return { box: rect, only: null, print: false, missing: [] }
  }
  if (target.kind === 'slide') {
    const region = slideImageRegion(editor, target.id)
    return region ? { box: region.box, only: region.only, print: true, slideId: target.id, missing: [] } : null
  }
  if (target.kind === 'canvas') {
    const box = inkBoundsOf(editor, editor.index.allIds())
    return box ? { box: withMargin(box), only: null, print: false, missing: [] } : null
  }
  const found = target.ids.filter((id) => editor.index.get(id))
  const missing = target.ids.filter((id) => !editor.index.get(id))
  if (found.length === 0) return null
  // スライドを 1 枚だけ頼まれたら、スライドの枠どおりに描く
  if (found.length === 1 && editor.index.get(found[0])?.node.type === 'slide') {
    const slide = imageRegion(editor, { kind: 'slide', id: found[0] })
    return slide ? { ...slide, missing } : null
  }
  const only = new Set<string>()
  for (const id of found) {
    only.add(id)
    for (const child of editor.index.descendantsOf(id)) only.add(child)
  }
  // 外側の線や影（inkBounds）も切れないよう、子孫も含めて描く範囲で囲む
  const box = inkBoundsOf(editor, only)
  return box ? { box: withMargin(box), only, print: false, missing } : null
}

// 画面の選択から、描くものを決める（右クリック・パイメニュー）。範囲選択なら範囲、スライドを 1 枚だけ選んでいればスライド、
// ほかは選んだノード。どれもなければ null。範囲選択かは、AI に渡す ref と同じ規則で決める（activeBrush）
export function selectionImageTarget(source: CanvasRefSource, typeOf: (id: string) => string | undefined): ImageTarget | null {
  const brush = activeBrush(source)
  if (brush) return brush.rect.w > 0 && brush.rect.h > 0 ? { kind: 'rect', rect: brush.rect } : null
  const ids = [...source.selectedIds]
  if (ids.length === 0) return null
  if (ids.length === 1 && typeOf(ids[0]) === 'slide') return { kind: 'slide', id: ids[0] }
  return { kind: 'nodes', ids }
}

// 画像の大きさ。倍率で決める（ユーザーの等倍・2 倍）か、長い辺で決める（AI。2 倍より大きくはしない）。
// どちらも長い辺 IMAGE_MAX_EDGE・面積 IMAGE_MAX_PIXELS を超えるなら、倍率を下げる
export function imageSize(box: Box, want: { scale: number } | { maxEdge: number }): ImageSize {
  const longest = Math.max(box.w, box.h)
  let scale = 'scale' in want ? want.scale : Math.min(want.maxEdge / longest, MAX_FIT_SCALE)
  const limit = Math.min(IMAGE_MAX_EDGE / longest, Math.sqrt(IMAGE_MAX_PIXELS / (box.w * box.h)))
  const capped = scale > limit
  if (capped) scale = limit
  // 上限で抑えたときは、丸めで上限を超えないよう切り捨てる
  const size = (length: number) => Math.max(1, capped ? Math.floor(length * scale) : Math.round(length * scale))
  return { width: size(box.w), height: size(box.h), scale, capped }
}

// 保存する画像のファイル名。「<Canvas の名前>.png」、スライドなら「<名前> - <番号>.png」。
// ファイル名に使えない文字は「-」に置き換え、空なら canvas にする（スライドの PDF の slidePdfFileName と同じ置き換え）
export function imageFileName(canvasTitle: string, slideNumber?: number | null): string {
  const name = canvasTitle.replace(/[\\/:*?"<>|\p{Cc}]/gu, '-').replace(/\s+/g, ' ').trim() || 'canvas'
  return slideNumber ? `${name} - ${slideNumber}.png` : `${name}.png`
}

function inkBoundsOf(editor: Editor, ids: Iterable<string>): Box | null {
  const boxes: Box[] = []
  for (const id of ids) {
    const bounds = editor.index.get(id)?.inkBounds
    if (bounds) boxes.push(bounds)
  }
  // 幅か高さが 0 の線（水平な矢印など）も、余白を足せば描ける
  return unionBoxes(boxes)
}

function withMargin(box: Box): Box {
  const margin = Math.min(MARGIN_MAX, Math.max(MARGIN_MIN, Math.max(box.w, box.h) * MARGIN_RATIO))
  return { x: box.x - margin, y: box.y - margin, w: box.w + margin * 2, h: box.h + margin * 2 }
}
