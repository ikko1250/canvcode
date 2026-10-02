import { createElement } from 'react'
import type { NodeRecord } from '@canvcode/core'
import {
  applyRunFormat,
  baseFormatOf,
  clearRunFormat,
  convertLineHeight,
  formatAt,
  formatsInRange,
  letterSpacingOf,
  LETTER_SPACING_LIMITS,
  lineHeightOf,
  noteStyle,
  paragraphsOf,
  richTextLength,
  textAlignOf,
  textStyle,
  type LineHeight,
  type LineHeightUnit,
  type NoteProps,
  type TextAlign,
  type TextParagraph,
  type TextProps,
  type TextRunFormat,
  type TextStyle,
} from '@canvcode/nodes'
import { sameValue } from '@canvcode/canvas'
import { propField, registerDesignSection, type DesignField, type DesignSection, type FieldControl, type SegmentOption } from './registry.ts'

// デザインパネルに最初から出すセクション（MAI-73）。
// 塗り・線・文字・レイヤーの 4 つ。後の課題は、ここに項目を足すか、別のファイルで registerDesignSection する

// ---- 塗り ----

// 図形の塗りと、付箋の地の色（付箋の color は地の色）
export const fillColorField = propField<string>({
  id: 'fill.color',
  label: '色',
  keys: { geo: 'fill', note: 'color' },
  control: { kind: 'color' },
})

// ---- 線 ----

// 図形の枠、矢印、フリーハンドの線の色
export const strokeColorField = propField<string>({
  id: 'stroke.color',
  label: '色',
  keys: { geo: 'stroke', arrow: 'color', draw: 'color' },
  control: { kind: 'color' },
})

export const strokeWidthField = propField<number>({
  id: 'stroke.width',
  label: '太さ',
  keys: { geo: 'strokeWidth', arrow: 'size', draw: 'size' },
  control: { kind: 'number', min: 0, max: 40, step: 0.5, unit: 'px', slider: true },
})

// ---- 文字 ----

// 文字の範囲ごとに持てる書式（MAI-74）を持つ型。base はノードの既定の書式、props はその既定を持つ props のキー
// （ないものは既定を変えられない。付箋の文字の色）
interface TextFormatType {
  base(props: object): Required<TextRunFormat>
  props: Partial<Record<keyof TextRunFormat, string>>
}

const TEXT_FORMAT_TYPES: Record<string, TextFormatType> = {
  text: { base: (props) => baseFormatOf(textStyle(props as TextProps)), props: { color: 'color', fontSize: 'fontSize', fontFamily: 'fontFamily' } },
  note: { base: (props) => baseFormatOf(noteStyle(props as NoteProps)), props: { fontSize: 'fontSize', fontFamily: 'fontFamily' } },
}

// 文字の範囲ごとに持てる書式の項目（MAI-74）。
// - 文字を編集中で範囲を選んでいれば、その範囲の文字の値を見せ（違えば「混在」）、その範囲に当てる
// - そうでなければノード全体：すべての文字の値を見せ、変えるとノードの既定（props）を変えて範囲ごとの値を外す。
//   既定を props に持たない型（付箋の文字の色）は、すべての文字に当てる
export function textFormatField<K extends keyof TextRunFormat>(options: {
  id: string
  label: string
  key: K
  control: FieldControl
}): DesignField<Required<TextRunFormat>[K]> {
  const { key } = options
  type V = Required<TextRunFormat>[K]
  const typeOf = (node: NodeRecord) => TEXT_FORMAT_TYPES[node.type]
  const values = (node: NodeRecord, range: { start: number; end: number } | null): V[] => {
    const base = typeOf(node)!.base(node.props)
    const paragraphs = paragraphsOf(node.props as { paragraphs?: TextParagraph[] })
    const formats = range ? formatsInRange(paragraphs, range.start, range.end) : formatsInRange(paragraphs, 0, richTextLength(paragraphs))
    const list = formats.length > 0 ? formats : [formatAt(paragraphs, range?.start ?? 0)]
    return list.map((format) => (format?.[key] ?? base[key]) as V)
  }
  return {
    id: options.id,
    label: options.label,
    control: options.control,
    appliesTo: (node) => typeOf(node) !== undefined,
    read: (node) => values(node, null)[0],
    values,
    write(node, value, range) {
      const type = typeOf(node)
      if (!type) return node
      const props = node.props as Record<string, unknown>
      const base = type.base(props)
      const paragraphs = paragraphsOf(props as { paragraphs?: TextParagraph[] })
      const patch = { [key]: value } as TextRunFormat
      let next: Record<string, unknown>
      if (range && range.start !== range.end) {
        next = { ...props, paragraphs: applyRunFormat(paragraphs, range.start, range.end, patch, base) }
      } else if (type.props[key]) {
        next = { ...props, [type.props[key]]: value, paragraphs: clearRunFormat(paragraphs, key) }
      } else {
        next = { ...props, paragraphs: applyRunFormat(paragraphs, 0, richTextLength(paragraphs), patch, base) }
      }
      return sameValue(next, props) ? node : { ...node, props: next }
    },
  }
}

// フォント（MAI-75）。値はフォントの名前（fonts.ts）。一覧は fontList.ts
export const fontFamilyField = textFormatField({
  id: 'text.fontFamily',
  label: 'フォント',
  key: 'fontFamily',
  control: { kind: 'font' },
})

export const fontSizeField = textFormatField({
  id: 'text.fontSize',
  label: '大きさ',
  key: 'fontSize',
  control: { kind: 'number', min: 1, max: 400, step: 1, unit: 'px' },
})

