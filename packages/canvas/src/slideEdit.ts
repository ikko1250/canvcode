import type { Vec } from '@canvcode/core'
import { slideSize, type SlideProps, type SlideRatio } from '@canvcode/nodes'

// スライド（スライド v2）の props を変える計算。DOM に依存しない純粋な関数だけを置く。
// 書き込むのは呼び出し側（Editor）で、1 回の操作にまとめる

// 中心が center になるときの左上（大きさは縦横比から決まる）
export function slideTopLeft(center: Vec, ratio: SlideRatio): Vec {
  const { w, h } = slideSize(ratio)
  return { x: center.x - w / 2, y: center.y - h / 2 }
}

// 比率を切り替える：16:9 ⇔ 4:3。知らない値（壊れたデータ）は 16:9 として扱うので、4:3 にする
export function toggledSlideRatio(ratio: SlideRatio): SlideRatio {
  return ratio === '4:3' ? '16:9' : '4:3'
}

// 非表示にする／表示する：1 つでも表示中のものがあれば全部を非表示に、全部が非表示なら全部を表示にする
export function toggledSlidesHidden(slides: readonly Pick<SlideProps, 'hidden'>[]): boolean {
  return slides.some((s) => !s.hidden)
}
