import type { Box, NodeRecord, Vec } from '@canvcode/core'
import { COLORS as SLIDE_COLORS } from '@canvcode/slides/core/slide-layout-spec'
import { ARROW_COLORS } from './arrow.ts'
import { defineNodeType, outsetSides, type Outset } from './defineNodeType.ts'
import { normalizeColor, parseHexColor } from './paint.ts'
import { textMetricsGeneration } from './text/fonts.ts'
import { TEXT_BAR_THRESHOLD_PX, drawTextBars, drawTextLayout, layoutRichText, type TextLayout, type TextStyle } from './text/layout.ts'
import type { TextParagraph } from './text/richText.ts'

// グラフ（MAI-88）。データは「ラベル・値・色」の行（rows）。今は円グラフ（kind: 'pie'）だけ。
// 後で棒グラフなどを足すときは、kind を足して、描き方・当たり判定・縁を kind ごとに分ける（rows はそのまま使える）。
// - 色：行の color がなければ、テンプレートの色（CHART_COLORS）から行の順で割り当てる（行を足し・消すと、色を決めていない行の色は並びに付いてくる）
// - 値：正の値だけを扇にする。0・負の値・読めない値の行は描かない（ラベルも出さない）が、データには残す（％は正の値の合計に対する割合）。
//   正の値が 1 つもない（合計 0・行がない）ときは、薄い灰色の輪（または円）だけを描く
// - ドーナツ：innerRadius は外の半径に対する穴の半径の割合（0〜0.9）。穴は当たらない（選んでいれば、箱の中で掴める。Editor.hitTest）
// - 開始角度：startAngle は最初の扇の始まりの向き（度。0 が 12 時の向き、時計回り。Excel・PowerPoint と同じ）
// - ラベル：showLabels（行のラベル）と showPercent（％）。入る扇は扇の中、入らない扇は外に出して引き出し線でつなぐ。
//   外のラベルが箱からはみ出すときは、円を小さくして（元の 60 % まで）箱に収める。それでもはみ出す分は renderOutset で描く範囲に入れる
// - 文字は layout.ts のレイアウトと描画（フォント・Web フォントの読み込み・文字間と同じ仕組み）。画面上で小さい文字は帯で描く（TEXT_BAR_THRESHOLD_PX）

export type ChartKind = 'pie'
export const CHART_KINDS: readonly ChartKind[] = ['pie']

export interface ChartRow {
  label: string
  value: number
  // 扇の色（#rrggbb）。なければ CHART_COLORS から行の順で割り当てる
  color?: string
}

export interface ChartProps {
  kind: ChartKind
  w: number
  h: number
  rows: ChartRow[]
  // ドーナツの穴の半径（外の半径に対する割合。0〜0.9）
  innerRadius: number
  // 最初の扇の始まり（度。0 が 12 時、時計回り）
  startAngle: number
  showLabels: boolean
  showPercent: boolean
}

export type ChartNode = NodeRecord<ChartProps>

// グラフの色の並び（MAI-88）。カラーピッカーのテンプレートの色（MAI-81 の colorPresets.ts）のうち、扇どうしを見分けやすい色を選んだもの：
// キャンバスの標準の色（ペン・矢印の青・オレンジ・緑・赤、図形の線の藍、黒）と、スライドのテーマのパネルの灰色。
// スライドのテーマ色は白黒と淡い灰・クリームだけなので、灰色 1 つだけを使う。7 行を超えると最初に戻る
export const CHART_COLORS: readonly string[] = [
  ARROW_COLORS[2],
  ARROW_COLORS[4],
  ARROW_COLORS[3],
  ARROW_COLORS[1],
  '#3b5bdb',
  ARROW_COLORS[0],
  SLIDE_COLORS.panel,
]

export const CHART_DEFAULT_SIZE = 240
export const CHART_INNER_RADIUS_MAX = 0.9
const EMPTY_FILL = '#f1f3f5'
const EMPTY_STROKE = '#ced4da'
const OUTSIDE_TEXT_COLOR = '#1f2328'
const LEADER_COLOR = '#868e96'
// 外のラベルを収めるために円を小さくする限度（箱に収まる円の半径に対する割合）
const MIN_RADIUS_RATIO = 0.6
const OUTLINE_POINTS = 64

export function defaultChartRows(): ChartRow[] {
  return [
    { label: '項目 1', value: 50 },
    { label: '項目 2', value: 30 },
    { label: '項目 3', value: 20 },
  ]
}

// ---- 値の読み方 ----

