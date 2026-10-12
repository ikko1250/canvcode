import type { NodeRecord } from '@canvcode/core'
import { adjustOf, geoFitHeight, slotsOf, type GeoProps, type SlideLayoutSlots, type SlideRatio } from '@canvcode/nodes'
import {
  CANVAS_SLIDE_LAYOUTS,
  canvasSlideBodyFill,
  canvasSlideLayout,
  canvasSlideRowHeights,
  getMaxRowCount,
  placeCoverHeading,
  type CanvasBox,
  type CanvasSlideLayout,
} from '@canvcode/slides'
import { adjustLayoutOptions } from './slideLayoutAdjust.ts'

// slide-layout（スライド v2）の子を、レイアウトの幾何（canvasSlideLayout）どおりに並べ直す計算。DOM に依存しない純粋な関数だけを置く。
// 書き込むのは呼び出し側（Editor）で、変更を起こしたトランザクションの終わりに同じ 1 歩として書く。
// - title / subtitle は text（幅 w を決める。高さは文字から決まる）、それ以外の役割は geo の矩形（w / h を決める）として扱う。
//   ほかの型でも、props に数の w / h があれば w / h を、text なら w を決める
// - 位置は slide-layout のローカル座標（slide-layout はスライドの左上 0,0 にある）
// - 本文の地の色は行の順で決まる（v1 の canvasSlideBodyFill）ので、行の順に合わせて直す（slideBodyFillFor）
// - 行の高さは canvasSlideRowHeights（v1 の行容量の規則）で配分する。自動の行の必要高さは、見出しと本文のセルのうち大きい方の
//   文字の高さ＋上下の余白（geoFitHeight。あふれの判定と同じ配置で、並べたあとの幅で測る）。手で決めた行（slots の行の h）はその高さを優先する
// - 手で直した配置（props.adjust。表パネルと右図枠のずらす量、table-image の表の幅、表パネルの高さ）は幾何と行の高さの配分に渡す（slideLayoutAdjust.ts）

export interface SlideLayoutArrangeInput {
  // slide-layout のレコード（props は SlideLayoutProps。壊れた値も読む）
  layout: NodeRecord
  // slide-layout の子（id → レコード）。ここにない id は、slots に入っていても無視する
  children: ReadonlyMap<string, NodeRecord>
  // スライドの縦横比
  ratio: SlideRatio
  // text の子を幅 w で折り返したときの高さ（表紙の上下中央に使う）
  textHeight: (node: NodeRecord, w: number) => number
}

// 子 1 つの新しい位置と、変える props（変える項目だけ。変えなければ省く）
export interface SlideLayoutChildUpdate {
  id: string
  x: number
  y: number
  props?: Record<string, unknown>
}

export interface SlideLayoutArrangement {
  // 位置か大きさが変わる子だけ（変わらない子は入れない）
  updates: SlideLayoutChildUpdate[]
  // 並べた行の数（上限まで）
  rowCount: number
  // 上限を超えて並べなかった行の数（位置を変えない。警告は後のタスク）
  overflowRows: number
  // 並べた行の高さ（行の順。行を持たないレイアウトは空）
  rowHeights: number[]
}

// 位置と大きさを比べるときの許し（小数の誤差で書き込まない）
const EPSILON = 1e-6

function isLayoutKind(value: unknown): value is CanvasSlideLayout {
  return CANVAS_SLIDE_LAYOUTS.includes(value as CanvasSlideLayout)
}

// slots の行のうち、本文の子が今もある行（並べる対象）
export function presentRows(slots: SlideLayoutSlots, isChild: (id: string) => boolean): SlideLayoutSlots['rows'] {
  return slots.rows.filter((row) => row.body !== '' && isChild(row.body))
}

// 本文の子が無くなった行（削除した・外へ出した）を slots から除く。除いた行の見出し（label）のうち、まだ子として残っているものも返す
// （呼び出し側が同じトランザクションで消す）。除く行がなければ null
export function pruneSlideLayoutRows(
  slots: SlideLayoutSlots,
  isChild: (id: string) => boolean,
): { slots: SlideLayoutSlots; removedLabels: string[] } | null {
  const rows = presentRows(slots, isChild)
  if (rows.length === slots.rows.length) return null
  const removedLabels = slots.rows.flatMap((row) => (!rows.includes(row) && row.label && isChild(row.label) ? [row.label] : []))
  return { slots: { ...slots, rows }, removedLabels }
}

