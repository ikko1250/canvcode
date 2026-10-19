import type { Box } from '@canvcode/core'
import { parseChartNumber } from '../chart.ts'
import { TEXT_FONT_FAMILY } from '../text/fonts.ts'

// 表のカード（tableCard.ts）の、セルの配置と描き方。
// - 列の幅は、先頭の SAMPLE_ROWS 行の文字の幅に余白を足し、MIN_COLUMN〜MAX_COLUMN に収める（1 度だけ測る）。収まらない文字は … で切る
// - 行の高さは固定（ROW_HEIGHT）。セルの中の改行は空白にして、1 行で描く
// - 数だけの列（見出しを除く、空でないセルがすべて数）は右に揃える
// 座標は表の左上を原点にする（カードの名前の帯の下）。タイルを作るときも、画像を使わずに直接描くときも drawCells で描く

export const TABLE_METRICS = {
  fontSize: 13,
  rowHeight: 28,
  paddingX: 10,
  minColumn: 48,
  maxColumn: 320,
  background: '#ffffff',
  headerBackground: '#eef1f5',
  stripe: '#f7f8fa',
  grid: '#d8dde4',
  text: '#1f2328',
} as const

// 列の幅を測る行の数（多い表でも、測るのはここまで）
const SAMPLE_ROWS = 2000

const { fontSize: FONT_SIZE, rowHeight: ROW_H, paddingX: PAD } = TABLE_METRICS

export function tableFont(bold: boolean): string {
  return `${bold ? 700 : 400} ${FONT_SIZE}px ${TEXT_FONT_FAMILY}`
}

// 文字の幅（bold は見出しの行）
export type TableMeasure = (text: string, bold: boolean) => number

export interface TableLayout {
  // 描く文字（改行を空白にしたもの）。どの行も columns 個のセル
  cells: string[][]
  // 1 行目が見出しか
  header: boolean
  columns: number
  // 列の左端（columns + 1 個。最後は表の幅）
  colX: number[]
  // 列が数だけか（右に揃える）
  numeric: boolean[]
  width: number
  height: number
}

export function layoutTable(rows: string[][], options: { header: boolean; measure: TableMeasure }): TableLayout {
  const cells = rows.map((row) => row.map((cell) => cell.replace(/\s*\n\s*/g, ' ')))
  const columns = cells.reduce((max, row) => Math.max(max, row.length), 0)
  const header = options.header && cells.length > 0
  const colX = [0]
  const numeric: boolean[] = []
  const sample = cells.slice(0, SAMPLE_ROWS)
  for (let col = 0; col < columns; col++) {
    let width = 0
    let numbers = 0
    let others = 0
    for (const [i, row] of sample.entries()) {
      const text = row[col] ?? ''
      if (text === '') continue
      const bold = header && i === 0
      width = Math.max(width, options.measure(text, bold))
      if (bold) continue
      if (parseChartNumber(text) === null) others++
      else numbers++
    }
    numeric.push(numbers > 0 && others === 0)
    colX.push(colX[col] + Math.min(TABLE_METRICS.maxColumn, Math.max(TABLE_METRICS.minColumn, Math.ceil(width) + PAD * 2)))
  }
  return { cells, header, columns, colX, numeric, width: colX[columns], height: cells.length * ROW_H }
}

// 文字の種類から見積もった幅（文字を測れないところ：サーバー・テスト）
export function estimateTextWidth(text: string, bold: boolean): number {
  let width = 0
  for (const ch of text) width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 1 : 0.6
  return width * FONT_SIZE * (bold ? 1.05 : 1)
}

// rect（表の座標）にかかる行と列の範囲（終わりは含まない）
export function cellsInRect(layout: TableLayout, rect: Box): { row0: number; row1: number; col0: number; col1: number } {
  const row0 = Math.max(0, Math.floor(rect.y / ROW_H))
  const row1 = Math.min(layout.cells.length, Math.ceil((rect.y + rect.h) / ROW_H))
  const col0 = Math.max(0, columnAt(layout.colX, rect.x))
  const col1 = Math.min(layout.columns, columnAt(layout.colX, rect.x + rect.w) + 1)
  return { row0, row1: Math.max(row0, row1), col0, col1: Math.max(col0, col1) }
}

