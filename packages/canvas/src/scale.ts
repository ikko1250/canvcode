import type { Box, NodeRecord, Vec } from '@canvcode/core'
import { mapRunFormats, richTextTargetOf, type AnyNodeTypeDef, type LineHeight, type Shadow } from '@canvcode/nodes'

// 選んだノードをまとめて拡大・縮小する（MCP の edit_canvas の scale）。DOM に依存しない純粋な関数だけを置く。
// 位置は呼び出し側が写す。ここでは、ノードのローカルの形（w・h、点列、矢印の端と曲がり）と、文字の大きさ・線の太さを倍率 s で変える

export type ScaleAnchor = 'top-left' | 'top' | 'top-right' | 'left' | 'center' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right'

export const SCALE_ANCHORS: readonly ScaleAnchor[] = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right']

// 箱の中の位置（割合。0 は左・上、1 は右・下）
const ANCHOR_FRACTIONS: Record<ScaleAnchor, Vec> = {
  'top-left': { x: 0, y: 0 },
  top: { x: 0.5, y: 0 },
  'top-right': { x: 1, y: 0 },
  left: { x: 0, y: 0.5 },
  center: { x: 0.5, y: 0.5 },
  right: { x: 1, y: 0.5 },
  'bottom-left': { x: 0, y: 1 },
  bottom: { x: 0.5, y: 1 },
  'bottom-right': { x: 1, y: 1 },
}

export function anchorPoint(box: Box, anchor: ScaleAnchor): Vec {
  const f = ANCHOR_FRACTIONS[anchor]
  return { x: box.x + box.w * f.x, y: box.y + box.h * f.y }
}

// box を縦横比を保って rect に収める倍率（大きさが 0 の軸は見ない。どちらも 0 なら null）
export function fitScale(box: Box, rect: Box): number | null {
  const factors: number[] = []
  if (box.w > 0) factors.push(rect.w / box.w)
  if (box.h > 0) factors.push(rect.h / box.h)
  return factors.length ? Math.min(...factors) : null
}

export interface ScaleOptions {
  // 文字の大きさも変えるか
  text: boolean
  // 線の太さ・破線・影も変えるか
  strokes: boolean
  // 縮めた文字の大きさの下限（もともとこれより小さい文字は、そのままの大きさにする）
  minFontSize?: number
}

export function scaledFontSize(size: number, s: number, minFontSize?: number): number {
  return minFontSize === undefined ? size * s : Math.max(size * s, Math.min(minFontSize, size))
}

export interface ScaledNode {
  props: Record<string, unknown>
  // 文字の大きさが何倍になったか（範囲ごとの大きさも含めて最も大きい倍率。下限で止めなければ s、文字を変えないなら 1）
  textFactor: number
  // 小さくできる限度（minSize）で止めたか
  clamped: boolean
}

// ノードの props を s 倍にする。bounds はノードのローカルの箱（index の localBounds）
export function scaleNodeProps(node: NodeRecord, type: AnyNodeTypeDef, bounds: Box, s: number, options: ScaleOptions): ScaledNode {
  let props: Record<string, unknown> = { ...(node.props as Record<string, unknown>) }
  let textFactor = options.text ? s : 1
  if (options.text) {
    const text = scaleRichText(node, props, s, options.minFontSize)
    if (text) {
      props = text.props
      textFactor = text.factor
    }
  }
  let clamped = false
  switch (node.type) {
    case 'arrow':
      props.start = scaleVec(props.start, s)
      props.end = scaleVec(props.end, s)
      if (typeof props.bend === 'number') props.bend = props.bend * s
      break
    // 点列をそのまま s 倍にする（def.resize は線の太さを残して伸ばすので使わない）
    case 'draw':
      if (Array.isArray(props.points)) props.points = (props.points as number[]).map((v) => v * s)
      break
    // 幅を決めたテキストは、文字と同じ倍率で幅を変える（折り返しを保つ）。幅が文字に合わせて伸びるものは、そのまま
    case 'text':
      if (props.autoWidth !== true && typeof props.w === 'number') {
        const min = type.minSize?.w ?? 1
        const w = props.w * textFactor
        props.w = Math.max(w, min)
        clamped = w < min
      }
      break
    default:
      if (type.resize && type.container !== 'group') {
        const resized = resizeTo(node, props, type, bounds, s)
        props = resized.props
        clamped = resized.clamped
        // 文字に合わせている付箋は、高さが文字に付いてくるので、合わせたままにする（高さを固定しない）
        if (node.type === 'note' && (node.props as { sizing?: unknown }).sizing === 'auto') props.sizing = 'auto'
      }
  }
  if (node.type === 'geo') {
    props.cornerRadius = scaleLengths(props.cornerRadius, s)
    props.labelPadding = scaleLengths(props.labelPadding, s)
    if (props.cornerRadius === undefined) delete props.cornerRadius
    if (props.labelPadding === undefined) delete props.labelPadding
  }
  if (options.strokes) scaleStroke(node.type, props, s)
  return { props, textFactor, clamped }
}

