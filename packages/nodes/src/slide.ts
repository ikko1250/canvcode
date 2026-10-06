import type { NodeRecord } from '@canvcode/core'
import { drawFrameBox, drawFrameLabel, frameHitTest } from './container.ts'
import { defineNodeType, type HitTestInfo } from './defineNodeType.ts'

// スライド（スライド v2）。キャンバスに置く 16:9 / 4:3 の枠で、位置から順番を決めて PDF に出す。
// frame と同じく子を枠で切り抜いて描き、名前の部分と枠の線で当たる。
// 大きさは props に持たず、縦横比から決める（リサイズできない）

export type SlideRatio = '16:9' | '4:3'

export interface SlideProps {
  ratio: SlideRatio
  name: string
  // 書き出しや番号の対象から外すか
  hidden: boolean
}

export type SlideNode = NodeRecord<SlideProps>

// 縦横比ごとの大きさ（ワールド単位）。高さはどちらも 1080
export const SLIDE_SIZES: Record<SlideRatio, { w: number; h: number }> = {
  '16:9': { w: 1920, h: 1080 },
  '4:3': { w: 1440, h: 1080 },
}

// 知らない値（壊れたデータ）は 16:9 として扱う
export function slideSize(ratio: SlideRatio): { w: number; h: number } {
  return SLIDE_SIZES[ratio] ?? SLIDE_SIZES['16:9']
}

// 非表示のスライドは、枠と中身（子孫）をまとめてこの不透明度で描く（基盤の描画が掛ける）
export const HIDDEN_SLIDE_OPACITY = 0.35

// 非表示のスライドか
export function isHiddenSlide(node: NodeRecord): boolean {
  return node.type === 'slide' && (node.props as Partial<SlideProps>).hidden === true
}

// 文字があふれている・並べられなかった行があるスライドの、名前の後ろに付ける警告
export const SLIDE_OVERFLOW_WARNING = '⚠ あふれ'
// 警告を付けた名前の色（画面で目立たせる）
const OVERFLOW_LABEL_COLOR = '#e03131'

// 名前の位置に描く文字列。表示するスライドは「3. 名前」（名前が空なら「3」）、非表示なら「非表示 · 名前」（空なら「非表示」）。
// 番号が引けない（引く先がない・今のキャンバスにない）ときは名前だけ。overflow なら後ろに警告を付ける（「3. 名前 ⚠ あふれ」）
export function slideLabel(name: string, number: number | null, hidden: boolean, overflow = false): string {
  const label = baseLabel(name, number, hidden)
  if (!overflow) return label
  return label ? `${label} ${SLIDE_OVERFLOW_WARNING}` : SLIDE_OVERFLOW_WARNING
}

function baseLabel(name: string, number: number | null, hidden: boolean): string {
  if (hidden) return name ? `非表示 · ${name}` : '非表示'
  if (number === null) return name
  return name ? `${number}. ${name}` : String(number)
}

function overflowsOf(node: SlideNode, info: HitTestInfo | undefined): boolean {
  return info?.slides?.overflows?.(node.id) === true
}

function labelOf(node: SlideNode, info: HitTestInfo | undefined): string {
  return slideLabel(node.props.name, info?.slides?.number(node.id) ?? null, node.props.hidden, overflowsOf(node, info))
}

export const slideType = defineNodeType<SlideProps>({
  type: 'slide',
  version: 1,

  defaultProps: () => ({ ratio: '16:9', name: '', hidden: false }),

  getBounds: (node) => ({ x: 0, y: 0, ...slideSize(node.props.ratio) }),

  // 名前の部分の幅は、描く文字列（番号や「非表示」、あふれの警告を付けたもの）に合わせる
  hitTest(node, point, margin, zoom, info) {
    const { w, h } = slideSize(node.props.ratio)
    return frameHitTest(w, h, labelOf(node, info), point, margin, zoom)
  },

  // 非表示のスライドを薄くするのは、子孫とまとめて基盤の描画がする（ここでは描く文字列だけを変える）。
  // PDF に出す画像（info.print）では、白い地だけを描く（名前・番号と枠の線は画面で見分けるためのもの）
  render(ctx, node, info) {
    const { w, h } = slideSize(node.props.ratio)
    if (info.print) {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, w, h)
      return
    }
    drawFrameBox(ctx, w, h, info.zoom)
    drawFrameLabel(ctx, labelOf(node, info), info.zoom, overflowsOf(node, info) ? OVERFLOW_LABEL_COLOR : undefined)
  },

  roughColor: () => '#ffffff',

  // resize を定義しないので、リサイズできない。
  // 回転もさせない（位置から順番を決めるのと、PDF に出すのに合わない）
  canRotate: false,
  container: 'frame',
})
