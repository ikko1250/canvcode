import { parseChartNumber } from '../chart.ts'

// 表のカードの見せ方：絞り込み（filters）と並び替え（sort）。File（CSV）は変えず、カードごとに持つ。
// - 絞り込み：列ごとの条件をすべて満たす行だけを見せる（AND）。文字は NFKC で揃え、大文字小文字を区別しない。
//   大小の比べ（gt・ge・lt・le）は、数として読めるセルだけが当たる。equals・notEquals は、どちらも数なら数として比べる
// - 並び替え：1 つの列で昇順・降順。数の列は数として、それ以外は日本語の順（数字は数の順）で比べる。空のセルは向きによらず後ろ。
//   同じ値の行は元の順のまま
// - 見出しの行（header）は、絞り込み・並び替えの外で、いつも先頭に置く
// 列は 0 から始まる番号で持つ（CSV の列が変わったら、番号のまま当てる）

export type TableFilterOp = 'contains' | 'notContains' | 'equals' | 'notEquals' | 'gt' | 'ge' | 'lt' | 'le' | 'empty' | 'notEmpty'

export interface TableFilter {
  col: number
  op: TableFilterOp
  // empty・notEmpty では使わない
  value: string
}

export interface TableSort {
  col: number
  dir: 'asc' | 'desc'
}

// 値を要らない条件
export function filterNeedsValue(op: TableFilterOp): boolean {
  return op !== 'empty' && op !== 'notEmpty'
}

// 条件の書き方（メニュー・名前の帯）
export const FILTER_OP_LABELS: Record<TableFilterOp, string> = {
  contains: '含む',
  notContains: '含まない',
  equals: '＝',
  notEquals: '≠',
  gt: '＞',
  ge: '≧',
  lt: '＜',
  le: '≦',
  empty: '空',
  notEmpty: '空でない',
}

// 列が数だけか（見出しを除く、空でないセルがすべて数として読める。空でないセルがなければ数でない）。
// 多い表でも、見るのは先頭の limit 行まで
export function isNumericColumn(rows: string[][], col: number, start: number, limit = 2000): boolean {
  let numbers = 0
  const end = Math.min(rows.length, start + limit)
  for (let i = start; i < end; i++) {
    const text = rows[i][col] ?? ''
    if (text === '') continue
    if (parseChartNumber(text) === null) return false
    numbers++
  }
  return numbers > 0
}

const normalize = (text: string) => text.normalize('NFKC').toLowerCase().trim()

export function matchesFilter(cell: string | undefined, filter: TableFilter): boolean {
  const text = cell ?? ''
  switch (filter.op) {
    case 'empty':
      return text.trim() === ''
    case 'notEmpty':
      return text.trim() !== ''
    case 'contains':
      return normalize(text).includes(normalize(filter.value))
    case 'notContains':
      return !normalize(text).includes(normalize(filter.value))
    case 'equals':
    case 'notEquals': {
      const a = parseChartNumber(text)
      const b = parseChartNumber(filter.value)
      const equal = a !== null && b !== null ? a === b : normalize(text) === normalize(filter.value)
      return filter.op === 'equals' ? equal : !equal
    }
    default: {
      const a = parseChartNumber(text)
      const b = parseChartNumber(filter.value)
      if (a === null || b === null) return false
      if (filter.op === 'gt') return a > b
      if (filter.op === 'ge') return a >= b
      if (filter.op === 'lt') return a < b
      return a <= b
    }
  }
}

const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' })

// 見せる行：見出し（あれば）のあとに、絞り込んで並べ替えたデータの行。何もしなければ rows をそのまま返す
export function applyTableView(rows: string[][], view: { header: boolean; sort?: TableSort | null; filters?: readonly TableFilter[] }): string[][] {
  const filters = (view.filters ?? []).filter((f) => !filterNeedsValue(f.op) || f.value.trim() !== '')
  const sort = view.sort ?? null
  if (filters.length === 0 && !sort) return rows
  const start = view.header && rows.length > 0 ? 1 : 0
  let body = rows.slice(start)
  if (filters.length > 0) body = body.filter((row) => filters.every((f) => matchesFilter(row[f.col], f)))
  if (sort) {
    const numeric = isNumericColumn(rows, sort.col, start)
    const sign = sort.dir === 'asc' ? 1 : -1
    const keyed = body.map((row, index) => {
      const text = row[sort.col] ?? ''
      return { row, index, empty: text.trim() === '', number: numeric ? parseChartNumber(text) : null, text }
    })
    keyed.sort((a, b) => {
      if (a.empty !== b.empty) return a.empty ? 1 : -1
      let order = 0
      if (a.number !== null && b.number !== null) order = a.number - b.number
      else if (!a.empty) order = collator.compare(a.text, b.text)
      return order * sign || a.index - b.index
    })
    body = keyed.map((k) => k.row)
  }
  return start === 1 ? [rows[0], ...body] : body
}

// 数の 3 桁区切り（thousands。既定は区切る）：数だけの列のセルの、整数の部分が 4 桁以上で区切りのないものに「,」を入れる。
// 符号・通貨の記号・小数・% などはそのまま。見出しの行と、数でないセル（その列の数でない列）は変えない。File（CSV）は変えない
export function withThousandsSeparators(rows: string[][], header: boolean): string[][] {
  const start = header && rows.length > 0 ? 1 : 0
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const numeric = Array.from({ length: columns }, (_, col) => isNumericColumn(rows, col, start))
  if (!numeric.includes(true)) return rows
  return rows.map((row, i) => (i < start ? row : row.map((text, col) => (numeric[col] ? groupThousands(text) : text))))
}

// 1 つのセル。区切りのない整数の部分（4 桁以上）だけに入れる（"1,234"・"1e10"・"0.12345" はそのまま）
export function groupThousands(text: string): string {
  const match = /^(\s*[-+−]?[¥$€£]?[-+−]?)(\d{4,})((?:\.\d*)?\s*[%円]?\s*)$/.exec(text)
  if (!match) return text
  return match[1] + match[2].replace(/\B(?=(\d{3})+$)/g, ',') + match[3]
}

// ---- 見せ方を変える（パイメニュー「操作」。どれも新しい値を返す） ----

interface TableViewProps {
  sort?: TableSort | null
  filters?: TableFilter[]
}

// 並び替える（null なら並び替えをやめる）
export function withTableSort<T extends TableViewProps>(props: T, sort: TableSort | null): T {
  return { ...props, sort }
}

// 絞り込みの条件を足す。同じ列・同じ条件のものがあれば、値を置き換える（「≧ 100」と「≦ 200」は両方持てる）
export function withTableFilter<T extends TableViewProps>(props: T, filter: TableFilter): T {
  const filters = props.filters ?? []
  const index = filters.findIndex((f) => f.col === filter.col && f.op === filter.op)
  return { ...props, filters: index < 0 ? [...filters, filter] : filters.map((f, i) => (i === index ? filter : f)) }
}

// 絞り込みの条件を外す（col を渡せばその列だけ、省けばすべて）
export function withoutTableFilters<T extends TableViewProps>(props: T, col?: number): T {
  return { ...props, filters: col === undefined ? [] : (props.filters ?? []).filter((f) => f.col !== col) }
}