// 行の一覧を読む。読めない行（オブジェクトでない）は捨て、ラベルは文字列、値は有限の数（読めなければ 0）、色は 16 進の色だけ残す
export function chartRowsOf(value: unknown): ChartRow[] {
  if (!Array.isArray(value)) return []
  const rows: ChartRow[] = []
  for (const item of value) {
    const row = toChartRow(item)
    if (row) rows.push(row)
  }
  return rows
}

export function toChartRow(item: unknown): ChartRow | null {
  if (!item || typeof item !== 'object') return null
  const raw = item as { label?: unknown; value?: unknown; color?: unknown }
  const label = typeof raw.label === 'string' ? raw.label : raw.label === undefined || raw.label === null ? '' : String(raw.label)
  const value = typeof raw.value === 'number' && Number.isFinite(raw.value) ? raw.value : 0
  const color = typeof raw.color === 'string' && parseHexColor(raw.color) ? normalizeColor(raw.color) : undefined
  return color ? { label, value, color } : { label, value }
}

export function clampInnerRadius(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(CHART_INNER_RADIUS_MAX, Math.max(0, value)) : 0
}

export function clampStartAngle(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(360, Math.max(-360, value)) : 0
}

// 行の色（決めていなければテンプレートの色を行の順で）
export function chartRowColor(row: ChartRow, index: number): string {
  return row.color ?? autoChartColor(index)
}

export function autoChartColor(index: number): string {
  return CHART_COLORS[((index % CHART_COLORS.length) + CHART_COLORS.length) % CHART_COLORS.length]
}

// 行ごとの割合（0〜1）。正の値の合計に対する割合で、0・負の値の行は 0。合計が 0 なら、すべて 0
export function chartFractions(rows: readonly ChartRow[]): number[] {
  const total = rows.reduce((sum, row) => sum + (row.value > 0 ? row.value : 0), 0)
  return rows.map((row) => (total > 0 && row.value > 0 ? row.value / total : 0))
}

// ％の表し方。1 % 未満は小数 1 桁（0 % と見分ける）、それ以外は整数
export function formatPercent(fraction: number): string {
  const percent = fraction * 100
  if (percent > 0 && percent < 1) return `${Math.max(0.1, Math.round(percent * 10) / 10)}%`
  return `${Math.round(percent)}%`
}

// ---- 表の貼り付け（CSV・TSV） ----

// 表の文字（CSV・TSV。表計算から貼り付けたものなど）を行にする。1 列目がラベル、2 列目が値、3 列目が 16 進の色なら色。
// - 区切り：タブがあればタブ、なければカンマ（カンマがなくセミコロンがあればセミコロン）。CSV の "…" の中の区切り・改行は文字として読む
// - 見出し：1 行目の 2 列目が数でなく、2 行目以降に数があれば見出しとして飛ばす
// - 値：前後の空白・桁区切りのカンマ・%・通貨の記号を除いて読む（全角の数字も読む）。読めなければ 0
// - 列が 1 つだけの行：数ならラベルなしの値、そうでなければ値 0 のラベル
// 空の行は飛ばす。行が 1 つもなければ null
export function parseChartTable(text: string): ChartRow[] | null {
  const source = text.replace(/\r\n?/g, '\n')
  const delimiter = source.includes('\t') ? '\t' : !source.includes(',') && source.includes(';') ? ';' : ','
  const records = splitDelimited(source, delimiter).filter((cells) => cells.some((cell) => cell.trim() !== ''))
  if (records.length === 0) return null
  const header = records.length > 1 && records[0].length > 1 && parseChartNumber(records[0][1]) === null && records.slice(1).some((cells) => parseChartNumber(cells[1] ?? '') !== null)
  const rows: ChartRow[] = []
  for (const cells of header ? records.slice(1) : records) {
    if (cells.length === 1) {
      const value = parseChartNumber(cells[0])
      rows.push(value === null ? { label: cells[0].trim(), value: 0 } : { label: '', value })
      continue
    }
    const row: ChartRow = { label: cells[0].trim(), value: parseChartNumber(cells[1]) ?? 0 }
    const color = cells[2]?.trim()
    if (color && parseHexColor(color)) row.color = normalizeColor(color)
    rows.push(row)
  }
  return rows
}

// 表の 1 つの値を数にする。読めなければ null
export function parseChartNumber(text: string): number | null {
  const cleaned = text
    .normalize('NFKC')
    .trim()
    .replace(/^[¥$€£]|[%円]$/g, '')
    .replace(/(\d),(?=\d{3}(\D|$))/g, '$1')
    .replace(/^−/, '-')
    .trim()
  if (cleaned === '' || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(cleaned)) return null
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : null
}

