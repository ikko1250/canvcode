import { parseChartNumber } from '../chart.ts'

// 表のカードの見せ方：絞り込み（filters）と並び替え（sort）。File（CSV）は変えず、カードごとに持つ。
// - 絞り込み：列ごとの条件をすべて満たす行だけを見せる（AND）。文字は NFKC で揃え、大文字小文字を区別しない。
//   大小の比べ（gt・ge・lt・le）は、セルと値を比べられるときだけ当たる（compareCell：どちらも数なら数として、
//   セルが日付で値が日付か年だけなら、値の精度まで日付として。MAI-94）。空のセルと欠損の印（N/A など）は当たらない。
//   equals・notEquals は、比べられれば比べ、比べられなければ文字で比べる。条件の値は 1 度だけ読む（compileFilter）
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

// 大小を比べる条件（値は数か日付でないと当たらない。MAI-94）
export function filterCompares(op: TableFilterOp): boolean {
  return op === 'gt' || op === 'ge' || op === 'lt' || op === 'le'
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

// ---- 欠損の印・日付・列の種類（MAI-94） ----

// 欠損の印（NFKC と前後の空白の除去・小文字にしたあとの形。「…」は NFKC で「...」になる）
const MISSING_MARKS = new Set(['n/a', 'na', '#n/a', '(na)', 'nan', 'null', '-', '—', 'ー', '...'])

// セルが欠損の印か（N/A・NA・#N/A・(NA)・NaN・null・-・—・ー・…。大文字小文字・全角半角を区別しない）。空のセルは印でない
export function isMissingValue(text: string): boolean {
  const trimmed = text.trim()
  // 印はどれも 4 文字まで（NFKC で長くなるのは「…」だけ）。長いセルは揃えずに外す
  if (trimmed === '' || trimmed.length > 4) return false
  return MISSING_MARKS.has(trimmed.normalize('NFKC').trim().toLowerCase())
}

// 日付の書き方（apps/server/plot/plot.py の parse_date と揃える。片方を変えたら、もう片方も変える）：
// 2026-11-06・2026/1/5・2026.1.5・2026-11・2010/1・2026年11月・2026年11月6日、日付のあとに時刻（2026-01-05 12:30・2026-01-05T12:30:45）。
// 時刻の秒の小数と、末尾の時差（Z・+09:00）は受けて、時差は使わない（書いてある時刻のまま比べる）
const DATE_PATTERN = /^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?(?:Z|[+-]\d{2}:?\d{2})?)?)?$/i
const JA_DATE_PATTERN = /^(\d{4})年(\d{1,2})月(?:(\d{1,2})日)?$/
// 条件の値の「年だけ」（2020・2020年）。セルの年だけは数と区別できないので、日付にしない
const YEAR_PATTERN = /^(\d{4})年?$/

