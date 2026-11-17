import type { NodeRecord } from '@canvcode/core'
import { roundedRectPath } from './cornerRadius.ts'
import { defineNodeType } from './defineNodeType.ts'
import { TEXT_BAR_THRESHOLD_PX, drawTextBars, drawTextLayout, layoutText, type TextLayout, type TextStyle } from './text/layout.ts'
import { DEFAULT_FONT_FAMILY, textMetricsGeneration } from './text/fonts.ts'

// ボタン（キャンバスの AI。付箋で聞き、付箋で答える）。押すと、prompt を Claude に送る。
// - AI の答え（段落ごとの付箋をまとめたフレーム）の中に置き、答えを書き直す指示（「Mac 向けにする」「もっと簡単な言葉で」）を持つ。
//   押すと、入っているフレームの答えを、その指示で書き直す（画面の apps/web/src/claude/answer.ts）
// - 選んでいないボタンをクリックすると押す（選ばない）。ドラッグすると、選んで動かす。選んでからダブルクリックか Enter で、文字を変える
//   （選択ツール。押せる型は pressable）
// - 幅は、sizing が 'auto'（新しく作るボタンの既定）なら文字に合わせ（AUTO_MAX_WIDTH より長ければ折り返す）、'fixed' なら w。高さは文字に合わせる
// - hint は、AI が答えと一緒に置いたボタン（答えを書き直すたびに、新しい答えのボタンと入れ替える）。人が置いたボタンは持たない（入れ替えない）
// - questionIds は、答えのもとになった質問の付箋（AI が置いたボタンが持つ）。書き直すときに、その付箋の今の文字も Claude に渡す。
//   複製・貼り付けでは、一緒に写した付箋なら写した方を指し、写さなかった付箋は元のまま指す（フレームだけを写しても、質問がわかるように）
// - action は、Claude に送らないボタン（AI が答えのフレームに置く）。ask-left / ask-right は、答えの左・右に続きの質問の付箋を置く「＋」、
//   version は、答えを version 番目の版に戻す（進む）帯。h は高さ（なければ文字に合わせる）、tooltip はホバーで出す説明
export type ButtonAction = 'ask-left' | 'ask-right' | 'version'

export interface ButtonProps {
  // ボタンに出す文字
  label: string
  // 押したときに Claude に送る指示。空なら label を送る
  prompt: string
  // 地の色
  color: string
  w: number
  sizing: 'auto' | 'fixed'
  hint?: boolean
  questionIds?: string[]
  action?: ButtonAction
  version?: number
  h?: number
  tooltip?: string
}

export type ButtonNode = NodeRecord<ButtonProps>

export const BUTTON_FONT_SIZE = 13
export const BUTTON_COLOR = '#e7efff'
const BUTTON_TEXT_COLOR = '#1f4b99'
const BUTTON_BORDER_COLOR = '#9db8ea'
const PADDING_X = 14
const PADDING_Y = 8
// 文字に合わせるときの幅の上限（これより長い文字は折り返す）と、幅の下限
const AUTO_MAX_WIDTH = 260
const MIN_WIDTH = 48
// 幅を決めたボタン（「＋」・版の帯）の幅と高さの下限
const MIN_FIXED_WIDTH = 16
const MIN_HEIGHT = 4
const RADIUS = 8

export function buttonStyle(): TextStyle {
  return { fontSize: BUTTON_FONT_SIZE, lineHeight: 1.35, fontWeight: 500, color: BUTTON_TEXT_COLOR, align: 'center', fontFamily: DEFAULT_FONT_FAMILY }
}

// 押したときに送る指示
export function buttonInstruction(props: Pick<ButtonProps, 'label' | 'prompt'>): string {
  return props.prompt.trim() || props.label.trim()
}

const layoutCache = new WeakMap<ButtonProps, { generation: number; layout: TextLayout; w: number }>()