// 区切り文字の表を、行ごとのセルにする（CSV の "…" と "" を読む）
function splitDelimited(text: string, delimiter: string): string[][] {
  const records: string[][] = []
  let cells: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && cell.trim() === '') {
      quoted = true
      cell = ''
    } else if (ch === delimiter) {
      cells.push(cell)
      cell = ''
    } else if (ch === '\n') {
      cells.push(cell)
      records.push(cells)
      cells = []
      cell = ''
    } else cell += ch
  }
  cells.push(cell)
  records.push(cells)
  return records
}

// ---- 形 ----

export interface PieSlice {
  // 行の番号
  index: number
  // 扇の始まりと終わり（Canvas の角度。ラジアン。3 時が 0、時計回り）
  start: number
  end: number
  color: string
  fraction: number
}

export interface PieLabel {
  index: number
  layout: TextLayout
  style: TextStyle
  // 文字を置く箱（ローカル座標）
  box: Box
  inside: boolean
  // 外のラベルの引き出し線（扇の縁から、折れて文字の横まで）
  leader?: Vec[]
}

export interface PieGeometry {
  center: Vec
  radius: number
  inner: number
  slices: PieSlice[]
  labels: PieLabel[]
  fontSize: number
  // 正の値が 1 つもない
  empty: boolean
}

// 文字の大きさ：円の半径に合わせる（大きな円の図をスライドに置いても読める大きさ）
function labelFontSize(radius: number): number {
  return Math.max(9, Math.min(32, Math.round(radius * 0.12)))
}

// 円グラフの形（扇・ラベルの位置）。props ごとに覚えておく（フォントを読み込んで測り直したら作り直す）
const geometryCache = new WeakMap<ChartProps, { generation: number; geometry: PieGeometry }>()

export function pieGeometry(props: ChartProps): PieGeometry {
  const generation = textMetricsGeneration()
  const cached = geometryCache.get(props)
  if (cached && cached.generation === generation) return cached.geometry
  const w = Math.max(1, props.w)
  const h = Math.max(1, props.h)
  const full = Math.min(w, h) / 2
  let geometry = layoutPie(props, full)
  // 外のラベルが箱からはみ出すなら、その分だけ円を小さくして（限度まで）やり直す
  const over = labelOverflow(geometry.labels, w, h)
  if (over > 0) geometry = layoutPie(props, Math.max(full * MIN_RADIUS_RATIO, full - over), geometry.fontSize)
  geometryCache.set(props, { generation, geometry })
  return geometry
}

function layoutPie(props: ChartProps, radius: number, fontSize = labelFontSize(radius)): PieGeometry {
  const center = { x: Math.max(1, props.w) / 2, y: Math.max(1, props.h) / 2 }
  const inner = radius * clampInnerRadius(props.innerRadius)
  const rows = chartRowsOf(props.rows)
  const fractions = chartFractions(rows)
  const slices: PieSlice[] = []
  let angle = ((clampStartAngle(props.startAngle) - 90) * Math.PI) / 180
  rows.forEach((row, index) => {
    const fraction = fractions[index]
    if (fraction <= 0) return
    const end = angle + fraction * Math.PI * 2
    slices.push({ index, start: angle, end, color: chartRowColor(row, index), fraction })
    angle = end
  })
  const labels: PieLabel[] = []
  for (const slice of slices) {
    const label = sliceLabel(props, rows[slice.index], slice, center, radius, inner, fontSize)
    if (label) labels.push(label)
  }
  spreadOutsideLabels(labels, center, radius, fontSize)
  return { center, radius, inner, slices, labels, fontSize, empty: slices.length === 0 }
}

