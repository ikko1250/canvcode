import { createElement } from 'react'
import type { NodeRecord, Vec } from '@canvcode/core'
import {
  defaultShadow,
  hasShadows,
  shadowsOf,
  toShadow,
  type Shadow,
  canRoundCorners,
  clampDash,
  defaultDashGap,
  defaultDashLength,
  GEO_DEFAULT_STROKE_WIDTH,
  hasBorder,
  strokeStyleOf,
  type StrokeAlign,
  type StrokeDash,
  cornerRadii,
  toCornerRadius,
  type CornerRadius,
  type GeoProps,
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
import { sameValue, type SharedValue } from '@canvcode/canvas'
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

// ---- 角丸 ----

// 角丸（MAI-84）。矩形の図形だけ（geo.ts の canRoundCorners）。値は保存してある cornerRadius（ないときは 0）。
// 書くときは、半径そのもののほか、corner が null なら 4 つの角を一緒に（数値で持つ）、そうでなければその角だけ（4 つが同じになれば数値にまとめる）。
// 半径はそのまま持ち、短い辺の半分などに収めるのは描くとき（cornerRadius.ts の effectiveCornerRadii）
export type CornerRadiusChange = CornerRadius | { corner: number | null; radius: number }

export const cornerRadiusField: DesignField<CornerRadiusChange> = {
  id: 'corner.radius',
  label: '半径',
  control: { kind: 'cornerRadius' },
  appliesTo: canRoundCorners,
  read: (node) => (node.props as GeoProps).cornerRadius ?? 0,
  write(node, change) {
    if (!canRoundCorners(node)) return node
    let next: CornerRadius
    if (typeof change === 'number' || Array.isArray(change)) {
      next = toCornerRadius(cornerRadii(change))
    } else if (change.corner === null) {
      next = Math.max(0, change.radius)
    } else {
      const radius = Math.max(0, change.radius)
      const radii = cornerRadii(node.props.cornerRadius)
      radii[change.corner] = radius
      next = toCornerRadius(radii)
    }
    if (sameValue(next, node.props.cornerRadius ?? 0)) return node
    return { ...node, props: { ...node.props, cornerRadius: next } }
  },
}

// ---- 線 ----

// 線（MAI-73）は、図形の枠（MAI-85 のボーダー）・矢印・フリーハンドの線で、色と太さを共通の項目にする（混ぜて選んでも出す）。
// 位置・種類・破線の長さと間隔は、図形だけの項目（選んでいるノードがすべて図形で、線があるときだけ出す）

// 線の色。値は塗り（Fill）の形にそろえ、塗りの項目と同じ PaintField（単色だけ）で見せる。
// 図形の線は単色の塗り（色・不透明度。線なしは null。stroke.ts の StrokePaint）。
// 矢印・フリーハンドの線は色の文字列（color）のまま：単色として読み、書くときは色だけを変える（不透明度・線なしは出さない。付箋の地と同じ）
const STROKE_COLOR_KEYS: Readonly<Record<string, string>> = { arrow: 'color', draw: 'color' }

function readStroke(node: NodeRecord): Fill {
  if (hasBorder(node)) return strokeStyleOf(node.props).paint
  const color = (node.props as Record<string, unknown>)[STROKE_COLOR_KEYS[node.type]]
  return solidPaint(typeof color === 'string' ? color : '#000000')
}

export const strokeColorField: DesignField<FillChange> = {
  id: 'stroke.color',
  label: '色',
  control: { kind: 'paint', role: 'stroke', opacity: hasBorder, none: hasBorder, gradient: () => false, image: () => false },
  appliesTo: (node) => hasBorder(node) || STROKE_COLOR_KEYS[node.type] !== undefined,
  read: readStroke,
  write(node, change) {
    if (!strokeColorField.appliesTo(node)) return node
    const current = readStroke(node)
    const next = applyFillChange(current, change)
    // 線は単色だけ
    if ((next !== null && next.type !== 'solid') || sameValue(next, current)) return node
    if (hasBorder(node)) {
      const props = { ...node.props, stroke: next }
      // 太さ 0 の図形に線を足したら、見えるよう既定の太さにする
      if (current === null && next !== null && !(node.props.strokeWidth > 0)) props.strokeWidth = GEO_DEFAULT_STROKE_WIDTH
      return { ...node, props }
    }
    if (next === null || (current?.type === 'solid' && next.color === current.color)) return node
    return { ...node, props: { ...(node.props as object), [STROKE_COLOR_KEYS[node.type]]: next.color } }
  },
}

export const strokeWidthField = propField<number>({
  id: 'stroke.width',
  label: '太さ',
  keys: { geo: 'strokeWidth', arrow: 'size', draw: 'size' },
  control: { kind: 'number', min: 0, max: 40, step: 0.5, unit: 'px', slider: true },
})

// 図形の線があるか（位置・種類の項目を出すか）
function hasBorderStroke(node: NodeRecord): boolean {
  return hasBorder(node) && strokeStyleOf(node.props).paint !== null
}

function strokeIcon(draw: (stroke: string) => ReturnType<typeof createElement>[]) {
  return function StrokeIcon() {
    return createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true }, ...draw('currentColor'))
  }
}