// 型の resize で s 倍の大きさにする。minSize で止める（縦横比を保つ型は、両方を同じ倍率で止める）
function resizeTo(node: NodeRecord, props: Record<string, unknown>, type: AnyNodeTypeDef, bounds: Box, s: number): { props: Record<string, unknown>; clamped: boolean } {
  const min = type.minSize ?? { w: 1, h: 1 }
  let w = bounds.w * s
  let h = bounds.h * s
  if (type.lockAspectRatio) {
    const f = Math.max(s, bounds.w > 0 ? min.w / bounds.w : 0, bounds.h > 0 ? min.h / bounds.h : 0)
    w = bounds.w * f
    h = bounds.h * f
  } else {
    w = Math.max(w, min.w)
    h = Math.max(h, min.h)
  }
  const clamped = w > bounds.w * s || h > bounds.h * s
  return { props: type.resize!({ ...node, props }, { w, h }) as Record<string, unknown>, clamped }
}

// 文字（既定の大きさ・範囲ごとの大きさ・px の行の高さ）を変える。文字を持たない型は null
function scaleRichText(node: NodeRecord, props: Record<string, unknown>, s: number, minFontSize: number | undefined): { props: Record<string, unknown>; factor: number } | null {
  const target = richTextTargetOf(node)
  const key = target?.keys.fontSize
  if (!target || !key) return null
  const base = target.style(props).fontSize
  const fontSize = scaledFontSize(base, s, minFontSize)
  let factor = base > 0 ? fontSize / base : s
  // stepTextFontSize と同じく、範囲ごとの大きさもそれぞれ変え、既定と同じになったものは外す
  const paragraphs = mapRunFormats(
    target.paragraphs(props),
    (format) => {
      if (format?.fontSize === undefined) return format
      const size = scaledFontSize(format.fontSize, s, minFontSize)
      if (format.fontSize > 0) factor = Math.max(factor, size / format.fontSize)
      return { ...format, fontSize: size }
    },
    { fontSize },
  )
  const next = target.withParagraphs({ ...props, [key]: fontSize }, paragraphs) as Record<string, unknown>
  const lineHeight = next[target.keys.lineHeight] as LineHeight | undefined
  if (lineHeight?.unit === 'px' && typeof lineHeight.value === 'number') next[target.keys.lineHeight] = { ...lineHeight, value: lineHeight.value * factor }
  return { props: next, factor }
}

// 線の太さ・破線の長さと間隔・影
function scaleStroke(type: string, props: Record<string, unknown>, s: number): void {
  const times = (key: string) => {
    if (typeof props[key] === 'number') props[key] = (props[key] as number) * s
  }
  if (type === 'geo') {
    times('strokeWidth')
    times('strokeDashLength')
    times('strokeDashGap')
    if (Array.isArray(props.shadows)) {
      props.shadows = (props.shadows as Shadow[]).map((shadow) => ({ ...shadow, x: shadow.x * s, y: shadow.y * s, blur: shadow.blur * s, spread: shadow.spread * s }))
    }
  } else if (type === 'arrow') {
    times('size')
    times('strokeDashLength')
    times('strokeDashGap')
  } else if (type === 'draw') {
    times('size')
  }
}

function scaleVec(value: unknown, s: number): unknown {
  const v = value as Vec | undefined
  return v && typeof v.x === 'number' && typeof v.y === 'number' ? { x: v.x * s, y: v.y * s } : value
}

// 長さ（数値・配列・辺ごとの形）を s 倍にする（角丸・文字の余白）
function scaleLengths(value: unknown, s: number): unknown {
  if (typeof value === 'number') return value * s
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'number' ? v * s : v))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v === 'number' ? v * s : v]))
  }
  return value
}
