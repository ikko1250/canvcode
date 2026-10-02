import { createElement } from 'react'
import type { NodeRecord } from '@canvcode/core'
import { textAlignOf, type TextAlign } from '@canvcode/nodes'
import { propField, registerDesignSection, type DesignField, type DesignSection, type SegmentOption } from './registry.ts'

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

export const fontSizeField = propField<number>({
  id: 'text.fontSize',
  label: '大きさ',
  keys: { text: 'fontSize', note: 'fontSize' },
  control: { kind: 'number', min: 1, max: 400, step: 1, unit: 'px' },
})

// テキストの文字の色（付箋の color は地の色なので含めない）
export const textColorField = propField<string>({
  id: 'text.color',
  label: '色',
  keys: { text: 'color' },
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
  { id: 'text', title: '文字', order: 300, fields: [fontSizeField, textColorField, textAlignField] },
  { id: 'layer', title: 'レイヤー', order: 900, fields: [opacityField] },
]

for (const section of builtinDesignSections) registerDesignSection(section)
