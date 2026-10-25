import { describe, expect, it } from 'vitest'
import { applyTableView, groupThousands, isNumericColumn, matchesFilter, withThousandsSeparators } from './tableView.ts'

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
