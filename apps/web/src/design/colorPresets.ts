import { ARROW_COLORS, GEO_DEFAULT_FILL, NOTE_TEXT_COLOR } from '@canvcode/nodes'
import { COLORS as SLIDE_COLORS } from '@canvcode/slides/core/slide-layout-spec'

// カラーピッカーの「テンプレートの色」（MAI-81）。
// - スライド：スライドのテーマ色（packages/slides の slide-layout-spec.ts の COLORS。スライドの図にするフレームの色をそろえるため）
// - キャンバス：アプリの標準の色（ペン・矢印の 5 色と、図形・付箋の既定の色、それに合う淡い色）

export interface ColorPreset {
  color: string
  name: string
}

export interface ColorPresetGroup {
  name: string
  colors: readonly ColorPreset[]
}

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
]