function sliceLabel(props: ChartProps, row: ChartRow, slice: PieSlice, center: Vec, radius: number, inner: number, fontSize: number): PieLabel | null {
  const paragraphs: TextParagraph[] = []
  if (props.showLabels && row.label.trim() !== '') paragraphs.push({ runs: [{ text: row.label }] })
  if (props.showPercent) paragraphs.push({ runs: [{ text: formatPercent(slice.fraction), format: { bold: true } }] })
  if (paragraphs.length === 0) return null
  const insideStyle: TextStyle = { fontSize, lineHeight: 1.2, fontWeight: 400, color: textColorOn(slice.color), align: 'center' }
  const insideLayout = layoutRichText(paragraphs, insideStyle, null)
  const mid = (slice.start + slice.end) / 2
  const dir = { x: Math.cos(mid), y: Math.sin(mid) }
  // 扇の中：穴があれば輪の真ん中、なければ半径の 6 割の所から（入らなければ中心寄り・縁寄りも試す）。扇が円全体なら中心
  const whole = slice.end - slice.start >= Math.PI * 2 - 1e-6
  const candidates = whole && inner === 0 ? [0] : inner > 0 ? [0.5, 0.45, 0.55].map((t) => inner + (radius - inner) * t) : [0.6, 0.5, 0.4, 0.7].map((t) => radius * t)
  for (const at of candidates) {
    const p = { x: center.x + dir.x * at, y: center.y + dir.y * at }
    const box = { x: p.x - insideLayout.width / 2, y: p.y - insideLayout.height / 2, w: insideLayout.width, h: insideLayout.height }
    if (boxInsideSlice(box, slice, center, radius, inner, fontSize * 0.2)) return { index: slice.index, layout: insideLayout, style: insideStyle, box, inside: true }
  }
  // 扇の外：縁から少し離れた所で折れ、横へ伸ばして、円の左右の列にそろえて置く（右半分は左揃えで右の列、左半分は右揃えで左の列）
  const right = dir.x >= 0
  const outsideStyle: TextStyle = { ...insideStyle, color: OUTSIDE_TEXT_COLOR, align: right ? 'left' : 'right' }
  const layout = layoutRichText(paragraphs, outsideStyle, null)
  const a = { x: center.x + dir.x * (radius + fontSize * 0.2), y: center.y + dir.y * (radius + fontSize * 0.2) }
  const elbow = { x: center.x + dir.x * (radius + fontSize * 0.8), y: center.y + dir.y * (radius + fontSize * 0.8) }
  const end = { x: center.x + (right ? 1 : -1) * (radius + fontSize * 1.4), y: elbow.y }
  const gap = fontSize * 0.3
  const outsideBox = { x: right ? end.x + gap : end.x - gap - layout.width, y: end.y - layout.height / 2, w: layout.width, h: layout.height }
  return { index: slice.index, layout, style: outsideStyle, box: outsideBox, inside: false, leader: [a, elbow, end] }
}

// 外のラベルが重ならないよう、左右それぞれ縦に並べ直す。重なるラベルどうしはまとめ、まとまりを元の位置の平均を中心に
// 縦に積む（上下どちらにも広がる）。折れる点は、ラベルの高さで円から同じだけ離れた所に動かす（線が円を横切りにくいように）
function spreadOutsideLabels(labels: PieLabel[], center: Vec, radius: number, fontSize: number): void {
  const spacing = fontSize * 0.15
  for (const right of [true, false]) {
    const side = labels.filter((label) => !label.inside && (label.style.align === 'left') === right).sort((a, b) => a.box.y - b.box.y)
    const groups: { labels: PieLabel[]; ideal: number; height: number; top: number }[] = []
    for (const label of side) {
      groups.push({ labels: [label], ideal: label.box.y + label.box.h / 2, height: label.box.h, top: label.box.y })
      // 前のまとまりと重なる間はまとめる
      while (groups.length > 1) {
        const last = groups[groups.length - 1]
        const previous = groups[groups.length - 2]
        if (previous.top + previous.height + spacing <= last.top) break
        const count = previous.labels.length + last.labels.length
        const ideal = (previous.ideal * previous.labels.length + last.ideal * last.labels.length) / count
        const height = previous.height + spacing + last.height
        groups.splice(-2, 2, { labels: [...previous.labels, ...last.labels], ideal, height, top: ideal - height / 2 })
      }
    }
    for (const group of groups) {
      let top = group.top
      for (const label of group.labels) {
        const dy = top - label.box.y
        if (dy !== 0 && label.leader) {
          label.box = { ...label.box, y: top }
          const [a, elbow, end] = label.leader
          const y = end.y + dy
          const reach = radius + fontSize * 0.8
          const offset = y - center.y
          const x = Math.abs(offset) < reach ? center.x + (right ? 1 : -1) * Math.sqrt(reach * reach - offset * offset) : elbow.x
          label.leader = [a, { x, y }, { x: end.x, y }]
        }
        top += label.box.h + spacing
      }
    }
  }
}

