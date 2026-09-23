import type { NodeRecord } from '@canvcode/core'
import { defineNodeType, type FileContentSource } from '../defineNodeType.ts'
import { TEXT_FONT_FAMILY } from '../text/layout.ts'
import { layoutCode, type CodeLayout, type CodeMetrics } from './codeLayout.ts'

// コードカード（MAI-7 の `code-card`、MAI-5、MAI-31）。いまは Python の File を表示・編集する。
// - 画像にせず、等幅フォントで fillText で直接描く。構文の色分けは codeLayout.ts で計算する
// - 行番号を出し、長い行はインデントを保って折り返す
// - 高さは Markdown カードと同じく、既定では中身に合わせる（sizing: 'auto'）。'fixed' なら下端をぼかして切る
// 実行（MAI-2 では初版に含めない）は、あとからカードに「実行」と出力の欄を足せるよう、表示の部分を分けてある

export interface CodeCardProps {
  fileId: string
  w: number
  h: number
  sizing: 'auto' | 'fixed'
  role: 'owner' | 'shortcut'
}

export type CodeCardNode = NodeRecord<CodeCardProps>

export const CODE_FONT_FAMILY = "ui-monospace, 'SFMono-Regular', Menlo, 'DejaVu Sans Mono', 'Noto Sans Mono CJK JP', monospace"
export const CODE_CARD_DEFAULT_WIDTH = 560

// カードを描くときの寸法と色。カードの上で編集する CodeMirror（canvas/codeEditor.ts）も同じ値を使い、
// 描いた文字と編集中の文字が同じ位置に来るようにする（MAI-55）。
// 行番号は、左端から paddingX + 桁数 × 文字幅 のところに右揃えで置き、本文はその gutterGap だけ右から始める
export const CODE_CARD_METRICS = {
  fontSize: 13,
  lineHeight: 20,
  headerHeight: 36,
  paddingY: 10,
  paddingX: 14,
  gutterGap: 12,
  background: '#fbfcfd',
  headerBackground: '#eef2f7',
  lineNumberColor: '#8c959f',
} as const

const FONT_SIZE = CODE_CARD_METRICS.fontSize
const LINE_HEIGHT = CODE_CARD_METRICS.lineHeight
const HEADER_H = CODE_CARD_METRICS.headerHeight
const PADDING_Y = CODE_CARD_METRICS.paddingY
const PADDING_X = CODE_CARD_METRICS.paddingX
const GUTTER_GAP = CODE_CARD_METRICS.gutterGap
const MIN_HEIGHT = 80
// 文字が画面上でこれより小さいときは、行を帯で描く（CSS ピクセル）
const BAR_THRESHOLD_PX = 5
const FADE_H = 48

const BACKGROUND = CODE_CARD_METRICS.background
const HEADER_BG = CODE_CARD_METRICS.headerBackground
const BORDER = 'rgba(31, 35, 40, 0.18)'
const LINE_NUMBER = CODE_CARD_METRICS.lineNumberColor

export interface CodeCardOptions {
  files?: FileContentSource
}

// 等幅フォントの文字の幅。ブラウザで一度だけ測る（測れないときは、よくある等幅フォントの比率）
let measured: CodeMetrics | null = null
function metrics(): CodeMetrics {
  if (measured) return measured
  const fallback: CodeMetrics = { fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT, charWidth: FONT_SIZE * 0.6 }
  if (typeof document === 'undefined') return fallback
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return fallback
  ctx.font = `${FONT_SIZE}px ${CODE_FONT_FAMILY}`
  measured = {
    fontSize: FONT_SIZE,
    lineHeight: LINE_HEIGHT,
    charWidth: ctx.measureText('0'.repeat(40)).width / 40,
    wideWidth: ctx.measureText('漢'.repeat(20)).width / 20,
  }
  return measured
}

