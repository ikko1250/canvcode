import { describe, expect, it } from 'vitest'
import { activeTableFilters, applyTableView, columnKind, compareCell, groupThousands, isMissingValue, isNumericColumn, matchesFilter, parseTableDate, withoutTableFilters, withTableFilter, withThousandsSeparators, type TableFilter } from './tableView.ts'

const ROWS = [
  ['店舗', '売上', '備考'],
  ['渋谷', '1,200', 'A'],
  ['新宿', '300', ''],
  ['池袋', '', 'b'],
  ['ｓｈｉｂｕｙａ2', '1000', 'B'],
  ['渋谷10', '20', ''],
]

describe('matchesFilter', () => {
  it('matches text ignoring case and full-width forms', () => {
    expect(matchesFilter('ｓｈｉｂｕｙａ2', { col: 0, op: 'contains', value: 'SHIBUYA' })).toBe(true)
    expect(matchesFilter('渋谷', { col: 0, op: 'notContains', value: '谷' })).toBe(false)
    expect(matchesFilter(' ', { col: 0, op: 'empty', value: '' })).toBe(true)
    expect(matchesFilter(undefined, { col: 0, op: 'notEmpty', value: '' })).toBe(false)
  })

  it('compares numbers as numbers, and leaves out cells that are not numbers', () => {
    expect(matchesFilter('1,200', { col: 1, op: 'equals', value: '1200' })).toBe(true)
    expect(matchesFilter('1,200', { col: 1, op: 'gt', value: '1000' })).toBe(true)
    expect(matchesFilter('1000', { col: 1, op: 'ge', value: '1,000' })).toBe(true)
    expect(matchesFilter('300', { col: 1, op: 'lt', value: '300' })).toBe(false)
    expect(matchesFilter('', { col: 1, op: 'le', value: '300' })).toBe(false)
    expect(matchesFilter('abc', { col: 1, op: 'notEquals', value: 'ABC' })).toBe(false)
  })
})

describe('applyTableView', () => {
  it('returns the rows as they are without sort or filters', () => {
    expect(applyTableView(ROWS, { header: true })).toBe(ROWS)
    // 値の入っていない条件は使わない
    expect(applyTableView(ROWS, { header: true, filters: [{ col: 0, op: 'contains', value: ' ' }] })).toBe(ROWS)
  })

  it('keeps the header first and ANDs the filters', () => {
    const shown = applyTableView(ROWS, {
      header: true,
      filters: [
        { col: 1, op: 'ge', value: '300' },
        { col: 2, op: 'notEmpty', value: '' },
      ],
    })
    expect(shown.map((r) => r[0])).toEqual(['店舗', '渋谷', 'ｓｈｉｂｕｙａ2'])
  })

  it('sorts a number column numerically with empty cells last in both directions', () => {
    const asc = applyTableView(ROWS, { header: true, sort: { col: 1, dir: 'asc' } })
    expect(asc.map((r) => r[1])).toEqual(['売上', '20', '300', '1000', '1,200', ''])
    const desc = applyTableView(ROWS, { header: true, sort: { col: 1, dir: 'desc' } })
    expect(desc.map((r) => r[1])).toEqual(['売上', '1,200', '1000', '300', '20', ''])
  })

  it('sorts text with numbers in natural order and keeps ties in their original order', () => {
    const rows = [['a2', '1'], ['a10', '2'], ['a2', '3'], ['b', '4']]
    expect(applyTableView(rows, { header: false, sort: { col: 0, dir: 'asc' } }).map((r) => r[1])).toEqual(['1', '3', '2', '4'])
    expect(applyTableView(rows, { header: false, sort: { col: 0, dir: 'desc' } }).map((r) => r[1])).toEqual(['4', '2', '1', '3'])
  })
})

describe('isNumericColumn', () => {
  it('ignores the header and empty cells', () => {
    expect(isNumericColumn(ROWS, 1, 1)).toBe(true)
    expect(isNumericColumn(ROWS, 0, 1)).toBe(false)
    expect(isNumericColumn([['h'], ['']], 0, 1)).toBe(false)
  })
})

