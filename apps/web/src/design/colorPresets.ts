import tokens from '@digital-go-jp/design-tokens'
import { ARROW_COLORS, GEO_DEFAULT_FILL, NOTE_TEXT_COLOR, normalizeColor } from '@canvcode/nodes'
import { COLORS as SLIDE_COLORS } from '@canvcode/slides/core/slide-layout-spec'

// カラーピッカーの「テンプレートの色」（MAI-81）。
// - スライド：スライドのテーマ色（packages/slides の slide-layout-spec.ts の COLORS。スライドに置く図の色をそろえるため）
// - キャンバス：アプリの標準の色（ペン・矢印の 5 色と、図形・付箋の既定の色、それに合う淡い色）
// - DADS：デジタル庁デザインシステムの色（MAI-114）。キーカラー（Blue）・ニュートラルカラー・セマンティックカラーの 3 つに分ける。
//   DADS に沿った図やスライドを作るときに使う。値は @digital-go-jp/design-tokens の JS 版から取る（版を上げると付いてくる）。
//   名前は DADS の名前（Blue-900・Solid Gray-536・Error-1 など）

export interface ColorPreset {
  color: string
  name: string
}

export interface ColorPresetGroup {
  name: string
  colors: readonly ColorPreset[]
}

// トークンの値（#rrggbb）
function tokenColor(token: { $value?: unknown }): string {
  return normalizeColor(String(token.$value))
}

const { Primitive, Neutral, Semantic } = tokens.Color

const DADS_KEY_STEPS = ['50', '100', '200', '900', '1000', '1200'] as const
const DADS_GRAY_STEPS = ['50', '420', '536', '600', '800', '900'] as const

export const DADS_COLOR_PRESET_GROUPS: readonly ColorPresetGroup[] = [
  {
    name: 'DADS キーカラー',
    colors: DADS_KEY_STEPS.map((step) => ({ color: tokenColor(Primitive.Blue[step]), name: `Blue-${step}` })),
  },
  {
    name: 'DADS ニュートラル',
    colors: [
      { color: tokenColor(Neutral.White), name: 'White' },
      ...DADS_GRAY_STEPS.map((step) => ({ color: tokenColor(Neutral.SolidGray[step]), name: `Solid Gray-${step}` })),
      { color: tokenColor(Neutral.Black), name: 'Black' },
    ],
  },
  {
    name: 'DADS セマンティック',
    colors: [
      { color: tokenColor(Semantic.Success[1]), name: 'Success-1' },
      { color: tokenColor(Semantic.Success[2]), name: 'Success-2' },
      { color: tokenColor(Semantic.Error[1]), name: 'Error-1' },
      { color: tokenColor(Semantic.Error[2]), name: 'Error-2' },
      { color: tokenColor(Semantic.Warning.Yellow[1]), name: 'Warning-Yellow-1' },
      { color: tokenColor(Semantic.Warning.Yellow[2]), name: 'Warning-Yellow-2' },
      { color: tokenColor(Semantic.Warning.Orange[1]), name: 'Warning-Orange-1' },
      { color: tokenColor(Semantic.Warning.Orange[2]), name: 'Warning-Orange-2' },
    ],
  },
]

export const COLOR_PRESET_GROUPS: readonly ColorPresetGroup[] = [
  {
    name: 'スライド',
    colors: [
      { color: SLIDE_COLORS.ink, name: '文字' },
      { color: SLIDE_COLORS.paper, name: '紙' },
      { color: SLIDE_COLORS.panel, name: 'パネル' },
      { color: SLIDE_COLORS.figureBorder, name: '図の枠' },
      { color: SLIDE_COLORS.creamA, name: 'クリーム A' },
      { color: SLIDE_COLORS.creamB, name: 'クリーム B' },
    ],
  },
  {
    name: 'キャンバス',
    colors: [
      { color: ARROW_COLORS[0], name: '黒' },
      { color: ARROW_COLORS[1], name: '赤' },
      { color: ARROW_COLORS[2], name: '青' },
      { color: ARROW_COLORS[3], name: '緑' },
      { color: ARROW_COLORS[4], name: 'オレンジ' },
      { color: '#3b5bdb', name: '図形の線' },
      { color: NOTE_TEXT_COLOR, name: '付箋の文字' },
      { color: GEO_DEFAULT_FILL, name: '淡い青' },
      { color: '#e6f6ec', name: '淡い緑' },
      { color: '#fff4e6', name: '淡いオレンジ' },
      { color: '#f3e8fc', name: '淡い紫' },
      { color: '#fdecee', name: '淡い赤' },
      { color: '#fff3bf', name: '付箋の黄色' },
      { color: '#ffffff', name: '白' },
    ],
  },
  ...DADS_COLOR_PRESET_GROUPS,
]