// 文字の色（付箋の color は地の色。付箋の文字の色は、既定を変えず、文字に当てる）
export const textColorField = textFormatField({
  id: 'text.color',
  label: '色',
  key: 'color',
  control: { kind: 'color' },
})

// アイコンは 3 本の横線で、揃えの側をそろえる（左端のパレットと同じ形。MAI-50）
function alignIcon(lines: [number, number][]) {
  return function AlignIcon() {
    return createElement(
      'svg',
      { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true },
      lines.map(([x1, x2], i) =>
        createElement('line', { key: i, x1, x2, y1: 4 + i * 4, y2: 4 + i * 4, stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      ),
    )
  }
}

const ALIGN_OPTIONS: SegmentOption[] = [
  { value: 'left', title: '左揃え', icon: alignIcon([[2, 14], [2, 10], [2, 14]]) },
  { value: 'center', title: '中央揃え', icon: alignIcon([[2, 14], [4, 12], [2, 14]]) },
  { value: 'right', title: '右揃え', icon: alignIcon([[2, 14], [6, 14], [2, 14]]) },
]

// 古い付箋には align がないので、左揃えとして読む（MAI-50）
export const textAlignField: DesignField<TextAlign> = {
  ...propField<TextAlign>({ id: 'text.align', label: '揃え', keys: { text: 'align', note: 'align' }, control: { kind: 'segmented', options: ALIGN_OPTIONS } }),
  read: (node) => textAlignOf((node.props as { align?: TextAlign }).align),
}

// 行の高さ（MAI-76）。ノード単位（段落ごとには持たない）で、倍率か px。
// 値は LineHeight。{ convertTo } を書くと、見た目を変えずに単位だけを変える（ノードの既定の文字の大きさで換算する。
// 複数のノードを選んでいれば、それぞれの大きさで換算する）
export type LineHeightChange = LineHeight | { convertTo: LineHeightUnit }

const LINE_HEIGHT_STYLES: Record<string, (props: object) => TextStyle> = {
  text: (props) => textStyle(props as TextProps),
  note: (props) => noteStyle(props as NoteProps),
}

export const lineHeightField: DesignField<LineHeightChange> = {
  id: 'text.lineHeight',
  label: '行間',
  control: { kind: 'lineHeight' },
  appliesTo: (node) => LINE_HEIGHT_STYLES[node.type] !== undefined,
  // 行の高さを持たない古いノードは、型の既定の倍率（テキスト 1.35、付箋 1.4）を見せる
  read: (node) => lineHeightOf(LINE_HEIGHT_STYLES[node.type]!(node.props)),
  write(node, change) {
    const styleOf = LINE_HEIGHT_STYLES[node.type]
    if (!styleOf) return node
    const style = styleOf(node.props)
    const current = lineHeightOf(style)
    const next = 'convertTo' in change ? convertLineHeight(current, change.convertTo, style.fontSize) : change
    if (sameValue(next, current)) return node
    return { ...node, props: { ...(node.props as object), lineHeight: next } }
  },
}

// 文字間（MAI-77）。ノード単位で、props には em（文字の大きさに対する割合）で持つ。
// パネルでは Figma と同じく文字の大きさに対する % で見せる（5% = 0.05em）。持たない古いノードは 0
export const letterSpacingField: DesignField<number> = {
  ...propField<number>({
    id: 'text.letterSpacing',
    label: '文字間',
    keys: { text: 'letterSpacing', note: 'letterSpacing' },
    control: {
      kind: 'number',
      min: LETTER_SPACING_LIMITS.min * 100,
      max: LETTER_SPACING_LIMITS.max * 100,
      step: 0.5,
      unit: '%',
      toDisplay: (value) => Number((value * 100).toFixed(1)),
      fromDisplay: (value) => Number((value / 100).toFixed(4)),
    },
  }),
  read: (node) => letterSpacingOf((node.props as { letterSpacing?: unknown }).letterSpacing),
  write(node, value) {
    if (!letterSpacingField.appliesTo(node) || letterSpacingField.read(node) === value) return node
    return { ...node, props: { ...(node.props as object), letterSpacing: value } }
  },
}

// ---- レイヤー ----

// 不透明度はノードのレコードの opacity（0〜1）。パネルでは 0〜100 % で見せる。
// group と frame は子に効かない（描画はノードごと）ので出さない
const CONTAINER_TYPES = new Set(['group', 'frame'])

export const opacityField: DesignField<number> = {
  id: 'layer.opacity',
  label: '不透明度',
  appliesTo: (node: NodeRecord) => !CONTAINER_TYPES.has(node.type),
  read: (node) => node.opacity,
  write: (node, opacity) => (node.opacity === opacity ? node : { ...node, opacity }),
  control: {
    kind: 'number',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    slider: true,
    toDisplay: (value) => Math.round(value * 100),
    fromDisplay: (value) => value / 100,
  },
}

export const builtinDesignSections: DesignSection[] = [
  { id: 'fill', title: '塗り', order: 100, fields: [fillColorField] },
  { id: 'stroke', title: '線', order: 200, fields: [strokeColorField, strokeWidthField] },
  { id: 'text', title: '文字', order: 300, fields: [fontFamilyField, fontSizeField, lineHeightField, letterSpacingField, textColorField, textAlignField] },
  { id: 'layer', title: 'レイヤー', order: 900, fields: [opacityField] },
]

for (const section of builtinDesignSections) registerDesignSection(section)