// 日付として読む。[年, 月, 日?, 時?, 分?, 秒?] を返し、配列の長さが精度（2026-11 なら [2026, 11]）。
// 読めない・ありえない日付（2026-13-01・2026-02-30・25:00）は null。年だけ（2026）は null（数と区別できない）
export function parseTableDate(text: string): number[] | null {
  const s = text.normalize('NFKC').trim()
  const match = DATE_PATTERN.exec(s) ?? JA_DATE_PATTERN.exec(s)
  if (!match) return null
  const parts: number[] = []
  for (let i = 1; i < match.length && match[i] !== undefined; i++) parts.push(Number(match[i]))
  const [year, month, day, hour, minute, second] = parts
  if (month < 1 || month > 12) return null
  if (day !== undefined && (day < 1 || day > daysInMonth(year, month))) return null
  if (hour !== undefined && (hour > 23 || minute > 59 || (second !== undefined && second >= 60))) return null
  return parts
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

export type TableColumnKind = 'number' | 'date' | 'text'

// 列の種類（パイメニューのフィルターの項目を選ぶ）。見出しを除き、空のセルと欠損の印を数えずに、
// 残りのセルがすべて数なら 'number'、すべて日付なら 'date'、ほかは 'text'（残りのセルがなければ 'text'）。
// 多い表でも、見るのは空でないセルの先頭 limit 個まで（先頭に欠損が続いても、その先を見る）
export function columnKind(rows: string[][], col: number, start: number, limit = 2000): TableColumnKind {
  let seen = 0
  let number = true
  let date = true
  for (let i = start; i < rows.length && seen < limit; i++) {
    const text = rows[i][col] ?? ''
    if (text.trim() === '' || isMissingValue(text)) continue
    seen++
    if (number && parseChartNumber(text) === null) number = false
    if (date && parseTableDate(text) === null) date = false
    if (!number && !date) return 'text'
  }
  if (seen === 0) return 'text'
  return number ? 'number' : 'date'
}

// ---- 条件の判定 ----

const normalize = (text: string) => text.normalize('NFKC').toLowerCase().trim()

// 条件の値を読んだもの：数として・日付として（年だけも、[年] の日付として）
interface FilterValue {
  number: number | null
  date: number[] | null
}

function readFilterValue(value: string): FilterValue {
  const year = YEAR_PATTERN.exec(value.normalize('NFKC').trim())
  return { number: parseChartNumber(value), date: year ? [Number(year[1])] : parseTableDate(value) }
}

// 欠けた精度の埋め方（2026-11 は 2026-11-01 00:00:00 とみなす。plot.py の parse_date と同じ）
const DATE_FLOOR = [0, 1, 1, 0, 0, 0]
// 数字のあとに - / : 年 があるセルは数でない（parseChartNumber を呼ばずに外す。日付の列を速く比べる）
const NOT_NUMBER = /\d[-/:年]/

function compareValue(cell: string, value: FilterValue): number | null {
  if (value.number !== null && !NOT_NUMBER.test(cell)) {
    const n = parseChartNumber(cell)
    if (n !== null) return n < value.number ? -1 : n > value.number ? 1 : 0
  }
  if (value.date !== null) {
    const d = parseTableDate(cell)
    if (d === null) return null
    // 値の精度まで比べる（≧ 2012 は 2012-01-01 から、＝ 2026-11 は 11 月のどの日も）
    for (let i = 0; i < value.date.length; i++) {
      const a = d[i] ?? DATE_FLOOR[i]
      const b = value.date[i]
      if (a !== b) return a < b ? -1 : 1
    }
    return 0
  }
  return null
}

// セルと条件の値の大小（負・0・正）。どちらも数なら数として、セルが日付で値が日付か年だけなら、値の精度まで日付として比べる。
// 比べられなければ null（空のセル・欠損の印・文字）
export function compareCell(cell: string, value: string): number | null {
  return compareValue(cell, readFilterValue(value))
}

// 大小の比べの結果（compareValue の負・0・正）が当たるか
const ORDER_TESTS: Record<'gt' | 'ge' | 'lt' | 'le', (order: number) => boolean> = {
  gt: (order) => order > 0,
  ge: (order) => order >= 0,
  lt: (order) => order < 0,
  le: (order) => order <= 0,
}

// 条件の値を読むのは 1 度だけにして、セルを判定する関数を返す。知らない条件は無視する（どのセルも当たる）
export function compileFilter(filter: TableFilter): (cell: string | undefined) => boolean {
  const op = filter.op
  switch (op) {
    case 'empty':
      return (cell) => (cell ?? '').trim() === ''
    case 'notEmpty':
      return (cell) => (cell ?? '').trim() !== ''
    case 'contains':
    case 'notContains': {
      const needle = normalize(filter.value)
      const want = op === 'contains'
      return (cell) => normalize(cell ?? '').includes(needle) === want
    }
    case 'equals':
    case 'notEquals': {
      const value = readFilterValue(filter.value)
      const text = normalize(filter.value)
      const want = op === 'equals'
      return (cell) => {
        const order = compareValue(cell ?? '', value)
        return (order === null ? normalize(cell ?? '') === text : order === 0) === want
      }
    }
    case 'gt':
    case 'ge':
    case 'lt':
    case 'le': {
      const value = readFilterValue(filter.value)
      const test = ORDER_TESTS[op]
      return (cell) => {
        const order = compareValue(cell ?? '', value)
        return order !== null && test(order)
      }
    }
    default:
      return () => true
  }
}

export function matchesFilter(cell: string | undefined, filter: TableFilter): boolean {
  return compileFilter(filter)(cell)
}

// 大小を比べる条件の値が、その種類の列で比べられるか（入力欄で確かめる）。数の列は数、日付の列は日付か年だけ
export function isComparableValue(value: string, kind: TableColumnKind): boolean {
  const read = readFilterValue(value)
  if (kind === 'number') return read.number !== null
  if (kind === 'date') return read.date !== null
  return true
}

const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' })

// 見せる行：見出し（あれば）のあとに、絞り込んで並べ替えたデータの行。何もしなければ rows をそのまま返す
export function applyTableView(rows: string[][], view: { header: boolean; sort?: TableSort | null; filters?: readonly TableFilter[] }): string[][] {
  const filters = (view.filters ?? []).filter((f) => !filterNeedsValue(f.op) || f.value.trim() !== '')
  const sort = view.sort ?? null
  if (filters.length === 0 && !sort) return rows
  const start = view.header && rows.length > 0 ? 1 : 0
  let body = rows.slice(start)
  if (filters.length > 0) {
    const tests = filters.map((f) => ({ col: f.col, test: compileFilter(f) }))
    body = body.filter((row) => tests.every((t) => t.test(row[t.col])))
  }
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
