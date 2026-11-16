import type { NodeRecord } from '@canvcode/core'
import { geoLabelParagraphs, geoLabelStyle, withGeoLabel, type GeoProps } from '../geo.ts'
import { baseFormatOf, type TextStyle } from './layout.ts'
import { noteStyle, type NoteProps } from './noteNode.ts'
import { hasRichFormatting, parseRichMarkdown, richTextToMarkdown, standardMarkdownOf } from './richMarkdown.ts'
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
  return node ? richTextTargetOfType(node.type) : undefined
}

export function richTextTargetOfType(type: string): RichTextTarget | undefined {
  return Object.hasOwn(RICH_TEXT_TARGETS, type) ? RICH_TEXT_TARGETS[type] : undefined
}

// ---- Markdown（richMarkdown.ts）との行き来。MCP（edit_canvas の md・read_nodes）・コピー・貼り付けで使う ----

// ノードの文字の Markdown（ノードの既定の書式と同じ値は書かない）
export function richTextMarkdownOf(target: RichTextTarget, props: object): string {
  return richTextToMarkdown(target.paragraphs(props), { base: baseFormatOf(target.style(props)) })
}

// ほかのアプリへ渡すノードの文字（普通の Markdown。太字・斜体・取り消し線・等幅・リストがなければ null。standardMarkdownOf）
export function standardMarkdownOfNode(target: RichTextTarget, props: object): string | null {
  return standardMarkdownOf(target.paragraphs(props), baseFormatOf(target.style(props)))
}

// ノードの文字が、既定から変えた書式かリストを持つか（持たなければプレーンテキストと同じ）
export function hasNodeRichFormatting(target: RichTextTarget, props: object): boolean {
  return hasRichFormatting(target.paragraphs(props), baseFormatOf(target.style(props)))
}

// Markdown を、ノードの文字にした props。ノードの既定の書式（props の大きさ・色など）と同じ値は持たない。
// issues は読めなかった書式の指定（parseRichMarkdown）
export function withRichTextMarkdown(target: RichTextTarget, props: object, markdown: string): { props: object; issues: string[] } {
  const { paragraphs, issues } = parseRichMarkdown(markdown, { base: baseFormatOf(target.style(props)) })
  return { props: target.withParagraphs(props, paragraphs), issues }
}

export function hasRichText(node: NodeRecord | undefined): boolean {
  return richTextTargetOf(node) !== undefined
}
