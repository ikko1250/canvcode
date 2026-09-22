import type { NodeRecord } from '@canvcode/core'
import { defineNodeType, pickImageLevel, type RenderInfo } from './defineNodeType.ts'
import { TEXT_BAR_THRESHOLD_PX, TEXT_FONT_FAMILY, drawTextBars, drawTextLayout, layoutText, type TextLayout, type TextStyle } from './text/layout.ts'

// 引用ノート（MAI-33）。PDF や Markdown の範囲を引用したノート。
// 上から、出典の帯（資料の名前と位置）、引用した文字（または切り抜いた図）、自分のメモ。
// - 出典の位置は SourceAnchor（anchorId）が持つ。逆リンク（出典から、引用しているノートへ）もそれでたどる
// - 引用した文字と図はノートにも写しておく（変えない）。高さを props だけから決められるように
// - メモは付箋と同じプレーンテキスト。ダブルクリックか Enter で編集する
// - 高さは中身に合わせて決まる（幅だけを変えられる）
export interface QuoteCardProps {
  anchorId: string
  // 出典の File
  fileId: string
  quote: string
  // 切り抜いた図（PDF の範囲。文字がほとんどない範囲を引用したとき）。ページの画像を切り抜いて描く
  figure: QuoteFigure | null
  memo: string
  w: number
}

export interface QuoteFigure {
  assetId: string
  pageIndex: number
  // ページの中の範囲（0〜1）
  rect: { x: number; y: number; w: number; h: number }
  // ページの幅（ワールド座標。pdf-page の w）。切り抜きの解像度を決めるのに使う
  pageWidth: number
  // 範囲の縦横比（高さ / 幅。ワールド座標で）
  aspect: number
}

export type QuoteCardNode = NodeRecord<QuoteCardProps>

export const QUOTE_CARD_DEFAULT_WIDTH = 320

// 寸法（ワールド座標）
const PADDING = 14
const HEADER_H = 30
const BAR_W = 3
const QUOTE_INDENT = 12
const GAP = 10
const MEMO_MIN_LINES = 1
// 長すぎる引用は、ここまでで切る（全文は SourceAnchor にある）
const MAX_QUOTE_LINES = 12
const MAX_FIGURE_H = 480
const HEADER_FONT = 12

const QUOTE_STYLE: TextStyle = { fontSize: 14, lineHeight: 1.55, fontWeight: 400, color: '#3d3a40', align: 'left' }
const MEMO_STYLE: TextStyle = { fontSize: 16, lineHeight: 1.45, fontWeight: 400, color: '#1f2328', align: 'left' }
const ACCENT = '#d4a72c'
const BORDER = 'rgba(31, 35, 40, 0.16)'

interface QuoteLayout {
  quote: TextLayout | null
  quoteBox: { x: number; y: number; w: number; h: number }
  figureBox: { x: number; y: number; w: number; h: number } | null
  memo: TextLayout
  memoBox: { x: number; y: number; w: number; h: number }
  h: number
}

const layoutCache = new WeakMap<QuoteCardProps, QuoteLayout>()

function quoteLayout(props: QuoteCardProps): QuoteLayout {
  let layout = layoutCache.get(props)
  if (layout) return layout
  const innerW = Math.max(1, props.w - PADDING * 2)
  let y = HEADER_H
  let quote: TextLayout | null = null
  let quoteBox = { x: PADDING + QUOTE_INDENT, y, w: Math.max(1, innerW - QUOTE_INDENT), h: 0 }
  let figureBox = null
  if (props.figure) {
    const h = Math.min(innerW * props.figure.aspect, MAX_FIGURE_H)
    // 高さを抑えたときは、縦横比を保って幅を狭める
    const w = h / props.figure.aspect
    figureBox = { x: PADDING + (innerW - w) / 2, y, w, h }
    y += h + GAP
  } else {
    const full = layoutText(props.quote, QUOTE_STYLE, quoteBox.w)
    const lines = full.lines.length > MAX_QUOTE_LINES ? full.lines.slice(0, MAX_QUOTE_LINES) : full.lines
    if (lines !== full.lines) lines[lines.length - 1] = { ...lines[lines.length - 1], text: lines[lines.length - 1].text + '…' }
    quote = { ...full, lines, height: lines.length * full.lineHeightPx }
    quoteBox = { ...quoteBox, h: quote.height }
    y += quote.height + GAP
  }
  const memoBox = { x: PADDING, y: y + 4, w: innerW, h: 0 }
  const memo = layoutText(props.memo, MEMO_STYLE, memoBox.w)
  memoBox.h = Math.max(memo.height, MEMO_STYLE.fontSize * MEMO_STYLE.lineHeight * MEMO_MIN_LINES)
  layout = { quote, quoteBox, figureBox, memo, memoBox, h: memoBox.y + memoBox.h + PADDING }
  layoutCache.set(props, layout)
  return layout
}

