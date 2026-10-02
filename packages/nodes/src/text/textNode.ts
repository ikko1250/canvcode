import type { NodeRecord } from '@canvcode/core'
import { defineNodeType } from '../defineNodeType.ts'
import { TEXT_BAR_THRESHOLD_PX, drawTextBars, drawTextLayout, layoutRichText, textAlignOf, type TextAlign, type TextLayout, type TextStyle } from './layout.ts'
import { DEFAULT_FONT_FAMILY, fontFamilyOf, textMetricsGeneration } from './fonts.ts'
import { migratePlainTextProps, paragraphsOf, plainTextOf, richTextFromPlain, type TextParagraph } from './richText.ts'

// テキスト（MAI-7 の `text`、MAI-24）。
// - autoWidth：打った分だけ幅が伸びる（クリックで作ったとき）
// - そうでなければ、幅 w で折り返す（ドラッグで作ったとき、リサイズしたとき）
// 文字は段落と書式付きの文字列（run）で持ち、範囲ごとに色・大きさを変えられる（MAI-74。richText.ts）。
// props の fontSize・color・fontFamily はノードの既定で、run が持たない書式はこれに従う。
// fontFamily（MAI-75）は版を上げずに足した。持たない古いテキストは既定のフォント（今までと同じ）で描く。
// 版 1 は文字をプレーンテキスト（text）で持っていた。読み込むときに版 2（paragraphs）へ移す
export interface TextProps {
  paragraphs: TextParagraph[]
  fontSize: number
  color: string
  // フォントの名前（fonts.ts。MAI-75）。古いレコードにはない（fontFamilyOf で既定として読む）
  fontFamily: string
  align: TextAlign
  w: number
  autoWidth: boolean
}

export type TextNode = NodeRecord<TextProps>

// テキストの初期の大きさ。パイメニューの「タイトル」は、大きさだけが違うテキストとして作る（MAI-62）
export const TEXT_DEFAULT_FONT_SIZE = 12
export const TITLE_FONT_SIZE = 22
const LINE_HEIGHT = 1.35
// 空のときでも、カーソルを置けるだけの幅を持たせる
const MIN_WIDTH_EM = 1

export function textStyle(props: TextProps): TextStyle {
  return {
    fontSize: props.fontSize,
    lineHeight: LINE_HEIGHT,
    fontWeight: 400,
    color: props.color,
    align: textAlignOf(props.align),
    fontFamily: fontFamilyOf(props.fontFamily),
  }
}

// 同じ props のレイアウトは一度だけ計算する（レコードは書き換えないので props で引ける）。
// フォントを読み込み終えて測り直すとき（textMetricsGeneration が変わる）は計算し直す（MAI-75）
const layoutCache = new WeakMap<TextProps, { generation: number; layout: TextLayout }>()

export function textLayout(props: TextProps): TextLayout {
  const generation = textMetricsGeneration()
  let cached = layoutCache.get(props)
  if (!cached || cached.generation !== generation) {
    cached = { generation, layout: layoutRichText(paragraphsOf(props), textStyle(props), props.autoWidth ? null : props.w) }
    layoutCache.set(props, cached)
  }
  return cached.layout
}

function textWidth(props: TextProps): number {
  return props.autoWidth ? Math.max(textLayout(props).width, props.fontSize * MIN_WIDTH_EM) : props.w
}

export const textType = defineNodeType<TextProps>({
  type: 'text',
  version: 2,

  defaultProps: () => ({
    paragraphs: richTextFromPlain(''),
    fontSize: TEXT_DEFAULT_FONT_SIZE,
    color: '#1f2328',
    fontFamily: DEFAULT_FONT_FAMILY,
    align: 'left',
    w: 200,
    autoWidth: true,
  }),

  migrate: (props, fromVersion) => (fromVersion < 2 ? migratePlainTextProps<TextProps>(props) : props),

  getBounds: (node) => ({ x: 0, y: 0, w: textWidth(node.props), h: textLayout(node.props).height }),

  hitTest(node, point, margin) {
    const w = textWidth(node.props)
    const h = textLayout(node.props).height
    return point.x >= -margin && point.y >= -margin && point.x <= w + margin && point.y <= h + margin
  },

  render(ctx, node, info) {
    if (info.editing) return
    const layout = textLayout(node.props)
    const box = { x: 0, y: 0, w: textWidth(node.props), h: layout.height }
    if (layout.maxFontSize * info.zoom < TEXT_BAR_THRESHOLD_PX) drawTextBars(ctx, layout, textStyle(node.props), box, 'top')
    else drawTextLayout(ctx, layout, textStyle(node.props), box, 'top')
  },

  roughColor: () => 'rgba(120, 120, 120, 0.45)',

  // 横に伸ばすと、その幅で折り返すようになる。文字の大きさは変えない
  resize: (node, size) => ({ ...node.props, w: size.w, autoWidth: false }),
  minSize: { w: 16, h: 1 },

  editText: (node) => ({
    text: plainTextOf(paragraphsOf(node.props)),
    style: textStyle(node.props),
    box: { x: 0, y: 0, w: textWidth(node.props), h: textLayout(node.props).height },
    autoWidth: node.props.autoWidth,
    verticalAlign: 'top',
    update: (text) => ({ ...node.props, paragraphs: richTextFromPlain(text) }),
    rich: { paragraphs: paragraphsOf(node.props), update: (paragraphs) => ({ ...node.props, paragraphs }) },
    deleteIfEmpty: true,
  }),
})

