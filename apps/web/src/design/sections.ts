import { createElement } from 'react'
import type { NodeRecord, Vec } from '@canvcode/core'
import {
  applyRunFormat,
  clampOpacity,
  clampTileScale,
  convertPaint,
  coverCrop,
  GEO_DEFAULT_FILL,
  imagePaint,
  isGradientPaint,
  normalizeCrop,
  solidPaint,
  sortStops,
  toFill,
  withGradientAngle,
  type Fill,
  type GradientStop,
  type ImageCrop,
  type ImageScaleMode,
  type PaintType,
  baseFormatOf,
  clearRunFormat,
  convertLineHeight,
  formatAt,
  formatsInRange,
  letterSpacingOf,
  LETTER_SPACING_LIMITS,
  lineHeightOf,
  listOf,
  listStyleOf,
  listStyleTargets,
  paragraphIndexesInRange,
  setListStyle,
  setListType,
  noteStyle,
  paragraphsOf,
  richTextLength,
  textAlignOf,
  textStyle,
  type LineHeight,
  type LineHeightUnit,
  type NoteProps,
  type TextAlign,
  type TextListStyle,
  type TextListType,
  type TextParagraph,
  type TextProps,
  type TextRunFormat,
  type TextStyle,
  type TextToggleFormat,
} from '@canvcode/nodes'
import { sameValue } from '@canvcode/canvas'
import { propField, registerDesignSection, type DesignField, type DesignSection, type FieldControl, type SegmentOption, type SelectOption } from './registry.ts'

// デザインパネルに最初から出すセクション（MAI-73）。
// 塗り・線・文字・レイヤーの 4 つ。後の課題は、ここに項目を足すか、別のファイルで registerDesignSection する

// ---- 塗り ----

// 塗り（MAI-81）。図形の塗り（paint.ts の Fill：種類＋中身・不透明度・塗りなし）と、付箋の地の色（付箋の color）。
// 値は Fill。書くときは、塗りそのもののほか、色だけ・不透明度だけを変えられる（複数を選んで色が違っても、不透明度だけをそろえるなど）。
// 付箋の地は単色だけ：不透明度・塗りなし・グラデーションは持たない（control の opacity・none・gradient が false。パネルはそのボタンを出さない）。
// グラデーション（MAI-82）：種類の切り替え（今の色から始める。paint.ts の convertPaint）、止め色の並び、線形の角度、円形の中心・半径。
// 角度はノードの箱の大きさで見た向きなので、ノードごとに換算する（withGradientAngle）。
// 画像（MAI-83）：画像を選ぶ（image。今が画像なら表示のしかたなどはそのまま）、表示のしかた（scaleMode）、切り抜く範囲（crop）、タイルの倍率（tileScale）。
// 切り抜きへ切り替えるときは、塗りつぶしで見えていた範囲から始める（ノードの箱の大きさで決まるので、ノードごとに換算する）
export type FillChange =
  | Fill
  | { change: 'color'; color: string }
  | { change: 'opacity'; opacity: number }
  | { change: 'type'; type: Exclude<PaintType, 'image'> }
  | { change: 'image'; assetId: string }
  // image は画像の元の大きさ（画素）。切り抜きへ切り替えるときに使う
  | { change: 'scaleMode'; scaleMode: ImageScaleMode; image?: { width: number; height: number } }
  | { change: 'crop'; crop: Partial<ImageCrop> }
  | { change: 'tileScale'; tileScale: number }
  | { change: 'stops'; stops: GradientStop[] }
  | { change: 'angle'; angle: number }
  | { change: 'radial'; center?: Vec; radius?: number }

const FILL_TYPES = new Set(['geo', 'note'])

function readFill(node: NodeRecord): Fill {
  const props = node.props as { fill?: unknown; color?: string }
  if (node.type === 'note') return solidPaint(props.color ?? '#ffffff')
  return toFill(props.fill)
}

// グラデーションの角度の換算に使う、ノードの箱の大きさ（図形の w・h）
export function paintBoxSize(node: NodeRecord): { w: number; h: number } {
  const props = node.props as { w?: unknown; h?: unknown }
  return { w: typeof props.w === 'number' && props.w > 0 ? props.w : 1, h: typeof props.h === 'number' && props.h > 0 ? props.h : 1 }
}