// 出典の帯の高さ（「出典へ」を Ctrl（⌘）+クリックで開ける範囲）
export const QUOTE_CARD_HEADER_H = HEADER_H

// リンクとして返す、出典への移動（view がこれを見て、出典へ移る）
export const SOURCE_LINK_PREFIX = 'canvcode-source:'

export const quoteCardType = defineNodeType<QuoteCardProps>({
  type: 'quote-card',
  version: 1,

  defaultProps: () => ({ anchorId: '', fileId: '', quote: '', figure: null, memo: '', w: QUOTE_CARD_DEFAULT_WIDTH }),

  getBounds: (node) => ({ x: 0, y: 0, w: node.props.w, h: quoteLayout(node.props).h }),

  hitTest(node, point, margin) {
    const h = quoteLayout(node.props).h
    return point.x >= -margin && point.y >= -margin && point.x <= node.props.w + margin && point.y <= h + margin
  },

  render(ctx, node, info) {
    const props = node.props
    const layout = quoteLayout(props)
    const { w } = props
    const h = layout.h
    ctx.fillStyle = 'rgba(40, 40, 40, 0.08)'
    ctx.fillRect(2, 3, w, h)
    ctx.fillStyle = '#fffdf7'
    ctx.fillRect(0, 0, w, h)
    ctx.lineWidth = 1 / info.zoom
    ctx.strokeStyle = BORDER
    ctx.strokeRect(0, 0, w, h)
    const bars = QUOTE_STYLE.fontSize * info.zoom < TEXT_BAR_THRESHOLD_PX
    drawHeader(ctx, props, info, bars)
    // 引用した文字（左に線）か、切り抜いた図
    if (layout.figureBox && props.figure) {
      drawFigure(ctx, props.figure, layout.figureBox, info)
    } else if (layout.quote) {
      ctx.fillStyle = ACCENT
      ctx.fillRect(PADDING, layout.quoteBox.y, BAR_W, layout.quoteBox.h)
      if (bars) drawTextBars(ctx, layout.quote, QUOTE_STYLE, layout.quoteBox, 'top')
      else drawTextLayout(ctx, layout.quote, QUOTE_STYLE, layout.quoteBox, 'top')
    }
    // 区切り線とメモ
    ctx.fillStyle = 'rgba(31, 35, 40, 0.1)'
    ctx.fillRect(PADDING, layout.memoBox.y - 6, w - PADDING * 2, 1 / info.zoom)
    if (info.editing) return
    if (props.memo) {
      if (MEMO_STYLE.fontSize * info.zoom < TEXT_BAR_THRESHOLD_PX) drawTextBars(ctx, layout.memo, MEMO_STYLE, layout.memoBox, 'top')
      else drawTextLayout(ctx, layout.memo, MEMO_STYLE, layout.memoBox, 'top')
    } else if (!bars) {
      const placeholder = layoutText('メモ（ダブルクリックで書く）', { ...MEMO_STYLE, color: '#a0a7b0' }, layout.memoBox.w)
      drawTextLayout(ctx, placeholder, { ...MEMO_STYLE, color: '#a0a7b0' }, layout.memoBox, 'top')
    }
  },

  roughColor: () => '#fffdf7',

  // 幅だけを変える（高さは中身に合わせる）
  resize: (node, size) => ({ ...node.props, w: size.w }),
  minSize: { w: 160, h: 60 },

  citation: (node) => node.props.anchorId || null,

  // 出典の帯を Ctrl（⌘）+クリックすると、出典へ移る
  linkAt: (node, point) => (point.y >= 0 && point.y <= HEADER_H ? `${SOURCE_LINK_PREFIX}${node.props.anchorId}` : null),

  editText: (node) => {
    const layout = quoteLayout(node.props)
    return {
      text: node.props.memo,
      style: MEMO_STYLE,
      box: layout.memoBox,
      autoWidth: false,
      verticalAlign: 'top',
      update: (memo) => ({ ...node.props, memo }),
      deleteIfEmpty: false,
    }
  },
})

