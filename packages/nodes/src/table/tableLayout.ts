import type { Box } from '@canvcode/core'
import { TEXT_FONT_FAMILY } from '../text/fonts.ts'
import { isNumericColumn } from './tableView.ts'

// 表のカード（tableCard.ts）の、セルの配置と描き方。
// - 列の幅は、先頭の SAMPLE_ROWS 行の文字の幅に余白を足し、MIN_COLUMN〜MAX_COLUMN に収める（1 度だけ測る）
// - 折り返さない（既定）：行の高さは固定（ROW_HEIGHT）。セルの中の改行は空白にして 1 行で描き、収まらない文字は … で切る
// - 折り返す（wrap）：列の幅で折り返し（セルの中の改行も守る）、行の高さをいちばん行の多いセルに合わせる。
//   1 つのセルは MAX_WRAP_LINES 行まで（それより長ければ … で切る）。行の位置は rowY に持つ
// - 数だけの列（見出しを除く、空でないセルがすべて数）は右に揃える
// - 並び替え・絞り込みをしている列は、見出しのセルの右に印（▲・▼・絞り込み）を描く
// 座標は表の左上を原点にする（カードの名前の帯の下）。タイルを作るときも、画像を使わずに直接描くときも drawCells で描く

export const TABLE_METRICS = {
  fontSize: 13,
  rowHeight: 28,
  // 折り返したときの 1 行の高さと、セルの上下の余白（1 行なら rowHeight と同じ高さ）
  lineHeight: 18,
  paddingY: 5,
  paddingX: 10,
  minColumn: 48,
  maxColumn: 320,
  background: '#ffffff',
  headerBackground: '#eef1f5',
  stripe: '#f7f8fa',
  grid: '#d8dde4',
  text: '#1f2328',
  mark: '#0969da',
} as const

// 列の幅を測る行の数（多い表でも、測るのはここまで）
const SAMPLE_ROWS = 2000
const MAX_WRAP_LINES = 50
// 見出しのセルの印の幅
const MARK_W = 14

const { fontSize: FONT_SIZE, rowHeight: ROW_H, lineHeight: LINE_H, paddingY: PAD_Y, paddingX: PAD } = TABLE_METRICS

export function tableFont(bold: boolean): string {
  return `${bold ? 700 : 400} ${FONT_SIZE}px ${TEXT_FONT_FAMILY}`
}

// 文字の幅（bold は見出しの行）
export type TableMeasure = (text: string, bold: boolean) => number

// 見出しのセルの印（列ごと）
export interface ColumnMark {
  sort?: 'asc' | 'desc'
  filtered?: boolean
}

export interface TableLayout {
  // 描くセル（元の文字のまま）。どの行も columns 個以下
  cells: string[][]
  // 1 行目が見出しか
  header: boolean
  columns: number
  // 列の左端（columns + 1 個。最後は表の幅）
  colX: number[]
  // 行の上端（行の数 + 1 個。最後は表の高さ）
  rowY: number[]
  // 折り返したセルの行（折り返すときだけ。[行][列]）
  lines: string[][][] | null
  // 列が数だけか（右に揃える）
  numeric: boolean[]
  marks: ColumnMark[]
  width: number
  height: number
}

export interface TableLayoutOptions {
  header: boolean
  measure: TableMeasure
  wrap?: boolean
  marks?: readonly ColumnMark[]
}