describe('thousands separators', () => {
  it('groups the integer part only', () => {
    expect(groupThousands('1234567')).toBe('1,234,567')
    expect(groupThousands('-12345.6789')).toBe('-12,345.6789')
    expect(groupThousands('¥1000')).toBe('¥1,000')
    expect(groupThousands('2500円')).toBe('2,500円')
    expect(groupThousands('12345%')).toBe('12,345%')
    expect(groupThousands('999')).toBe('999')
    expect(groupThousands('1,234')).toBe('1,234')
    expect(groupThousands('0.12345')).toBe('0.12345')
    expect(groupThousands('1e10')).toBe('1e10')
  })

  it('changes number columns but not the header or text columns', () => {
    const rows = [['店舗', '売上', 'コード'], ['渋谷', '1200', 'A1000'], ['新宿', '', 'B2000']]
    expect(withThousandsSeparators(rows, true)).toEqual([['店舗', '売上', 'コード'], ['渋谷', '1,200', 'A1000'], ['新宿', '', 'B2000']])
    expect(withThousandsSeparators([['a', 'b']], false)).toEqual([['a', 'b']])
  })
})

// ---- 日付の列・欠損の印（MAI-94） ----

const column = (cells: string[]) => [['見出し'], ...cells.map((cell) => [cell])]

describe('isMissingValue', () => {
  it('knows the missing marks ignoring case, full-width forms and spaces, but not empty cells', () => {
    for (const mark of ['N/A', 'n/a', 'NA', '#N/A', '(NA)', 'NaN', 'null', 'NULL', '-', '—', 'ー', '…', ' Ｎ／Ａ ', '－']) expect(isMissingValue(mark), mark).toBe(true)
    // 表計算・Bloomberg の印と、点・横棒・負の記号だけのセル
    for (const mark of ['.', '--', 'n.a.', 'N.A.', '#VALUE!', '#value!', '#DIV/0!', '#N/A N/A', '#n/a n/a', '＃Ｎ／Ａ　Ｎ／Ａ', '―', '−', '．', '－－']) expect(isMissingValue(mark), mark).toBe(true)
    for (const text of ['', ' ', '0', 'nab', 'N/A 注', '---', 'none', '#N/A N/A 注', '#VALUE!!']) expect(isMissingValue(text), text).toBe(false)
  })

  it('does not take negative numbers or decimals for missing marks', () => {
    for (const text of ['-5', '−5', '-0.5', '.5', '-.5', '5.']) expect(isMissingValue(text), text).toBe(false)
    expect(columnKind(column(['-5', '−5', '.5', '−', '.', '--', '#DIV/0!']), 0, 1)).toBe('number')
  })
})

describe('parseTableDate', () => {
  it('reads dates with their precision', () => {
    expect(parseTableDate('2026-11-06')).toEqual([2026, 11, 6])
    expect(parseTableDate('2026/1/5')).toEqual([2026, 1, 5])
    expect(parseTableDate('2026.1.5')).toEqual([2026, 1, 5])
    expect(parseTableDate('2026-11')).toEqual([2026, 11])
    expect(parseTableDate('2010/1')).toEqual([2010, 1])
    expect(parseTableDate('2026年11月')).toEqual([2026, 11])
    expect(parseTableDate('2026年11月6日')).toEqual([2026, 11, 6])
    expect(parseTableDate('２０２６－１１－０６')).toEqual([2026, 11, 6])
    expect(parseTableDate('2024-02-29')).toEqual([2024, 2, 29])
  })

  it('reads a time after the date', () => {
    expect(parseTableDate('2026-01-05 12:30')).toEqual([2026, 1, 5, 12, 30])
    expect(parseTableDate('2026-01-05T12:30:45')).toEqual([2026, 1, 5, 12, 30, 45])
    expect(parseTableDate('2026/1/5 9:05:07.5')).toEqual([2026, 1, 5, 9, 5, 7.5])
    expect(parseTableDate('2026-01-05T12:30:45Z')).toEqual([2026, 1, 5, 12, 30, 45])
    expect(parseTableDate('2026-01-05T12:30:45+09:00')).toEqual([2026, 1, 5, 12, 30, 45])
  })

  it('rejects impossible dates, a year alone and other text', () => {
    expect(parseTableDate('2026-13-01')).toBeNull()
    expect(parseTableDate('2026-02-30')).toBeNull()
    expect(parseTableDate('2025-02-29')).toBeNull()
    expect(parseTableDate('2026-00')).toBeNull()
    expect(parseTableDate('2026-01-05 24:00')).toBeNull()
    expect(parseTableDate('2026')).toBeNull()
    expect(parseTableDate('2026年')).toBeNull()
    expect(parseTableDate('1/5/2026')).toBeNull()
    expect(parseTableDate('N/A')).toBeNull()
    expect(parseTableDate('')).toBeNull()
  })
})