// slide-layout の子を並べ直したときの、変わる子の位置と props
export function arrangeSlideLayout(input: SlideLayoutArrangeInput): SlideLayoutArrangement {
  const { layout, children, ratio, textHeight } = input
  const props = layout.props as Record<string, unknown>
  const updates: SlideLayoutChildUpdate[] = []
  const kind = props.layout
  if (!isLayoutKind(kind)) return { updates, rowCount: 0, overflowRows: 0, rowHeights: [] }
  const slots = slotsOf(props.slots)
  const child = (id: string | undefined) => (id ? children.get(id) : undefined)
  const place = (id: string | undefined, box: CanvasBox | null, rowIndex?: number) => {
    const node = child(id)
    if (!node || !box) return
    const fill = rowIndex === undefined ? null : slideBodyFillFor((node.props as Record<string, unknown>).fill, rowIndex)
    pushUpdate(updates, node, box, fill ? { fill } : undefined)
  }

  if (kind === 'title') {
    const credits = child(slots.credits)
    const cover = canvasSlideLayout('title', 1, ratio, { hasCredits: credits !== undefined })
    const { w } = cover.headingArea
    const title = child(slots.title)
    const subtitle = child(slots.subtitle)
    // 文字の高さは、並べたあとの幅で折り返して測る
    const height = (node: NodeRecord) => textHeight(node, w)
    if (title) {
      const heading = placeCoverHeading(cover, height(title), subtitle ? height(subtitle) : undefined)
      pushUpdate(updates, title, heading.title)
      if (subtitle && heading.subtitle) pushUpdate(updates, subtitle, heading.subtitle)
    } else if (subtitle) {
      // タイトルが無ければ、副題だけを上下中央に置く
      pushUpdate(updates, subtitle, placeCoverHeading(cover, height(subtitle)).title)
    }
    place(slots.credits, cover.credits)
    return { updates, rowCount: 0, overflowRows: 0, rowHeights: [] }
  }

  // 行が 0 のとき（本文をすべて消した）は、行の箱は作らず、タイトルとパネルを 1 行分の幾何で置く。
  // 上限を超えた行は例外にせず、上限までを並べて、超えた分は位置を変えない
  const rows = presentRows(slots, (id) => children.has(id))
  const max = getMaxRowCount(kind)
  const rowCount = Math.min(rows.length, max)
  const adjusted = adjustLayoutOptions(adjustOf(props.adjust))
  const sized = canvasSlideLayout(kind, Math.max(1, rowCount), ratio, adjusted)
  const placed = rows.slice(0, rowCount)
  // 行の幅は compact でも全高でも同じなので、一律の幾何の箱の幅で測る
  const required = placed.map((row, i) =>
    Math.max(cellFitHeight(child(row.label), sized.rows[i].label?.w), cellFitHeight(child(row.body), sized.rows[i].body.w)),
  )
  const heights = rowCount > 0 ? canvasSlideRowHeights(kind, required, placed.map((row) => row.h), { tableHeight: adjusted.tableHeight }) : null
  const boxes = heights ? canvasSlideLayout(kind, rowCount, ratio, { ...adjusted, forceFull: heights.forceFull, rowHeights: heights.rowHeights }) : sized
  place(slots.title, boxes.title)
  place(slots.panel, boxes.panel)
  place(slots.figure, boxes.figure)
  place(slots.figure2, boxes.figure2)
  for (let i = 0; i < rowCount; i += 1) {
    place(rows[i].label, boxes.rows[i].label)
    place(rows[i].body, boxes.rows[i].body, i)
  }
  return { updates, rowCount, overflowRows: rows.length - rowCount, rowHeights: heights?.rowHeights ?? [] }
}

// 行のセルの文字が収まる高さ。geo だけを測る（ほかの型・無いセルは 0。行の高さを決めない）
function cellFitHeight(node: NodeRecord | undefined, w: number | undefined): number {
  if (node?.type !== 'geo' || w === undefined) return 0
  return geoFitHeight(node.props as GeoProps, w)
}

// 本文の地の色（fill）を rowIndex 行目（0 始まり）の色にしたもの。今の色が v1 の 2 色（canvasSlideBodyFill）のどちらかの単色で、
// 行の順に合わないときだけ返す（不透明度はそのまま）。利用者が別の色にしたもの・塗りなし・すでに合っているものは null
export function slideBodyFillFor(fill: unknown, rowIndex: number): Record<string, unknown> | null {
  if (!fill || typeof fill !== 'object') return null
  const paint = fill as Record<string, unknown>
  if (paint.type !== 'solid' || typeof paint.color !== 'string') return null
  const color = paint.color.toLowerCase()
  const want = canvasSlideBodyFill(rowIndex)
  const v1 = [canvasSlideBodyFill(0), canvasSlideBodyFill(2)].map((c) => c.toLowerCase())
  if (!v1.includes(color) || color === want.toLowerCase()) return null
  return { ...paint, color: want }
}

// 箱に合わせた位置と props が今と違えば、updates に足す。text は幅だけ、w / h を持つ型は幅と高さを決める。
// extra は箱と別に変える props（本文の地の色）
function pushUpdate(updates: SlideLayoutChildUpdate[], node: NodeRecord, box: CanvasBox, extra?: Record<string, unknown>): void {
  const current = node.props as Record<string, unknown>
  const next: Record<string, unknown> = { ...extra }
  if (node.type === 'text') {
    if (!near(current.w, box.w)) next.w = box.w
    if (current.autoWidth === true) next.autoWidth = false
  } else if (typeof current.w === 'number' && typeof current.h === 'number') {
    if (!near(current.w, box.w)) next.w = box.w
    if (!near(current.h, box.h)) next.h = box.h
  }
  const changed = Object.keys(next).length > 0
  if (!changed && near(node.x, box.x) && near(node.y, box.y)) return
  updates.push({ id: node.id, x: box.x, y: box.y, ...(changed ? { props: next } : {}) })
}

function near(a: unknown, b: number): boolean {
  return typeof a === 'number' && Math.abs(a - b) < EPSILON
}