// 箱の 4 つの角が扇（輪の中・角度の中）に、pad だけ内側で入っているか
function boxInsideSlice(box: Box, slice: PieSlice, center: Vec, radius: number, inner: number, pad: number): boolean {
  const sweep = slice.end - slice.start
  const corners = [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x, y: box.y + box.h },
    { x: box.x + box.w, y: box.y + box.h },
  ]
  for (const corner of corners) {
    const dx = corner.x - center.x
    const dy = corner.y - center.y
    const d = Math.hypot(dx, dy)
    if (d > radius - pad) return false
    if (inner > 0 && d < inner + pad) return false
    if (sweep >= Math.PI * 2 - 1e-6 || d < 1e-9) continue
    const fromStart = angleOffset(Math.atan2(dy, dx), slice.start)
    if (fromStart > sweep) return false
    // 扇の辺から pad だけ離れているか（辺までの距離 = d × sin(辺からの角度)）
    const fromEnd = sweep - fromStart
    if (Math.min(fromStart, fromEnd) < Math.PI / 2 && d * Math.sin(Math.min(fromStart, fromEnd)) < pad) return false
  }
  return true
}

// start から時計回りに angle まで（0〜2π）
function angleOffset(angle: number, start: number): number {
  const tau = Math.PI * 2
  return (((angle - start) % tau) + tau) % tau
}

// ラベルが箱 (0, 0, w, h) からはみ出す長さ（いちばん大きいもの）
function labelOverflow(labels: readonly PieLabel[], w: number, h: number): number {
  let over = 0
  for (const label of labels) {
    if (label.inside) continue
    over = Math.max(over, -label.box.x, -label.box.y, label.box.x + label.box.w - w, label.box.y + label.box.h - h)
  }
  return over
}

// 扇の色の上の文字の色：明るい色なら黒、暗い色なら白
function textColorOn(color: string): string {
  const rgba = parseHexColor(color)
  if (!rgba) return '#ffffff'
  const luminance = (0.299 * rgba.r + 0.587 * rgba.g + 0.114 * rgba.b) / 255
  return luminance > 0.6 ? OUTSIDE_TEXT_COLOR : '#ffffff'
}

// 扇のパス（穴があれば輪の一部）
function slicePath(ctx: CanvasRenderingContext2D | Path2D, center: Vec, radius: number, inner: number, start: number, end: number): void {
  const whole = end - start >= Math.PI * 2 - 1e-6
  if (whole) {
    ctx.moveTo(center.x + radius, center.y)
    ctx.arc(center.x, center.y, radius, 0, Math.PI * 2)
    if (inner > 0) {
      ctx.moveTo(center.x + inner, center.y)
      ctx.arc(center.x, center.y, inner, Math.PI * 2, 0, true)
    }
    return
  }
  if (inner > 0) {
    ctx.moveTo(center.x + Math.cos(start) * inner, center.y + Math.sin(start) * inner)
    ctx.arc(center.x, center.y, radius, start, end)
    ctx.arc(center.x, center.y, inner, end, start, true)
  } else {
    ctx.moveTo(center.x, center.y)
    ctx.arc(center.x, center.y, radius, start, end)
  }
  ctx.closePath()
}

function drawSlices(ctx: CanvasRenderingContext2D, geometry: PieGeometry, zoom: number): void {
  const { center, radius, inner, slices } = geometry
  if (geometry.empty) {
    ctx.beginPath()
    slicePath(ctx, center, radius, inner, 0, Math.PI * 2)
    ctx.fillStyle = EMPTY_FILL
    ctx.fill('evenodd')
    ctx.lineWidth = 1 / zoom
    ctx.strokeStyle = EMPTY_STROKE
    ctx.stroke()
    return
  }
  for (const slice of slices) {
    ctx.beginPath()
    slicePath(ctx, center, radius, inner, slice.start, slice.end)
    ctx.fillStyle = slice.color
    ctx.fill('evenodd')
  }
  // 扇の境目に白い線（隣どうしが似た色でも見分けられるように）。画面上で 0.5 ピクセル未満なら描かない
  const width = Math.min(2, radius * 0.012)
  if (slices.length < 2 || width * zoom < 0.5) return
  ctx.beginPath()
  for (const slice of slices) {
    ctx.moveTo(center.x + Math.cos(slice.start) * inner, center.y + Math.sin(slice.start) * inner)
    ctx.lineTo(center.x + Math.cos(slice.start) * radius, center.y + Math.sin(slice.start) * radius)
  }
  ctx.lineWidth = width
  ctx.lineCap = 'butt'
  ctx.strokeStyle = '#ffffff'
  ctx.stroke()
}