// 文字のレイアウトと幅。フォントを読み込み終えて測り直すとき（textMetricsGeneration が変わる）は計算し直す
function buttonLayout(props: ButtonProps): { layout: TextLayout; w: number } {
  const generation = textMetricsGeneration()
  let cached = layoutCache.get(props)
  if (!cached || cached.generation !== generation) {
    const text = props.label || ' '
    let w: number
    if (props.sizing === 'auto') {
      const single = layoutText(text, buttonStyle(), null)
      w = Math.max(MIN_WIDTH, Math.min(AUTO_MAX_WIDTH, Math.ceil(single.width) + PADDING_X * 2))
    } else {
      w = Math.max(MIN_FIXED_WIDTH, props.w)
    }
    cached = { generation, layout: layoutText(text, buttonStyle(), Math.max(1, w - paddingX(w) * 2)), w }
    layoutCache.set(props, cached)
  }
  return cached
}

export function buttonSize(props: ButtonProps): { w: number; h: number } {
  const { layout, w } = buttonLayout(props)
  return { w, h: props.h !== undefined ? Math.max(MIN_HEIGHT, props.h) : Math.ceil(layout.height) + PADDING_Y * 2 }
}

// 左右の余白（細いボタンでは、1 文字が収まるように狭める）
function paddingX(w: number): number {
  return Math.max(2, Math.min(PADDING_X, (w - BUTTON_FONT_SIZE) / 2))
}

function textBox(props: ButtonProps) {
  const { w, h } = buttonSize(props)
  const x = paddingX(w)
  const y = Math.min(PADDING_Y, h / 2)
  return { x, y, w: Math.max(1, w - x * 2), h: Math.max(1, h - y * 2) }
}

export const buttonType = defineNodeType<ButtonProps>({
  type: 'button',
  version: 1,

  defaultProps: () => ({ label: 'ボタン', prompt: '', color: BUTTON_COLOR, w: 120, sizing: 'auto' }),

  getBounds: (node) => ({ x: 0, y: 0, ...buttonSize(node.props) }),

  hitTest: (node, point, margin) => {
    const { w, h } = buttonSize(node.props)
    return point.x >= -margin && point.y >= -margin && point.x <= w + margin && point.y <= h + margin
  },

  render(ctx, node, info) {
    const { w, h } = buttonSize(node.props)
    const radius = Math.min(RADIUS, h / 2)
    ctx.beginPath()
    roundedRectPath(ctx, { x: 0, y: 0, w, h }, [radius, radius, radius, radius])
    ctx.fillStyle = node.props.color
    ctx.fill()
    // 線の太さは、倍率によらず画面上でほぼ 1 ピクセル（拡大しても太くしすぎない）
    ctx.lineWidth = Math.min(1, 1 / info.zoom)
    ctx.strokeStyle = BUTTON_BORDER_COLOR
    ctx.stroke()
    if (info.editing || !node.props.label) return
    const { layout } = buttonLayout(node.props)
    const style = buttonStyle()
    if (layout.maxFontSize * info.zoom < TEXT_BAR_THRESHOLD_PX) drawTextBars(ctx, layout, style, textBox(node.props), 'middle')
    else drawTextLayout(ctx, layout, style, textBox(node.props), 'middle')
  },

  roughColor: (node) => node.props.color,

  colors: (node) => [node.props.color],

  // 幅を変える（高さは、決めてあれば高さも。なければ文字に合わせる）。幅を変えたら、文字に合わせるのをやめる
  resize(node, size) {
    const props = node.props
    const h = props.h !== undefined ? { h: Math.max(MIN_HEIGHT, size.h) } : {}
    if (props.sizing === 'auto' && Math.abs(size.w - buttonSize(props).w) < 1 && props.h === undefined) return props
    return { ...props, ...h, w: Math.max(MIN_FIXED_WIDTH, size.w), sizing: 'fixed' }
  },
  minSize: { w: MIN_FIXED_WIDTH, h: 1 },

  pressable: true,

  remapIds: (node, map) => (node.props.questionIds ? { ...node.props, questionIds: node.props.questionIds.map((id) => map(id) ?? id) } : node.props),

  editText: (node) => ({
    text: node.props.label,
    style: buttonStyle(),
    box: textBox(node.props),
    autoWidth: false,
    verticalAlign: 'middle',
    // ボタンの文字は 1 行（Enter で編集を終える。貼り付けた改行は空白にする）
    update: (text) => ({ ...node.props, label: text.replace(/\s*\n\s*/g, ' ') }),
    deleteIfEmpty: false,
    singleLine: true,
  }),
})
