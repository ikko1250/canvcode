import type { Box } from '@canvcode/core'
import { slideSize, type SlideProps } from '@canvcode/nodes'
import type { Editor } from './editor.ts'

// PDF に出すスライドの画像（スライド v2）。描く範囲と大きさを決める。DOM に依存しない純粋な関数だけを置く
// （描くのは CanvasView.renderSlideImage）。
// - 範囲はスライドの箱ちょうど。スライドは回転しないので、ワールドの箱がそのまま枠になる
// - 描くのはスライドとその子孫だけ（上に重なった別のノードは写さない）
// - 倍率は SLIDE_IMAGE_SCALE で決まる（16:9 → 3840×2160、4:3 → 2880×2160）

// ワールド 1 単位を何画素で描くか
export const SLIDE_IMAGE_SCALE = 2

export interface SlideImageRegion {
  // 描く範囲（ワールド座標）
  box: Box
  scale: number
  // 画像の大きさ（画素）
  width: number
  height: number
  // 描くノード（スライドとその子孫）
  only: Set<string>
  // ページの大きさ（ワールド単位。slideSize と同じ）
  size: { w: number; h: number }
}

// PDF の 1 ページ分の画像。width / height はページの大きさ（ワールド単位）
export interface SlideImage {
  png: Blob
  width: number
  height: number
}

// スライドを描く範囲と大きさ。スライドが見つからない・slide でなければ null。
// 非表示のスライドも返す（PDF に出すかどうかは呼び出し側が決める。描くときは薄くしない）
export function slideImageRegion(editor: Editor, slideId: string): SlideImageRegion | null {
  const entry = editor.index.get(slideId)
  if (!entry || entry.node.type !== 'slide') return null
  const box = entry.worldBounds
  if (box.w <= 0 || box.h <= 0) return null
  return {
    box,
    scale: SLIDE_IMAGE_SCALE,
    width: Math.max(1, Math.round(box.w * SLIDE_IMAGE_SCALE)),
    height: Math.max(1, Math.round(box.h * SLIDE_IMAGE_SCALE)),
    only: new Set([slideId, ...editor.index.descendantsOf(slideId)]),
    size: slideSize((entry.node.props as SlideProps).ratio),
  }
}