export function layoutTable(rows: string[][], options: TableLayoutOptions): TableLayout {
  const cells = rows
  const columns = cells.reduce((max, row) => Math.max(max, row.length), 0)
  const header = options.header && cells.length > 0
  const marks = Array.from({ length: columns }, (_, col) => options.marks?.[col] ?? {})
  const colX = [0]
  const numeric: boolean[] = []
  const sample = cells.slice(0, SAMPLE_ROWS)
  for (let col = 0; col < columns; col++) {
    let width = 0
    for (const [i, row] of sample.entries()) {
      const text = row[col] ?? ''
      if (text === '') continue
      width = Math.max(width, options.measure(oneLine(text), header && i === 0))
    }
    const mark = marks[col].sort || marks[col].filtered ? MARK_W : 0
    numeric.push(isNumericColumn(cells, col, header ? 1 : 0))
    colX.push(colX[col] + Math.min(TABLE_METRICS.maxColumn, Math.max(TABLE_METRICS.minColumn, Math.ceil(width) + PAD * 2 + mark)))
  }
  const rowY = [0]
  let lines: string[][][] | null = null
  if (options.wrap) {
    lines = []
    const breaker = lineBreaker(options.measure)
    for (const [i, row] of cells.entries()) {
      const bold = header && i === 0
      const rowLines = Array.from({ length: columns }, (_, col) => {
        const room = colX[col + 1] - colX[col] - PAD * 2 - (bold && (marks[col].sort || marks[col].filtered) ? MARK_W : 0)
        return breaker(row[col] ?? '', room, bold)
      })
      lines.push(rowLines)
      const count = rowLines.reduce((max, l) => Math.max(max, l.length), 1)
      rowY.push(rowY[i] + Math.max(ROW_H, count * LINE_H + PAD_Y * 2))
    }
  } else {
    for (let i = 0; i < cells.length; i++) rowY.push((i + 1) * ROW_H)
  }
  return { cells, header, columns, colX, rowY, lines, numeric, marks, width: colX[columns], height: rowY[cells.length] }
}

function oneLine(text: string): string {
  return text.includes('\n') ? text.replace(/\s*\n\s*/g, ' ') : text
}

// 折り返し：セルの中の改行で分け、それぞれを room に収まるところで切る（英数字の語の途中なら、その語の前の空白の後で。
// 日本語の文字のところや、空白がなければ、文字の間で）。
// 1 文字ずつの幅を足して測る（文字ごとの幅は覚えておく）
function lineBreaker(measure: TableMeasure): (text: string, room: number, bold: boolean) => string[] {
  const widths = [new Map<string, number>(), new Map<string, number>()]
  const widthOf = (ch: string, bold: boolean) => {
    const cache = widths[bold ? 1 : 0]
    let w = cache.get(ch)
    if (w === undefined) {
      w = measure(ch, bold)
      cache.set(ch, w)
    }
    return w
  }
  return (text, room, bold) => {
    if (text === '') return []
    const out: string[] = []
    for (const paragraph of text.split(/\r?\n/)) {
      let line = ''
      let width = 0
      // 行の中で、最後に空白の後で切れるところ（line の中の位置）
      let breakAt = -1
      for (const ch of paragraph) {
        const w = widthOf(ch, bold)
        if (width + w > room && line !== '') {
          if (breakAt > 0 && ch !== ' ' && !WIDE_CHAR.test(ch)) {
            out.push(line.slice(0, breakAt).trimEnd())
            line = line.slice(breakAt)
          } else {
            out.push(line.trimEnd())
            line = ''
          }
          width = Array.from(line).reduce((sum, c) => sum + widthOf(c, bold), 0)
          breakAt = -1
          if (ch === ' ' && line === '') continue
        }
        line += ch
        width += w
        if (ch === ' ') breakAt = line.length
      }
      out.push(line)
      if (out.length >= MAX_WRAP_LINES) break
    }
    if (out.length > MAX_WRAP_LINES) out.length = MAX_WRAP_LINES
    if (out.length === MAX_WRAP_LINES && out.join('\n').length < text.length) out[MAX_WRAP_LINES - 1] += '…'
    return out
  }
}

// 全角の文字（日本語・中国語・韓国語の文字と、全角の記号）
const WIDE_CHAR = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/

// 文字の種類から見積もった幅（文字を測れないところ：サーバー・テスト）
export function estimateTextWidth(text: string, bold: boolean): number {
  let width = 0
  for (const ch of text) width += WIDE_CHAR.test(ch) ? 1 : 0.6
  return width * FONT_SIZE * (bold ? 1.05 : 1)
}