describe('columnKind', () => {
  it('finds number columns with missing marks in them', () => {
    expect(columnKind(column(['1,200', 'N/A', '(NA)', '-', '', '3.5']), 0, 1)).toBe('number')
  })

  it('looks past the first 2000 rows when they are missing marks', () => {
    const rows = column([...Array.from({ length: 2500 }, () => 'N/A'), '10', '20'])
    expect(columnKind(rows, 0, 1)).toBe('number')
    // limit は空でないセルの数（行の数でない）
    expect(columnKind(column(['1', 'N/A', 'N/A', 'abc']), 0, 1, 1)).toBe('number')
    expect(columnKind(column(['1', 'N/A', 'N/A', 'abc']), 0, 1, 2)).toBe('text')
  })

  it('finds date columns in each way of writing them', () => {
    expect(columnKind(column(['2000-01-04', '2000-01-05', 'N/A']), 0, 1)).toBe('date')
    expect(columnKind(column(['2026/1/5', '2026/12/31']), 0, 1)).toBe('date')
    expect(columnKind(column(['2026-11', '2010/1']), 0, 1)).toBe('date')
    expect(columnKind(column(['2026年11月', '2026年11月6日', '-']), 0, 1)).toBe('date')
    expect(columnKind(column(['2026-01-05 12:30', '2026-01-05T12:31:00']), 0, 1)).toBe('date')
  })

  it('treats a column of only missing marks or empty cells, and text, as text', () => {
    expect(columnKind(column(['N/A', '', '-', 'NaN']), 0, 1)).toBe('text')
    expect(columnKind(column([]), 0, 1)).toBe('text')
    expect(columnKind(column(['渋谷', '新宿']), 0, 1)).toBe('text')
    expect(columnKind(column(['2026-01-05', '新宿']), 0, 1)).toBe('text')
    expect(columnKind(column(['2026-13-01', '2026-01-05']), 0, 1)).toBe('text')
    // 年だけの列は数の列
    expect(columnKind(column(['2010', '2011']), 0, 1)).toBe('number')
  })
})

