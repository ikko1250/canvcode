import { baseFormatOf, type LineHeight } from './layout.ts'
import { applyRunFormat, clearRunFormat, type TextRange, type TextRunFormat } from './richText.ts'
import type { RichTextKeys, RichTextTarget } from './richTextTargets.ts'

// デジタル庁デザインシステム（DADS）のテキストスタイル（MAI-114）。名前付きの文字の大きさ・太さ・行間・字間の組で、
// デザインパネルの「文字」の「テキストスタイル」と、AI の edit_canvas の textStyle で、まとめて当てる。一覧はここだけに持つ。
// - 名前は <種類>-<大きさ><N|B>-<行間 %>（Std-17N-170 なら 17px・400・行間 170 %）。N は 400、B は 700 の太さ。
//   どの大きさ・行間にも N と B がある
// - 字間（letter-spacing）は名前に出ない。種類と大きさで決まる（Std は大きさで 0・1 %・2 %）
// - 行間は倍率（170 % → 1.7）、字間は em（2 % → 0.02em）で持つ（ノードの props の lineHeight・letterSpacing と同じ単位）
// - 書体（フォント）は変えない。Mono だけは等幅のスタイルなので、フォントも等幅（monospace）にする
//   （DADS の Mono は Noto Sans Mono。アプリの等幅は、Markdown の `等幅` と同じ monospace）
// もとは DADS の公式サイトの「タイポグラフィ（テキストスタイル一覧）」（2026 年 8 月 5 日更新）

export type TextStyleKind = 'Dsp' | 'Std' | 'Dns' | 'Oln' | 'Mono'

export interface TextStylePreset {
  name: string
  kind: TextStyleKind
  fontSize: number
  fontWeight: 400 | 700
  // 行間の倍率
  lineHeight: number
  // 字間（em）
  letterSpacing: number
  // フォントも決めるスタイル（Mono）。ないものはフォントを変えない
  fontFamily?: string
}

// Mono のスタイルのフォント
export const TEXT_STYLE_MONO_FONT = 'monospace'

// 種類の名前と、一覧の見出し（用途）。並びは DADS の一覧と同じ
export const TEXT_STYLE_KINDS: readonly { kind: TextStyleKind; name: string; use: string }[] = [
  { kind: 'Dsp', name: 'Display', use: '大きな見出し' },
  { kind: 'Std', name: 'Standard', use: '見出し・本文' },
  { kind: 'Dns', name: 'Dense', use: '表・管理画面' },
  { kind: 'Oln', name: 'Oneline', use: 'ボタンなどの 1 行' },
  { kind: 'Mono', name: 'Mono', use: 'コード・等幅' },
]

// 種類ごとの [大きさ（px）, 行間（%）, 字間（em）]。並びは DADS の一覧と同じ（大きい順）
const TEXT_STYLE_ROWS: Record<TextStyleKind, readonly (readonly [number, number, number])[]> = {
  Dsp: [
    [64, 140, 0],
    [57, 140, 0],
    [48, 140, 0],
  ],
  Std: [
    [45, 140, 0],
    [36, 140, 0.01],
    [32, 150, 0.01],
    [28, 150, 0.01],
    [26, 150, 0.02],
    [24, 150, 0.02],
    [22, 150, 0.02],
    [20, 150, 0.02],
    [18, 160, 0.02],
    [17, 170, 0.02],
    [16, 170, 0.02],
    [16, 175, 0.02],
  ],
  Dns: [
    [17, 130, 0],
    [17, 120, 0],
    [16, 130, 0],
    [16, 120, 0],
    [14, 130, 0],
    [14, 120, 0],
  ],
  Oln: [
    [17, 100, 0.02],
    [16, 100, 0.02],
    [14, 100, 0.02],
  ],
  Mono: [
    [17, 150, 0],
    [16, 150, 0],
    [14, 150, 0],
  ],
}

const WEIGHTS = [
  ['N', 400],
  ['B', 700],
] as const

// すべてのスタイル。種類・大きさの順に、同じ大きさ・行間の N と B を隣に並べる
export const TEXT_STYLE_PRESETS: readonly TextStylePreset[] = TEXT_STYLE_KINDS.flatMap(({ kind }) =>
  TEXT_STYLE_ROWS[kind].flatMap(([fontSize, lineHeight, letterSpacing]) =>
    WEIGHTS.map(([mark, fontWeight]): TextStylePreset => ({
      name: `${kind}-${fontSize}${mark}-${lineHeight}`,
      kind,
      fontSize,
      fontWeight,
      lineHeight: lineHeight / 100,
      letterSpacing,
      ...(kind === 'Mono' ? { fontFamily: TEXT_STYLE_MONO_FONT } : {}),
    })),
  ),
)

export const TEXT_STYLE_NAMES: readonly string[] = TEXT_STYLE_PRESETS.map((preset) => preset.name)

export function textStylePreset(name: string): TextStylePreset | undefined {
  return TEXT_STYLE_PRESETS.find((preset) => preset.name === name)
}

// 文字の値（既定に重ねた実際の値。行間・字間はノードの値）が、どのスタイルと同じか。
// 行間は倍率のときだけ見る（px の行間は、文字の大きさを変えると割合が変わるので、どのスタイルでもない）。
// フォントは Mono だけ見る（Mono は等幅のときだけ。ほかのスタイルは、どのフォントでもよい）
export function textStyleOf(values: { fontSize: number; fontWeight: number; fontFamily: string; lineHeight: LineHeight; letterSpacing: number }): TextStylePreset | undefined {
  const { fontSize, fontWeight, fontFamily, lineHeight, letterSpacing } = values
  if (lineHeight.unit !== 'multiplier') return undefined
  return TEXT_STYLE_PRESETS.find(
    (preset) =>
      preset.fontSize === fontSize &&
      preset.fontWeight === fontWeight &&
      near(preset.lineHeight, lineHeight.value) &&
      near(preset.letterSpacing, letterSpacing) &&
      (preset.fontFamily === undefined || preset.fontFamily === fontFamily),
  )
}

// パネルで打った値（% の換算・小数の丸め）の誤差を許す
function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-4
}

// スタイルを当てた props。デザインパネルの文字の項目と同じ当て方にする：
// - 大きさ・太さ（Mono はフォントも）は範囲ごとに持てる。range（編集中に選んでいる範囲）があればその文字に当て、
//   なければノードの既定（props）を変えて、範囲ごとの値を外す
// - 行間・字間はノード単位なので、範囲を選んでいてもノードに当てる
export function applyTextStyle(target: RichTextTarget, props: object, preset: TextStylePreset, range: TextRange | null = null): object {
  const keys = target.keys
  const format: TextRunFormat = { fontSize: preset.fontSize, fontWeight: preset.fontWeight }
  if (preset.fontFamily !== undefined) format.fontFamily = preset.fontFamily
  const next: Record<string, unknown> = {
    ...props,
    [keys.lineHeight]: { unit: 'multiplier', value: preset.lineHeight } satisfies LineHeight,
    [keys.letterSpacing]: preset.letterSpacing,
  }
  const paragraphs = target.paragraphs(props)
  if (range && range.start !== range.end) {
    return target.withParagraphs(next, applyRunFormat(paragraphs, range.start, range.end, format, baseFormatOf(target.style(props))))
  }
  let cleared = paragraphs
  for (const key of Object.keys(format) as (keyof TextRunFormat & keyof RichTextKeys)[]) {
    const propKey = keys[key]
    if (propKey === undefined) continue
    next[propKey] = format[key]
    cleared = clearRunFormat(cleared, key)
  }
  return target.withParagraphs(next, cleared)
}