// rect（表の座標）にかかる行と列の範囲（終わりは含まない）
export function cellsInRect(layout: TableLayout, rect: Box): { row0: number; row1: number; col0: number; col1: number } {
  const rows = layout.cells.length
  const row0 = Math.min(rows, Math.max(0, indexAt(layout.rowY, rect.y)))
  const row1 = Math.min(rows, indexAt(layout.rowY, rect.y + rect.h) + 1)
  const col0 = Math.max(0, indexAt(layout.colX, rect.x))
  const col1 = Math.min(layout.columns, indexAt(layout.colX, rect.x + rect.w) + 1)
  return { row0, row1: Math.max(row0, row1), col0, col1: Math.max(col0, col1) }
}

// 表の座標 x の列（表の外なら null）
export function columnAtX(layout: TableLayout, x: number): number | null {
  if (x < 0 || x >= layout.width || layout.columns === 0) return null
  return indexAt(layout.colX, x)
}

// v を含む区間（edges は昇順の端。edges[i] ≦ v < edges[i + 1] の i）。左の外なら 0、右の外なら最後の区間
function indexAt(edges: number[], v: number): number {
  let lo = 0
  let hi = Math.max(0, edges.length - 2)
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (edges[mid] <= v) lo = mid
    else hi = mid - 1
  }
  return lo
}

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

// rect（表の座標）にかかるセルを描く：地・見出しの地・縞・罫線・文字・見出しの印。pixel は描き先の 1 画素の幅（表の座標。罫線の太さ）
export function drawCells(ctx: Context2D, layout: TableLayout, rect: Box, pixel: number): void {
  const { row0, row1, col0, col1 } = cellsInRect(layout, rect)
  const { colX, rowY } = layout
  const x0 = colX[col0]
  const x1 = colX[col1]
  ctx.fillStyle = TABLE_METRICS.background
  ctx.fillRect(x0, rowY[row0], x1 - x0, rowY[row1] - rowY[row0])
  // 縞は、データの 2 行目から 1 行おき（見出しの次の行は白）
  const first = layout.header ? 1 : 0
  for (let row = row0; row < row1; row++) {
    const head = layout.header && row === 0
    if (!head && (row - first) % 2 === 0) continue
    ctx.fillStyle = head ? TABLE_METRICS.headerBackground : TABLE_METRICS.stripe
    ctx.fillRect(x0, rowY[row], x1 - x0, rowY[row + 1] - rowY[row])
  }
  // 罫線（セルの右と下）
  ctx.fillStyle = TABLE_METRICS.grid
  for (let row = row0; row < row1; row++) ctx.fillRect(x0, rowY[row + 1] - pixel, x1 - x0, pixel)
  for (let col = col0; col < col1; col++) ctx.fillRect(colX[col + 1] - pixel, rowY[row0], pixel, rowY[row1] - rowY[row0])
  ctx.fillStyle = TABLE_METRICS.text
  ctx.textBaseline = 'middle'
  for (let row = row0; row < row1; row++) {
    const head = layout.header && row === 0
    ctx.font = tableFont(head)
    for (let col = col0; col < col1; col++) {
      const marked = head && (layout.marks[col].sort || layout.marks[col].filtered)
      const room = colX[col + 1] - colX[col] - PAD * 2 - (marked ? MARK_W : 0)
      const right = layout.numeric[col] && !head
      ctx.textAlign = right ? 'right' : 'left'
      const x = right ? colX[col + 1] - PAD : colX[col] + PAD
      if (layout.lines) {
        // 折り返したセルは上に揃える
        const cellLines = layout.lines[row][col]
        for (const [i, line] of cellLines.entries()) ctx.fillText(line, x, rowY[row] + PAD_Y + i * LINE_H + LINE_H / 2)
      } else {
        const text = layout.cells[row][col]
        if (text) ctx.fillText(fitText(ctx, oneLine(text), room), x, rowY[row] + ROW_H / 2)
      }
      if (marked) drawMark(ctx, layout.marks[col], colX[col + 1] - PAD - MARK_W / 2 + 4, rowY[row] + ROW_H / 2)
    }
  }
  ctx.textAlign = 'left'
}