// x を含む列（colX の二分探索）。表の左なら 0、右なら最後の列
function columnAt(colX: number[], x: number): number {
  let lo = 0
  let hi = colX.length - 2
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (colX[mid] <= x) lo = mid
    else hi = mid - 1
  }
  return lo
}

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

// rect（表の座標）にかかるセルを描く：地・見出しの地・縞・罫線・文字。pixel は描き先の 1 画素の幅（表の座標。罫線の太さ）
export function drawCells(ctx: Context2D, layout: TableLayout, rect: Box, pixel: number): void {
  const { row0, row1, col0, col1 } = cellsInRect(layout, rect)
  const { colX } = layout
  const x0 = colX[col0]
  const x1 = colX[col1]
  ctx.fillStyle = TABLE_METRICS.background
  ctx.fillRect(x0, row0 * ROW_H, x1 - x0, (row1 - row0) * ROW_H)
  // 縞は、データの 2 行目から 1 行おき（見出しの次の行は白）
  const first = layout.header ? 1 : 0
  for (let row = row0; row < row1; row++) {
    const head = layout.header && row === 0
    if (!head && (row - first) % 2 === 0) continue
    ctx.fillStyle = head ? TABLE_METRICS.headerBackground : TABLE_METRICS.stripe
    ctx.fillRect(x0, row * ROW_H, x1 - x0, ROW_H)
  }
  // 罫線（セルの右と下）
  ctx.fillStyle = TABLE_METRICS.grid
  for (let row = row0; row < row1; row++) ctx.fillRect(x0, (row + 1) * ROW_H - pixel, x1 - x0, pixel)
  for (let col = col0; col < col1; col++) ctx.fillRect(colX[col + 1] - pixel, row0 * ROW_H, pixel, (row1 - row0) * ROW_H)
  ctx.fillStyle = TABLE_METRICS.text
  ctx.textBaseline = 'middle'
  for (let row = row0; row < row1; row++) {
    const head = layout.header && row === 0
    ctx.font = tableFont(head)
    const y = row * ROW_H + ROW_H / 2
    for (let col = col0; col < col1; col++) {
      const text = layout.cells[row][col]
      if (!text) continue
      const room = colX[col + 1] - colX[col] - PAD * 2
      const shown = fitText(ctx, text, room)
      const right = layout.numeric[col] && !head
      ctx.textAlign = right ? 'right' : 'left'
      ctx.fillText(shown, right ? colX[col + 1] - PAD : colX[col] + PAD, y)
    }
  }
  ctx.textAlign = 'left'
}

// 画面上で文字が小さいときの、セルの代わりの帯（文字を描かない）
export function drawCellBars(ctx: Context2D, layout: TableLayout, rect: Box): void {
  const { row0, row1, col0, col1 } = cellsInRect(layout, rect)
  const { colX } = layout
  ctx.fillStyle = TABLE_METRICS.background
  ctx.fillRect(colX[col0], row0 * ROW_H, colX[col1] - colX[col0], (row1 - row0) * ROW_H)
  if (layout.header && row0 === 0 && row1 > 0) {
    ctx.fillStyle = TABLE_METRICS.headerBackground
    ctx.fillRect(colX[col0], 0, colX[col1] - colX[col0], ROW_H)
  }
  ctx.fillStyle = 'rgba(120, 120, 120, 0.3)'
  for (let row = row0; row < row1; row++) {
    for (let col = col0; col < col1; col++) {
      const text = layout.cells[row][col]
      if (!text) continue
      const room = colX[col + 1] - colX[col] - PAD * 2
      const w = Math.min(room, estimateTextWidth(text, false))
      const x = layout.numeric[col] ? colX[col + 1] - PAD - w : colX[col] + PAD
      ctx.fillRect(x, row * ROW_H + ROW_H * 0.35, w, ROW_H * 0.3)
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
