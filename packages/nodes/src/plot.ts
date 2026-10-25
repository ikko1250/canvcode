import { parseTableFile } from './table/tableCard.ts'
import { isNumericColumn } from './table/tableView.ts'

// CSV から作るグラフ（matplotlib）。サーバーが apps/server/plot/plot.py で PNG に描き、画像のノード（image）として置く。
// 描いた画像のノードは、作り方（PlotSpec）を props.plot に持つ。CSV を直したあとに「グラフを描き直す」と同じ作り方で描き直し、
// 「グラフを編集…」で作り方を変える。スタイルはワークスペースの style.py（なければ同梱の apps/server/plot/style.py を写す）

export type PlotKind = 'line' | 'bar' | 'barh' | 'stacked' | 'area' | 'scatter' | 'pie' | 'hist' | 'box'

export const PLOT_KINDS: readonly PlotKind[] = ['line', 'bar', 'barh', 'stacked', 'area', 'scatter', 'pie', 'hist', 'box']

export const PLOT_KIND_LABELS: Record<PlotKind, string> = {
  line: '折れ線',
  bar: '棒',
  barh: '横棒',
  stacked: '積み上げ棒',
  area: '積み上げ面',
  scatter: '散布図',
  pie: '円',
  hist: 'ヒストグラム',
  box: '箱ひげ',
}

// 横の軸（x）を使わない種類（値の列だけで描く）
export function plotUsesX(kind: PlotKind): boolean {
  return kind !== 'hist' && kind !== 'box'
}

export interface PlotSpec {
  // 表（CSV）の File
  fileId: string
  // 1 行目を見出しにするか（表のカードと同じ）
  header: boolean
  // 横の軸の列（0 から）。null なら行の番号
  x: number | null
  // 値の列（0 から。1 つ以上）
  y: number[]
  kind: PlotKind
  // style.py の STYLES のキー
  style: string
  title: string
  // 軸の名前。null なら列の名前から決める
  xlabel: string | null
  ylabel: string | null
  // 凡例。null なら系列が 2 つ以上のときだけ
  legend: boolean | null
  // 描く画像の大きさ（画素）
  width: number
  height: number
}

export const PLOT_DEFAULT_WIDTH = 1280
export const PLOT_DEFAULT_HEIGHT = 800
export const PLOT_MAX_SIDE = 4000
export const PLOT_MIN_SIDE = 150
export const PLOT_MAX_SERIES = 20
// 置くときの画像のノードの幅（ワールド座標）。画素の半分にして、2 倍に拡大しても粗くならないようにする
export const PLOT_NODE_SCALE = 0.5

const clampSide = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(PLOT_MAX_SIDE, Math.max(PLOT_MIN_SIDE, value))) : fallback
const columnIndex = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null)
const textOrNull = (value: unknown) => (typeof value === 'string' ? value : null)

// 保存してある作り方を読む（ほかのタブ・AI が書いたものも、形を確かめてから使う）。読めなければ null
export function normalizePlotSpec(raw: unknown): PlotSpec | null {
  if (!raw || typeof raw !== 'object') return null
  const spec = raw as Record<string, unknown>
  if (typeof spec.fileId !== 'string' || !spec.fileId) return null
  const y = Array.isArray(spec.y) ? spec.y.map(columnIndex).filter((c): c is number => c !== null).slice(0, PLOT_MAX_SERIES) : []
  if (y.length === 0) return null
  const kind = PLOT_KINDS.includes(spec.kind as PlotKind) ? (spec.kind as PlotKind) : 'line'
  return {
    fileId: spec.fileId,
    header: spec.header !== false,
    x: columnIndex(spec.x),
    y,
    kind,
    style: typeof spec.style === 'string' ? spec.style : '',
    title: typeof spec.title === 'string' ? spec.title : '',
    xlabel: textOrNull(spec.xlabel),
    ylabel: textOrNull(spec.ylabel),
    legend: typeof spec.legend === 'boolean' ? spec.legend : null,
    width: clampSide(spec.width, PLOT_DEFAULT_WIDTH),
    height: clampSide(spec.height, PLOT_DEFAULT_HEIGHT),
  }
}

export interface PlotColumn {
  index: number
  // 見出しの文字（見出しがない・空なら「列 N」）
  name: string
  numeric: boolean
}

export interface PlotTable {
  columns: PlotColumn[]
  // 見出しを除いた行
  rows: string[][]
}

// 表の File の本文を、列の一覧とデータの行にする（画面の作る画面と、サーバーの描く前の準備が同じものを使う）
export function plotTable(text: string, path: string | undefined, header: boolean): PlotTable {
  const all = parseTableFile(text, path)
  const width = all.reduce((max, row) => Math.max(max, row.length), 0)
  const start = header ? 1 : 0
  const columns = Array.from({ length: width }, (_, index) => ({
    index,
    name: (header ? all[0]?.[index]?.trim() : '') || `列 ${index + 1}`,
    numeric: isNumericColumn(all, index, start),
  }))
  return { columns, rows: all.slice(start) }
}

// 作り方を新しく決めるときの既定：横の軸は最初の数でない列（なければ行の番号）、値は残りの数の列（多ければ先頭から）
export function defaultPlotSpec(fileId: string, table: PlotTable, header: boolean, style: string): PlotSpec {
  const x = table.columns.find((c) => !c.numeric)?.index ?? null
  const numeric = table.columns.filter((c) => c.numeric && c.index !== x).map((c) => c.index)
  const y = numeric.length ? numeric.slice(0, 6) : table.columns.filter((c) => c.index !== x).slice(0, 1).map((c) => c.index)
  return {
    fileId,
    header,
    x,
    y,
    kind: 'line',
    style,
    title: '',
    xlabel: null,
    ylabel: null,
    legend: null,
    width: PLOT_DEFAULT_WIDTH,
    height: PLOT_DEFAULT_HEIGHT,
  }
}

// 列を名前か番号で探す（AI は名前で渡すことが多い）。名前は前後の空白と全角半角・大文字小文字を区別しない。見つからなければ null
export function findPlotColumn(columns: readonly PlotColumn[], ref: string | number): number | null {
  if (typeof ref === 'number') return Number.isInteger(ref) && ref >= 0 && ref < columns.length ? ref : null
  const key = ref.normalize('NFKC').trim().toLowerCase()
  const found = columns.find((c) => c.name.normalize('NFKC').trim().toLowerCase() === key)
  if (found) return found.index
  // 「列 3」や "3" のような番号（1 から）
  const n = /^(?:列\s*)?(\d+)$/.exec(key)
  return n && Number(n[1]) >= 1 && Number(n[1]) <= columns.length ? Number(n[1]) - 1 : null
}