export function createCodeCardType(options: CodeCardOptions = {}) {
  const textOf = (props: CodeCardProps) => options.files?.get(props.fileId) ?? null

  // 配置は、本文の版と幅ごとに一度だけ計算する
  const layoutCache = new Map<string, { layout: CodeLayout; gutter: number }>()
  const layoutOf = (props: CodeCardProps) => {
    const content = textOf(props)
    if (!content) return null
    const key = `${content.version}|${props.w}`
    let cached = layoutCache.get(key)
    if (!cached) {
      const m = metrics()
      const digits = String(Math.max(1, content.text.split('\n').length)).length
      const gutter = PADDING_X + digits * m.charWidth + GUTTER_GAP
      const layout = layoutCode(content.text, Math.max(40, props.w - gutter - PADDING_X), m)
      cached = { layout, gutter }
      layoutCache.set(key, cached)
      if (layoutCache.size > 500) layoutCache.delete(layoutCache.keys().next().value!)
    }
    return cached
  }

  const contentHeight = (props: CodeCardProps) => {
    const layout = layoutOf(props)
    if (!layout) return null
    return Math.max(MIN_HEIGHT, HEADER_H + PADDING_Y * 2 + layout.layout.lines.length * LINE_HEIGHT)
  }
  const heightOf = (props: CodeCardProps) => (props.sizing === 'auto' ? (contentHeight(props) ?? props.h) : props.h)

  return defineNodeType<CodeCardProps>({
    type: 'code-card',
    version: 1,

    defaultProps: () => ({ fileId: '', w: CODE_CARD_DEFAULT_WIDTH, h: 240, sizing: 'auto', role: 'owner' }),

    getBounds: (node) => ({ x: 0, y: 0, w: node.props.w, h: heightOf(node.props) }),

    hitTest: (node, point, margin) =>
      point.x >= -margin && point.y >= -margin && point.x <= node.props.w + margin && point.y <= heightOf(node.props) + margin,

    render(ctx, node, info) {
      const props = node.props
      const w = props.w
      const h = heightOf(props)
      const doc = info.documents?.get(props.fileId)
      // 枠と名前の帯
      ctx.fillStyle = BACKGROUND
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = HEADER_BG
      ctx.fillRect(0, 0, w, HEADER_H)
      ctx.fillStyle = BORDER
      ctx.fillRect(0, HEADER_H - 1 / info.zoom, w, 1 / info.zoom)
      drawHeader(ctx, doc?.title ?? '', props.role === 'shortcut', w)

      const cached = layoutOf(props)
      const status = doc?.status
      if (!doc || status !== 'ok' || !cached || info.editing) {
        const message = info.editing ? null : statusMessage(status)
        if (message) {
          ctx.fillStyle = LINE_NUMBER
          ctx.font = `14px ${TEXT_FONT_FAMILY}`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(message, w / 2, HEADER_H + (h - HEADER_H) / 2)
          ctx.textAlign = 'left'
        }
      } else {
        drawCode(ctx, cached, w, h, info.zoom)
        // 大きさを固定していて収まらないときは、下端をぼかす
        const full = contentHeight(props) ?? h
        if (props.sizing === 'fixed' && full > h) {
          const gradient = ctx.createLinearGradient(0, h - FADE_H, 0, h)
          gradient.addColorStop(0, 'rgba(251, 252, 253, 0)')
          gradient.addColorStop(0.85, BACKGROUND)
          ctx.fillStyle = gradient
          ctx.fillRect(0, h - FADE_H, w, FADE_H)
        }
      }
      // 枠の線（ショートカットは点線）
      ctx.lineWidth = 1 / info.zoom
      ctx.strokeStyle = props.role === 'shortcut' ? '#b4a6d9' : BORDER
      if (props.role === 'shortcut') ctx.setLineDash([6 / info.zoom, 4 / info.zoom])
      ctx.strokeRect(0, 0, w, h)
      ctx.setLineDash([])
    },

    roughColor: () => HEADER_BG,

    // 高さを中身に合わせているカードの高さを、手で変えたら、大きさを固定する
    resize(node, size) {
      const props = node.props
      if (props.sizing === 'auto' && Math.abs(size.h - heightOf(props)) < 1) return { ...props, w: size.w }
      return { ...props, w: size.w, h: size.h, sizing: 'fixed' }
    },
    minSize: { w: 200, h: MIN_HEIGHT },

    reference: (node) => (node.props.fileId ? { targetId: node.props.fileId, role: node.props.role } : null),
    withRole: (node, role) => ({ ...node.props, role }),
  })
}

