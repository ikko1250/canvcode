import type { NodeRecord } from '@canvcode/core'
import { geoLabelBox, geoLabelLayout, geoLabelPadding, type GeoProps } from './geo.ts'
import { plainTextOf, paragraphsOf } from './text/richText.ts'
import { textLayout, type TextProps } from './text/textNode.ts'

// ノードの文字が、ノードの箱からあふれるか（スライド v2）。
// テンプレートが表のセル・箇条書きの行として並べた図形は、行を増やすと高さが縮む。文字は縮めずに折り返すので、
// 折り返した文字の高さが箱に収まらなければ、あふれとして知らせる（印を出すのは呼び出し側）。
// 測るのは描画と同じレイアウト（geoLabelLayout・textLayout。折り返し・行の高さ・文字間・フォントが同じ）。
// 文字の幅は layout.ts と同じく、Canvas があれば measureText で、なければ（Node でのテスト）概算で測る。
// - geo：ラベルの箱（余白を除いた geoLabelBox）の高さと比べる
// - text：高さは文字から決まり、箱からはあふれない。呼び出し側が上限の高さ（maxHeight）を渡したときだけ、それと比べる
//   （渡さなければ null）。autoWidth のテキストも、改行の分だけ高さが伸びるので同じく比べる
// 文字を持たない型は null。文字が空なら、何も描かないのであふれない（contentHeight は 0）
export interface TextOverflow {
  overflows: boolean
  // 文字の高さ（折り返した行の高さの和）
  contentHeight: number
  // 文字を置ける高さ
  availableHeight: number
}

export interface TextOverflowOptions {
  // text の上限の高さ（ワールド座標の px）
  maxHeight?: number
}

// 行の高さを足し合わせた誤差で、ちょうど収まる文字をあふれとしないための許し
const OVERFLOW_TOLERANCE = 0.01

export function textOverflow(node: NodeRecord, options: TextOverflowOptions = {}): TextOverflow | null {
  if (node.type === 'geo') {
    const props = node.props as GeoProps
    const availableHeight = geoLabelBox(props).h
    // 描画（geo.ts の render）と同じく、label が空なら文字を描かない
    if (!props.label) return { overflows: false, contentHeight: 0, availableHeight }
    return overflowOf(geoLabelLayout(props).height, availableHeight)
  }
  if (node.type === 'text') {
    const { maxHeight } = options
    if (maxHeight === undefined) return null
    const props = node.props as TextProps
    if (plainTextOf(paragraphsOf(props)) === '') return { overflows: false, contentHeight: 0, availableHeight: maxHeight }
    return overflowOf(textLayout(props).height, maxHeight)
  }
  return null
}

function overflowOf(contentHeight: number, availableHeight: number): TextOverflow {
  return { overflows: contentHeight > availableHeight + OVERFLOW_TOLERANCE, contentHeight, availableHeight }
}

// geo の文字が収まる高さ（折り返した文字の高さ＋上下の余白）。幅 w で折り返して測る（スライド v2 の行の高さの配分に使う）。
// 測るのは textOverflow と同じ配置（geoLabelLayout）。文字が空なら上下の余白だけ
export function geoFitHeight(props: GeoProps, w: number = props.w): number {
  const padding = geoLabelPadding(props)
  const sized = w === props.w ? props : { ...props, w }
  const content = sized.label ? geoLabelLayout(sized).height : 0
  return content + padding.top + padding.bottom
}