function drawLabels(ctx: CanvasRenderingContext2D, geometry: PieGeometry, zoom: number): void {
  const bars = geometry.fontSize * zoom < TEXT_BAR_THRESHOLD_PX
  const leaders = geometry.labels.filter((label) => label.leader)
  if (leaders.length > 0) {
    ctx.beginPath()
    for (const { leader } of leaders) {
      ctx.moveTo(leader![0].x, leader![0].y)
      for (const p of leader!.slice(1)) ctx.lineTo(p.x, p.y)
    }
    ctx.lineWidth = Math.max(geometry.fontSize * 0.07, 0.5 / zoom)
    ctx.lineJoin = 'round'
    ctx.strokeStyle = LEADER_COLOR
    ctx.stroke()
  }
  for (const label of geometry.labels) {
    if (bars) drawTextBars(ctx, label.layout, label.style, label.box, 'top')
    else drawTextLayout(ctx, label.layout, label.style, label.box, 'top')
  }
}

// 円か輪の中か。grow だけ外へ広げ、穴は grow だけ縮めて判定する
function insideRing(geometry: PieGeometry, point: Vec, grow: number): boolean {
  const d = Math.hypot(point.x - geometry.center.x, point.y - geometry.center.y)
  if (d > geometry.radius + grow) return false
  return geometry.inner <= 0 || d >= geometry.inner - grow
}

function insideBox(box: Box, point: Vec, margin: number): boolean {
  return point.x >= box.x - margin && point.y >= box.y - margin && point.x <= box.x + box.w + margin && point.y <= box.y + box.h + margin
}

export const chartType = defineNodeType<ChartProps>({
  type: 'chart',
  version: 1,

  defaultProps: () => ({
    kind: 'pie',
    w: CHART_DEFAULT_SIZE,
    h: CHART_DEFAULT_SIZE,
    rows: defaultChartRows(),
    innerRadius: 0,
    startAngle: 0,
    showLabels: true,
    showPercent: true,
  }),

  getBounds: (node) => ({ x: 0, y: 0, w: node.props.w, h: node.props.h }),

  // 箱に収まらない外のラベル（円を限度まで小さくしてもはみ出す分）
  renderOutset: (node): Outset => {
    const { w, h } = node.props
    const outset = { left: 0, top: 0, right: 0, bottom: 0 }
    for (const label of pieGeometry(node.props).labels) {
      if (label.inside) continue
      outset.left = Math.max(outset.left, -label.box.x)
      outset.top = Math.max(outset.top, -label.box.y)
      outset.right = Math.max(outset.right, label.box.x + label.box.w - w)
      outset.bottom = Math.max(outset.bottom, label.box.y + label.box.h - h)
    }
    return outsetSides(outset)
  },

  // 円（ドーナツは輪。穴は当たらない）と外のラベルの文字に当たる。円の外の箱の隅には当たらない（楕円の図形と同じ）
  hitTest(node, point, margin) {
    const geometry = pieGeometry(node.props)
    if (insideRing(geometry, point, margin)) return true
    return geometry.labels.some((label) => !label.inside && insideBox(label.box, point, margin))
  },

  render(ctx, node, info) {
    const geometry = pieGeometry(node.props)
    drawSlices(ctx, geometry, info.zoom)
    drawLabels(ctx, geometry, info.zoom)
  },

  // ズームアウト時：扇だけ（文字・引き出し線は描かない）
  renderRough(ctx, node, info) {
    drawSlices(ctx, pieGeometry(node.props), info.zoom)
  },

  roughColor: (node) => {
    const rows = chartRowsOf(node.props.rows)
    return rows.length > 0 ? chartRowColor(rows[0], 0) : EMPTY_FILL
  },

  // 行の色（自動で割り当てた色も、描いている色として出す）
  colors: (node) => chartRowsOf(node.props.rows).map(chartRowColor),

  // 矢印の端は円の縁で止める
  outline(node) {
    const { center, radius } = pieGeometry(node.props)
    const points: Vec[] = []
    for (let i = 0; i < OUTLINE_POINTS; i++) {
      const a = (i / OUTLINE_POINTS) * Math.PI * 2
      points.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) })
    }
    return points
  },

  resize: (node, size) => ({ ...node.props, w: size.w, h: size.h }),
  minSize: { w: 20, h: 20 },
})

// グラフのノードか
export function isChart(node: NodeRecord): node is ChartNode {
  return node.type === 'chart'
}