// 位置のアイコン：点線の四角が形の縁、太い四角が線（内側・中央・外側）
function borderAlignIcon(inset: number) {
  return strokeIcon((color) => [
    createElement('rect', { key: 'edge', x: 3.5, y: 3.5, width: 9, height: 9, fill: 'none', stroke: color, strokeWidth: 0.75, strokeDasharray: '1.5 1.5', opacity: 0.7 }),
    createElement('rect', { key: 'line', x: 3.5 + inset, y: 3.5 + inset, width: 9 - inset * 2, height: 9 - inset * 2, fill: 'none', stroke: color, strokeWidth: 2 }),
  ])
}

const STROKE_ALIGN_OPTIONS: SegmentOption[] = [
  { value: 'inside', title: '内側', icon: borderAlignIcon(1.5) },
  { value: 'center', title: '中央', icon: borderAlignIcon(0) },
  { value: 'outside', title: '外側', icon: borderAlignIcon(-1.5) },
]

export const strokeAlignField: DesignField<StrokeAlign> = {
  id: 'stroke.align',
  label: '位置',
  control: { kind: 'segmented', options: STROKE_ALIGN_OPTIONS },
  appliesTo: hasBorderStroke,
  read: (node) => strokeStyleOf(node.props as object).align,
  write(node, value) {
    if (!hasBorder(node) || strokeStyleOf(node.props).align === value) return node
    return { ...node, props: { ...node.props, strokeAlign: value } }
  },
}

function dashIcon(dash: string, cap: 'butt' | 'round') {
  return strokeIcon((color) => [createElement('line', { key: 'l', x1: 2, x2: 14, y1: 8, y2: 8, stroke: color, strokeWidth: 2, strokeDasharray: dash, strokeLinecap: cap })])
}

const STROKE_DASH_OPTIONS: SegmentOption[] = [
  { value: 'solid', title: '実線', icon: dashIcon('none', 'butt') },
  { value: 'dashed', title: '破線', icon: dashIcon('4 2', 'butt') },
  { value: 'dotted', title: '点線', icon: dashIcon('0 4', 'round') },
]

// 線の種類。破線・点線にするとき、長さ・間隔を持たなければ、今の太さに合わせた既定（太さの 4 倍・2 倍の px）を入れる
export const strokeDashField: DesignField<StrokeDash> = {
  id: 'stroke.dash',
  label: '種類',
  control: { kind: 'segmented', options: STROKE_DASH_OPTIONS },
  appliesTo: hasBorderStroke,
  read: (node) => strokeStyleOf(node.props as object).dash,
  write(node, value) {
    if (!hasBorder(node) || strokeStyleOf(node.props).dash === value) return node
    const props = { ...node.props, strokeDash: value }
    if (value !== 'solid') {
      const width = strokeStyleOf(node.props).width
      if (!(typeof props.strokeDashLength === 'number' && props.strokeDashLength > 0)) props.strokeDashLength = defaultDashLength(width)
      if (!(typeof props.strokeDashGap === 'number' && props.strokeDashGap > 0)) props.strokeDashGap = defaultDashGap(width)
    }
    return { ...node, props }
  },
}

