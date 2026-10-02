import type { NodeRecord } from '@canvcode/core'
import { geoLabelParagraphs, geoLabelStyle, withGeoLabel, type GeoProps } from '../geo.ts'
import type { TextStyle } from './layout.ts'
import { noteStyle, type NoteProps } from './noteNode.ts'
import { paragraphsOf, type TextParagraph } from './richText.ts'
import { textStyle, type TextProps } from './textNode.ts'

// 段落と run で文字を持つ型（テキスト・付箋・図形の中の文字）の、文字と既定の書式の読み書き。
// デザインパネル・編集中のツールバー・パイメニューの文字の項目は、型によらずこれで扱う（同じ機能を同じ部品で出す）。
// keys は既定の書式を持つ props のキー（ないものは既定を変えられない。付箋の文字の色）
export interface RichTextKeys {
  fontSize?: string
  fontFamily?: string
  fontWeight?: string
  color?: string
  align: string
  lineHeight: string
  letterSpacing: string
}

export interface RichTextTarget {
  // ノードの既定の書式（範囲ごとの書式は、これに重ねる）
  style(props: object): TextStyle
  paragraphs(props: object): TextParagraph[]
  // 文字を paragraphs にした props
  withParagraphs(props: object, paragraphs: TextParagraph[]): object
  keys: RichTextKeys
}

const RICH_TEXT_TARGETS: Record<string, RichTextTarget> = {
  text: {
    style: (props) => textStyle(props as TextProps),
    paragraphs: (props) => paragraphsOf(props as TextProps),
    withParagraphs: (props, paragraphs) => ({ ...props, paragraphs }),
    keys: { fontSize: 'fontSize', fontFamily: 'fontFamily', fontWeight: 'fontWeight', color: 'color', align: 'align', lineHeight: 'lineHeight', letterSpacing: 'letterSpacing' },
  },
  note: {
    style: (props) => noteStyle(props as NoteProps),
    paragraphs: (props) => paragraphsOf(props as NoteProps),
    withParagraphs: (props, paragraphs) => ({ ...props, paragraphs }),
    keys: { fontSize: 'fontSize', fontFamily: 'fontFamily', fontWeight: 'fontWeight', align: 'align', lineHeight: 'lineHeight', letterSpacing: 'letterSpacing' },
  },
  geo: {
    style: (props) => geoLabelStyle(props as GeoProps),
    paragraphs: (props) => geoLabelParagraphs(props as GeoProps),
    withParagraphs: (props, paragraphs) => withGeoLabel(props as GeoProps, paragraphs),
    keys: {
      fontSize: 'labelFontSize',
      fontFamily: 'labelFontFamily',
      fontWeight: 'labelFontWeight',
      color: 'labelColor',
      align: 'labelAlign',
      lineHeight: 'labelLineHeight',
      letterSpacing: 'labelLetterSpacing',
    },
  },
}

export function richTextTargetOf(node: NodeRecord | undefined): RichTextTarget | undefined {
  return node ? RICH_TEXT_TARGETS[node.type] : undefined
}

export function hasRichText(node: NodeRecord | undefined): boolean {
  return richTextTargetOf(node) !== undefined
}