function drawHeader(ctx: CanvasRenderingContext2D, props: QuoteCardProps, info: RenderInfo, bars: boolean): void {
  const doc = info.documents?.get(props.fileId)
  const location = info.citations?.location(props.anchorId) ?? { label: '', lost: false }
  const title = !doc || doc.status === 'missing' ? '（削除された資料）' : doc.title
  if (bars) {
    ctx.fillStyle = 'rgba(120, 120, 120, 0.35)'
    ctx.fillRect(PADDING, HEADER_H / 2 - 4, Math.min(props.w - PADDING * 2, 140), 8)
    return
  }
  ctx.font = `600 ${HEADER_FONT}px ${TEXT_FONT_FAMILY}`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  const mark = doc?.kind === 'pdf' ? 'PDF' : 'MD'
  ctx.fillStyle = doc?.kind === 'pdf' ? '#b42318' : '#8a6a1f'
  ctx.fillText(mark, PADDING, HEADER_H / 2 + 1)
  const markW = ctx.measureText(mark).width + 8
  const suffix = location.label ? `  ${location.label}` : ''
  ctx.font = `400 ${HEADER_FONT}px ${TEXT_FONT_FAMILY}`
  const suffixW = ctx.measureText(suffix).width
  ctx.fillStyle = '#57606a'
  const maxTitle = props.w - PADDING * 2 - markW - suffixW
  ctx.fillText(fit(ctx, title, maxTitle), PADDING + markW, HEADER_H / 2 + 1)
  ctx.fillStyle = location.lost ? '#cf222e' : '#8c959f'
  ctx.textAlign = 'right'
  ctx.fillText(suffix, props.w - PADDING, HEADER_H / 2 + 1)
  ctx.textAlign = 'left'
}

function drawFigure(ctx: CanvasRenderingContext2D, figure: QuoteFigure, box: { x: number; y: number; w: number; h: number }, info: RenderInfo): void {
  const assets = info.assets
  let raster = null
  if (assets?.renderPdfPage && info.images) {
    // ページ全体をこの解像度で描き、範囲を切り抜く。ページのノードと同じ画像を使う（キーが同じ）
    // ノートの上での、ページ 1 単位の大きさ
    const scale = box.w / (figure.rect.w * figure.pageWidth)
    const perUnit = scale * info.zoom * info.devicePixelRatio
    const level = pickImageLevel(perUnit)
    raster = info.images.get(`${figure.assetId}#${figure.pageIndex}`, 'v1', level, () =>
      assets.renderPdfPage!(figure.assetId, figure.pageIndex, level),
    )
  }
  if (!raster) {
    ctx.fillStyle = '#eef0f3'
    ctx.fillRect(box.x, box.y, box.w, box.h)
    return
  }
  const { rect } = figure
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(raster.image, rect.x * raster.width, rect.y * raster.height, rect.w * raster.width, rect.h * raster.height, box.x, box.y, box.w, box.h)
  ctx.lineWidth = 1 / info.zoom
  ctx.strokeStyle = BORDER
  ctx.strokeRect(box.x, box.y, box.w, box.h)
}

function fit(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (ctx.measureText(text).width <= maxWidth) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo) + '…'
}