// 破線の長さ・間隔（px）。長さは破線だけ、間隔は破線・点線（点の縁どうしの間）
function dashLengthField(id: string, label: string, key: 'strokeDashLength' | 'strokeDashGap', dashes: readonly StrokeDash[]): DesignField<number> {
  const read = (node: NodeRecord) => {
    const style = strokeStyleOf(node.props as object)
    return key === 'strokeDashLength' ? style.dashLength : style.dashGap
  }
  return {
    id,
    label,
    control: { kind: 'number', min: 0.5, max: 100, step: 0.5, unit: 'px' },
    appliesTo: (node) => hasBorderStroke(node) && dashes.includes(strokeStyleOf(node.props as object).dash),
    read,
    write(node, value) {
      if (!hasBorder(node)) return node
      const next = clampDash(value)
      if (read(node) === next && node.props[key] === next) return node
      return { ...node, props: { ...node.props, [key]: next } }
    },
  }
}

export const strokeDashLengthField = dashLengthField('stroke.dashLength', '長さ', 'strokeDashLength', ['dashed'])
export const strokeDashGapField = dashLengthField('stroke.dashGap', '間隔', 'strokeDashGap', ['dashed', 'dotted'])

// ---- 効果（影） ----

// 影（MAI-86。Figma の Effects）。図形だけ（geo.ts の hasShadows）。値は影の一覧（shadow.ts の shadowsOf。ないときは空）。
// 書くときは、一覧そのもの（混在のときの＋は、既定の影 1 つに置き換える）のほか、
// 足す（末尾に既定の影）・消す（index 番目）・変える（index 番目の値の一部。色・ずらしなど）。
// 複数を選んだときは、どのノードにも同じ変更を当てる（影の数と種類が同じなら、index 番目どうしを変える）
export type ShadowsChange =
  | Shadow[]
  | { op: 'add' }
  | { op: 'remove'; index: number }
  | { op: 'update'; index: number; patch: Partial<Shadow> }

// 今の影の一覧に、変更を当てたもの
export function applyShadowsChange(current: readonly Shadow[], change: ShadowsChange): Shadow[] {
  if (Array.isArray(change)) return change.map(toShadow).filter((s): s is Shadow => s !== null)
  switch (change.op) {
    case 'add':
      return [...current, defaultShadow()]
    case 'remove':
      return current.filter((_, i) => i !== change.index)
    case 'update':
      return current.map((shadow, i) => {
        if (i !== change.index) return shadow
        // 範囲に収める。表示（visible が true）は値を持たない（ないときは表示）
        return toShadow({ ...shadow, ...change.patch }) ?? shadow
      })
  }
}

// 選んでいるノードの影の一覧から、影ごとの値（ノードの間で比べたもの）を作る。数か種類の並びが違えば null（混在）
export function shadowRows(value: SharedValue<Shadow[]>): Shadow[][] | null {
  const lists = value.kind === 'same' ? [value.value] : value.values
  const first = lists[0] ?? []
  if (!lists.every((list) => list.length === first.length && list.every((shadow, i) => shadow.type === first[i].type))) return null
  return first.map((_, i) => lists.map((list) => list[i]))
}

export const shadowsField: DesignField<ShadowsChange> = {
  id: 'effects.shadows',
  label: '影',
  control: { kind: 'shadows' },
  appliesTo: hasShadows,
  read: (node) => shadowsOf(node.props as GeoProps),
  write(node, change) {
    if (!hasShadows(node)) return node
    const current = shadowsOf(node.props)
    const next = applyShadowsChange(current, change)
    if (sameValue(next, current)) return node
    const props: GeoProps = { ...node.props, shadows: next }
    // 影がなくなれば、値も持たない（古いデータと同じ形）
    if (next.length === 0) delete props.shadows
    return { ...node, props }
  },
}

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
  { id: 'corner', title: '角丸', order: 150, fields: [cornerRadiusField] },
  { id: 'stroke', title: '線', order: 200, fields: [strokeColorField, strokeWidthField, strokeAlignField, strokeDashField, strokeDashLengthField, strokeDashGapField] },
  { id: 'effects', title: '効果', order: 250, fields: [shadowsField] },
  { id: 'text', title: '文字', order: 300, fields: [fontFamilyField, fontSizeField, boldField, italicField, underlineField, strikethroughField, lineHeightField, letterSpacingField, textColorField, textAlignField, listTypeField, listStyleField] },
  { id: 'layer', title: 'レイヤー', order: 900, fields: [opacityField] },
]

for (const section of builtinDesignSections) registerDesignSection(section)