describe('matchesFilter: dates and missing marks', () => {
  const f = (op: TableFilter['op'], value: string): TableFilter => ({ col: 0, op, value })

  it('compares a year alone with the dates of that year', () => {
    expect(matchesFilter('2011-12-31', f('ge', '2012'))).toBe(false)
    expect(matchesFilter('2012-01-01', f('ge', '2012'))).toBe(true)
    expect(matchesFilter('2020-06-15', f('ge', '2020'))).toBe(true)
    expect(matchesFilter('2020-01-01', f('ge', '2020'))).toBe(true)
    expect(matchesFilter('2020-12-31', f('le', '2020'))).toBe(true)
    expect(matchesFilter('2021-01-01', f('le', '2020'))).toBe(false)
    expect(matchesFilter('2020-12-31', f('lt', '2020'))).toBe(false)
    expect(matchesFilter('2019-12-31 23:59', f('lt', '2020'))).toBe(true)
    expect(matchesFilter('2012-05-01', f('ge', '２０１２年'))).toBe(true)
  })

  it('compares up to the precision of the value', () => {
    expect(matchesFilter('2026-11-30', f('gt', '2026-11'))).toBe(false)
    expect(matchesFilter('2026-12-01', f('gt', '2026-11'))).toBe(true)
    expect(matchesFilter('2026-11-06', f('equals', '2026/11/06'))).toBe(true)
    expect(matchesFilter('2026-11-07', f('equals', '2026/11/06'))).toBe(false)
    expect(matchesFilter('2026/11/1', f('equals', '2026-11'))).toBe(true)
    expect(matchesFilter('2026-11-30 18:00', f('equals', '2026-11'))).toBe(true)
    expect(matchesFilter('2026-10-31', f('notEquals', '2026-11'))).toBe(true)
    expect(matchesFilter('2026-01-05 12:30', f('ge', '2026-01-05 12:00'))).toBe(true)
    expect(matchesFilter('2026年11月6日', f('ge', '2026-11-06'))).toBe(true)
    // 精度の低いセルは、欠けたところを初めの日とみなす
    expect(matchesFilter('2026-11', f('lt', '2026-11-06'))).toBe(true)
    expect(matchesFilter('2026-11', f('ge', '2026-11-01'))).toBe(true)
    expect(matchesFilter('2026-11', f('equals', '2026-11-01'))).toBe(true)
    expect(matchesFilter('2026-11', f('lt', '2026-11-01'))).toBe(false)
    expect(matchesFilter('2026年11月', f('equals', '2026/11/1'))).toBe(true)
    expect(matchesFilter('2026-11', f('gt', '2026-10-31'))).toBe(true)
    // 時刻のない日付は 0 時 0 分 0 秒
    expect(matchesFilter('2026-11-06', f('equals', '2026-11-06 00:00'))).toBe(true)
    expect(matchesFilter('2026-11-06', f('lt', '2026-11-06 00:01'))).toBe(true)
    expect(matchesFilter('2026-11-06 12:30', f('equals', '2026-11-06 12:30:00'))).toBe(true)
  })

  it('leaves empty cells and missing marks out of comparisons', () => {
    for (const cell of ['N/A', '(NA)', '-', 'NaN', '', undefined]) {
      for (const op of ['gt', 'ge', 'lt', 'le'] as const) {
        expect(matchesFilter(cell, f(op, '2012')), `${cell} ${op}`).toBe(false)
        expect(matchesFilter(cell, f(op, '0')), `${cell} ${op}`).toBe(false)
      }
    }
    expect(compareCell('N/A', '2012')).toBeNull()
    // 「空」は空のセルだけ（欠損の印は空でない）
    expect(matchesFilter('N/A', f('empty', ''))).toBe(false)
    expect(matchesFilter('N/A', f('notEmpty', ''))).toBe(true)
  })

  it('reads 12% as 12 and ¥1,000 as 1000', () => {
    expect(matchesFilter('12%', f('ge', '12'))).toBe(true)
    expect(matchesFilter('12%', f('gt', '12'))).toBe(false)
    expect(matchesFilter('¥1,000', f('equals', '1000'))).toBe(true)
    expect(matchesFilter('¥1,000', f('lt', '1,001'))).toBe(true)
    expect(compareCell('¥1,000', '999')).toBeGreaterThan(0)
  })

  it('does not compare dates with numbers that are not a year, or numbers with dates', () => {
    expect(compareCell('2026-11-06', '5')).toBeNull()
    expect(compareCell('1200', '2026-11')).toBeNull()
    expect(matchesFilter('2026-11-06', f('gt', '5'))).toBe(false)
    // 比べられない ＝ は文字で比べる
    expect(matchesFilter('2026-11-06（金）', f('equals', '2026-11-06（金）'))).toBe(true)
    expect(matchesFilter('2026-11-06（金）', f('equals', '2026-11-06'))).toBe(false)
    expect(matchesFilter('abc', f('equals', 'ABC'))).toBe(true)
  })

  it('ignores filters it does not know', () => {
    const unknown = { col: 0, op: 'startsWith', value: 'x' } as unknown as TableFilter
    expect(matchesFilter('abc', unknown)).toBe(true)
    expect(matchesFilter('', unknown)).toBe(true)
    expect(applyTableView([['h'], ['a'], ['b']], { header: true, filters: [unknown] })).toEqual([['h'], ['a'], ['b']])
  })
})