function statusMessage(status: string | undefined): string | null {
  if (status === 'missing') return 'File が削除されています（リンク切れ）'
  if (status === 'trashed') return 'ゴミ箱の中'
  if (status === 'nofile') return 'ファイルが見つかりません'
  return null
}

function drawHeader(ctx: CanvasRenderingContext2D, title: string, shortcut: boolean, w: number): void {
  // 種類の印
  ctx.fillStyle = 'rgba(56, 139, 253, 0.16)'
  roundedRect(ctx, 12, 11, 22, 15, 4)
  ctx.fill()
  ctx.fillStyle = '#0550ae'
  ctx.font = `700 10px ${TEXT_FONT_FAMILY}`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.fillText('PY', 23, 18.5)
  ctx.textAlign = 'left'
  let x = 42
  if (shortcut) {
    ctx.fillStyle = '#6d43bd'
    ctx.font = `700 11px ${TEXT_FONT_FAMILY}`
    ctx.fillText('↗', x, 18.5)
    x += 14
  }
  ctx.fillStyle = '#1f2328'
  ctx.font = `700 13px ${TEXT_FONT_FAMILY}`
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, 0, Math.max(0, w - x - 12), HEADER_H)
  ctx.clip()
  ctx.fillText(title, x, 18.5)
  ctx.restore()
}

function drawCode(ctx: CanvasRenderingContext2D, cached: { layout: CodeLayout; gutter: number }, w: number, h: number, zoom: number): void {
  const { layout, gutter } = cached
  const top = HEADER_H + PADDING_Y
  // 画面に見えている行だけを描く（長いファイルでも重くならないように）
  const visible = visibleRows(ctx, top, layout.lines.length)
  const last = Math.min(visible.last, Math.floor((h - top) / LINE_HEIGHT))
  if (visible.first >= last) return
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, HEADER_H, w, h - HEADER_H)
  ctx.clip()
  if (FONT_SIZE * zoom < BAR_THRESHOLD_PX) {
    // ズームアウトしているときは、文字の代わりに灰色の帯を描く
    ctx.fillStyle = 'rgba(120, 120, 120, 0.35)'
    for (let row = visible.first; row < last; row++) {
      const line = layout.lines[row]
      if (line.runs.length === 0) continue
      const start = line.runs[0].x
      const end = line.runs.at(-1)!.x + line.runs.at(-1)!.text.length * metrics().charWidth
      ctx.fillRect(gutter + start, top + row * LINE_HEIGHT + LINE_HEIGHT * 0.3, Math.min(end - start, w - gutter - start), LINE_HEIGHT * 0.4)
    }
    ctx.restore()
    return
  }
  ctx.font = `${FONT_SIZE}px ${CODE_FONT_FAMILY}`
  ctx.textBaseline = 'middle'
  for (let row = visible.first; row < last; row++) {
    const line = layout.lines[row]
    const y = top + row * LINE_HEIGHT + LINE_HEIGHT / 2
    if (line.lineNumber !== null) {
      ctx.fillStyle = LINE_NUMBER
      ctx.textAlign = 'right'
      ctx.fillText(String(line.lineNumber), gutter - GUTTER_GAP, y)
      ctx.textAlign = 'left'
    }
    for (const run of line.runs) {
      ctx.fillStyle = run.color
      ctx.fillText(run.text, gutter + run.x, y)
    }
  }
  ctx.restore()
}

// 今の変換で、画面（Canvas）に入っている行の範囲。変換が回転していても、縦の範囲だけを見ればよい
function visibleRows(ctx: CanvasRenderingContext2D, top: number, count: number): { first: number; last: number } {
  const m = ctx.getTransform()
  const inverse = m.inverse()
  const { width, height } = ctx.canvas
  let minY = Infinity
  let maxY = -Infinity
  for (const [x, y] of [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ]) {
    const p = inverse.transformPoint({ x, y })
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  const first = Math.max(0, Math.floor((minY - top) / LINE_HEIGHT))
  const last = Math.min(count, Math.ceil((maxY - top) / LINE_HEIGHT) + 1)
  return { first, last }
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