// 今の塗りに、変更を当てた塗り。size はノードの箱の大きさ（線形の角度の換算）
export function applyFillChange(current: Fill, change: FillChange, size: { w: number; h: number } = { w: 1, h: 1 }): Fill {
  if (change === null || !('change' in change)) return change
  switch (change.change) {
    case 'color':
      return current?.type === 'solid' ? { ...current, color: change.color } : solidPaint(change.color, current?.opacity ?? 1)
    case 'opacity':
      return current ? { ...current, opacity: clampOpacity(change.opacity) } : current
    case 'type':
      return convertPaint(current, change.type, GEO_DEFAULT_FILL)
    case 'stops':
      return isGradientPaint(current) && change.stops.length >= 2 ? { ...current, stops: sortStops(change.stops) } : current
    case 'angle':
      return current?.type === 'linear' ? withGradientAngle(current, change.angle, size) : current
    case 'radial':
      if (current?.type !== 'radial') return current
      return { ...current, center: change.center ?? current.center, radius: Math.max(0, change.radius ?? current.radius) }
    case 'image':
      return current?.type === 'image' ? { ...current, assetId: change.assetId } : imagePaint(change.assetId, { opacity: current?.opacity ?? 1 })
    case 'scaleMode': {
      if (current?.type !== 'image' || current.scaleMode === change.scaleMode) return current
      const full = current.crop.x === 0 && current.crop.y === 0 && current.crop.w === 1 && current.crop.h === 1
      const crop = change.scaleMode === 'crop' && full && change.image ? coverCrop(change.image, size) : current.crop
      return { ...current, scaleMode: change.scaleMode, crop }
    }
    case 'crop':
      return current?.type === 'image' ? { ...current, crop: normalizeCrop({ ...current.crop, ...change.crop }) } : current
    case 'tileScale':
      return current?.type === 'image' ? { ...current, tileScale: clampTileScale(change.tileScale) } : current
  }
}

export const fillField: DesignField<FillChange> = {
  id: 'fill.paint',
  label: '色',
  control: {
    kind: 'paint',
    opacity: (node) => node.type === 'geo',
    none: (node) => node.type === 'geo',
    gradient: (node) => node.type === 'geo',
    image: (node) => node.type === 'geo',
  },
  appliesTo: (node) => FILL_TYPES.has(node.type),
  read: readFill,
  write(node, change) {
    if (!FILL_TYPES.has(node.type)) return node
    const props = node.props as Record<string, unknown>
    const current = readFill(node)
    const next = applyFillChange(current, change, paintBoxSize(node))
    if (sameValue(next, current)) return node
    if (node.type === 'note') {
      // 付箋の地は単色の色だけを変える（塗りなし・不透明度は持たない）
      return next?.type === 'solid' && next.color !== props.color ? { ...node, props: { ...props, color: next.color } } : node
    }
    return { ...node, props: { ...props, fill: next } }
  },
}

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

// 太字・斜体・下線・取り消し線（MAI-79）。run の書式の true / false で、範囲ごとに持てる。
// ノード全体に当てるとき（文字を編集していない・範囲を選んでいない）は、props に既定を持たせず、すべての文字（run）に当てる
// （textFormatField の「既定を props に持たない型」と同じ）。押したときの値は、すべてオンならオフ、そうでなければオン（toggledValue）。
// 文字を編集中は、パネル・ツールバーのボタンも Ctrl+B などと同じ TextEditor.toggleFormat で切り替える（textToggles.ts）
export const TEXT_STYLE_GROUP = 'スタイル'

function letterIcon(letter: string, style: Record<string, string | number>) {
  return function LetterIcon() {
    return createElement(
      'svg',
      { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true },
      createElement('text', { x: 8, y: 12.5, textAnchor: 'middle', fontSize: 13, fontFamily: 'Georgia, serif', fill: 'currentColor', style }, letter),
    )
  }
}

function toggleField(key: TextToggleFormat, title: string, icon: ReturnType<typeof letterIcon>) {
  return textFormatField({ id: `text.${key}`, label: title, key, control: { kind: 'toggle', title, icon, group: TEXT_STYLE_GROUP } })
}

export const boldField = toggleField('bold', '太字', letterIcon('B', { fontWeight: 700 }))
export const italicField = toggleField('italic', '斜体', letterIcon('I', { fontStyle: 'italic' }))
export const underlineField = toggleField('underline', '下線', letterIcon('U', { textDecoration: 'underline' }))
export const strikethroughField = toggleField('strikethrough', '取り消し線', letterIcon('S', { textDecoration: 'line-through' }))

export const TEXT_TOGGLE_FIELDS: Record<TextToggleFormat, DesignField<boolean>> = {
  bold: boldField,
  italic: italicField,
  underline: underlineField,
  strikethrough: strikethroughField,
}

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