describe('applyTableView: a date column (MAI-94)', () => {
  it('keeps the header and the rows from 2012 on', () => {
    const rows = [
      ['Date', 'Close'],
      ['2011-12-30', '10'],
      ['2012-01-03', '11'],
      ['N/A', '12'],
      ['2013-06-01', 'N/A'],
      ['', '13'],
    ]
    const shown = applyTableView(rows, { header: true, filters: [{ col: 0, op: 'ge', value: '2012' }] })
    expect(shown.map((r) => r[0])).toEqual(['Date', '2012-01-03', '2013-06-01'])
    const both = applyTableView(rows, { header: true, filters: [{ col: 0, op: 'ge', value: '2012' }, { col: 1, op: 'ge', value: '0' }] })
    expect(both.map((r) => r[0])).toEqual(['Date', '2012-01-03'])
    // 見出しのない表では、1 行目も絞り込む
    expect(applyTableView(rows.slice(1), { header: false, filters: [{ col: 0, op: 'lt', value: '2012' }] })).toEqual([['2011-12-30', '10']])
  })
})

describe('malformed filters (MAI-94)', () => {
  // edit_canvas は props をそのまま入れるので、形の崩れた条件もカードに入りうる
  const malformed = [
    { col: 0, op: 'ge', value: 2012 },
    { col: 0, op: 'between' },
    { col: 0, op: 'toString', value: 'x' },
    { col: '1', op: 'contains', value: '渋' },
    { col: -1, op: 'notEmpty' },
    { col: 1.5, op: 'notEmpty' },
    { op: 'notEmpty' },
    null,
    'ge',
    3,
    { col: 1, op: 'empty' },
  ] as unknown as TableFilter[]

  it('keeps only well-formed filters, with the value as text', () => {
    expect(activeTableFilters(malformed)).toEqual([
      { col: 0, op: 'ge', value: '2012' },
      { col: 1, op: 'empty', value: '' },
    ])
    expect(activeTableFilters(undefined)).toEqual([])
    expect(activeTableFilters({ col: 0, op: 'empty' })).toEqual([])
    expect(activeTableFilters('ge')).toEqual([])
    // 値の要る条件で値が空なら使わない
    expect(activeTableFilters([{ col: 0, op: 'contains', value: ' ' }, { col: 0, op: 'contains' }])).toEqual([])
  })

  it('shows the right rows without throwing', () => {
    const rows = [['Date', '備考'], ['2011-12-30', ''], ['2012-01-03', 'a'], ['2013-06-01', '']]
    expect(applyTableView(rows, { header: true, filters: malformed }).map((r) => r[0])).toEqual(['Date', '2013-06-01'])
    expect(applyTableView(rows, { header: true, filters: { col: 0 } as unknown as TableFilter[] })).toBe(rows)
    expect(applyTableView(rows, { header: true, filters: [{ col: 0, op: 'between' }] as unknown as TableFilter[] })).toBe(rows)
  })

  it('drops malformed filters when a filter is added or removed', () => {
    expect(withTableFilter({ filters: malformed }, { col: 1, op: 'empty', value: '' }).filters).toEqual([
      { col: 0, op: 'ge', value: '2012' },
      { col: 1, op: 'empty', value: '' },
    ])
    expect(withoutTableFilters({ filters: malformed }, 0).filters).toEqual([{ col: 1, op: 'empty', value: '' }])
    expect(withTableFilter({ filters: 'x' as unknown as TableFilter[] }, { col: 0, op: 'ge', value: '1' }).filters).toEqual([{ col: 0, op: 'ge', value: '1' }])
  })
})