// 見出しのセルの印：並び替えは ▲（昇順）・▼（降順）、絞り込みは漏斗（並び替えと両方なら ▲▼ の下に点）
function drawMark(ctx: Context2D, mark: ColumnMark, cx: number, cy: number): void {
  ctx.save()
  ctx.fillStyle = TABLE_METRICS.mark
  ctx.beginPath()
  if (mark.sort === 'asc') {
    ctx.moveTo(cx - 4, cy + 2)
    ctx.lineTo(cx + 4, cy + 2)
    ctx.lineTo(cx, cy - 4)
  } else if (mark.sort === 'desc') {
    ctx.moveTo(cx - 4, cy - 3)
    ctx.lineTo(cx + 4, cy - 3)
    ctx.lineTo(cx, cy + 3)
  } else {
    // 漏斗
    ctx.moveTo(cx - 5, cy - 4)
    ctx.lineTo(cx + 5, cy - 4)
    ctx.lineTo(cx + 1, cy + 1)
    ctx.lineTo(cx + 1, cy + 5)
    ctx.lineTo(cx - 1, cy + 4)
    ctx.lineTo(cx - 1, cy + 1)
  }
  ctx.closePath()
  ctx.fill()
  if (mark.sort && mark.filtered) ctx.fillRect(cx - 1, cy + 5, 2, 2)
  ctx.restore()
}

// 画面上で文字が小さいときの、セルの代わりの帯（文字を描かない）
export function drawCellBars(ctx: Context2D, layout: TableLayout, rect: Box): void {
  const { row0, row1, col0, col1 } = cellsInRect(layout, rect)
  const { colX, rowY } = layout
  ctx.fillStyle = TABLE_METRICS.background
  ctx.fillRect(colX[col0], rowY[row0], colX[col1] - colX[col0], rowY[row1] - rowY[row0])
  if (layout.header && row0 === 0 && row1 > 0) {
    ctx.fillStyle = TABLE_METRICS.headerBackground
    ctx.fillRect(colX[col0], 0, colX[col1] - colX[col0], rowY[1])
  }
  ctx.fillStyle = 'rgba(120, 120, 120, 0.3)'
  for (let row = row0; row < row1; row++) {
    for (let col = col0; col < col1; col++) {
      const text = layout.cells[row][col]
      if (!text) continue
      const room = colX[col + 1] - colX[col] - PAD * 2
      const count = layout.lines ? layout.lines[row][col].length : 1
      for (let i = 0; i < count; i++) {
        const lineText = layout.lines ? layout.lines[row][col][i] : text
        const w = Math.min(room, estimateTextWidth(lineText, false))
        const x = layout.numeric[col] ? colX[col + 1] - PAD - w : colX[col] + PAD
        const top = layout.lines ? rowY[row] + PAD_Y + i * LINE_H : rowY[row] + (ROW_H - LINE_H) / 2
        ctx.fillRect(x, top + LINE_H * 0.3, w, LINE_H * 0.4)
      }
    }
  }
}

// room に収まるよう、末尾を … にして切る
function fitText(ctx: Context2D, text: string, room: number): string {
  if (ctx.measureText(text).width <= room) return text
  // 列の幅は MAX_COLUMN までなので、長いセルも先頭の 200 文字で探せば足りる
  const chars = Array.from(text).slice(0, 200)
  let lo = 0
  let hi = chars.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ctx.measureText(chars.slice(0, mid).join('') + '…').width <= room) lo = mid
    else hi = mid - 1
  }
  return lo === 0 ? '' : chars.slice(0, lo).join('') + '…'
}