// 箇条書き・番号付きリスト（MAI-78）。段落ごとの属性（richText.ts の TextList）。
// 文字を編集中で範囲を選んでいれば、その範囲にかかる段落に当て、そうでなければノードのすべての段落に当てる（値が違えば「混在」）
type ListKind = TextListType | 'none'

function listParagraphs(node: NodeRecord): TextParagraph[] {
  return paragraphsOf(node.props as { paragraphs?: TextParagraph[] })
}

function withParagraphs(node: NodeRecord, paragraphs: TextParagraph[]): NodeRecord {
  const props = node.props as Record<string, unknown>
  const next = { ...props, paragraphs }
  return sameValue(next, props) ? node : { ...node, props: next }
}

const LIST_TYPE_OPTIONS: SegmentOption[] = [
  { value: 'none', title: 'リストにしない', label: 'なし' },
  { value: 'bullet', title: '箇条書き', label: '箇条書き' },
  { value: 'ordered', title: '番号付きリスト', label: '番号' },
]

export const listTypeField: DesignField<ListKind> = {
  id: 'text.list',
  label: 'リスト',
  control: { kind: 'segmented', options: LIST_TYPE_OPTIONS },
  appliesTo: (node) => TEXT_FORMAT_TYPES[node.type] !== undefined,
  read: (node) => listTypeField.values!(node, null)[0],
  values(node, range) {
    const paragraphs = listParagraphs(node)
    const indexes = range ? paragraphIndexesInRange(paragraphs, range.start, range.end) : paragraphs.map((_, i) => i)
    return indexes.map((i) => listOf(paragraphs[i])?.type ?? 'none')
  },
  write(node, value, range) {
    if (!listTypeField.appliesTo(node)) return node
    return withParagraphs(node, setListType(listParagraphs(node), range ?? null, value))
  },
}

// 記号・番号の形。一番浅い階層の段落に当てる（深い階層は階層ごとの既定のまま。richText.ts の setListStyle）。
// 「なし」はリストを外す
const LIST_STYLE_OPTIONS: SelectOption[] = [
  { value: 'none', label: 'なし' },
  { value: 'disc', label: '• 黒丸', group: '箇条書き' },
  { value: 'circle', label: '◦ 白丸', group: '箇条書き' },
  { value: 'square', label: '▪ 四角', group: '箇条書き' },
  { value: 'dash', label: '– ダッシュ', group: '箇条書き' },
  { value: 'check', label: '✓ チェック', group: '箇条書き' },
  { value: 'decimal', label: '1. 数字', group: '番号' },
  { value: 'decimal-paren', label: '1) 数字と括弧', group: '番号' },
  { value: 'paren-decimal', label: '(1) 括弧付きの数字', group: '番号' },
  { value: 'lower-alpha', label: 'a. 英字', group: '番号' },
  { value: 'lower-roman', label: 'i. ローマ数字', group: '番号' },
  { value: 'circled', label: '① 丸数字', group: '番号' },
]

export const listStyleField: DesignField<TextListStyle | 'none'> = {
  id: 'text.listStyle',
  label: '記号',
  control: { kind: 'select', options: LIST_STYLE_OPTIONS },
  appliesTo: (node) => TEXT_FORMAT_TYPES[node.type] !== undefined,
  read: (node) => listStyleField.values!(node, null)[0],
  values(node, range) {
    return listStyleTargets(listParagraphs(node), range).map((paragraph) => {
      const list = listOf(paragraph)
      return list ? listStyleOf(list) : 'none'
    })
  },
  write(node, value, range) {
    if (!listStyleField.appliesTo(node)) return node
    const paragraphs = listParagraphs(node)
    return withParagraphs(node, value === 'none' ? setListType(paragraphs, range ?? null, 'none') : setListStyle(paragraphs, range ?? null, value))
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
  { id: 'fill', title: '塗り', order: 100, fields: [fillField] },
  { id: 'stroke', title: '線', order: 200, fields: [strokeColorField, strokeWidthField] },
  { id: 'text', title: '文字', order: 300, fields: [fontFamilyField, fontSizeField, boldField, italicField, underlineField, strikethroughField, lineHeightField, letterSpacingField, textColorField, textAlignField, listTypeField, listStyleField] },
  { id: 'layer', title: 'レイヤー', order: 900, fields: [opacityField] },
]

for (const section of builtinDesignSections) registerDesignSection(section)
