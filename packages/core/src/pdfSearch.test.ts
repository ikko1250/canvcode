import { describe, expect, it } from 'vitest'
import { findMatches, normalizeForSearch, searchPages } from './pdfSearch.ts'

describe('normalizeForSearch', () => {
  it('folds width and case, drops spaces next to Japanese, and keeps where each unit came from', () => {
    const n = normalizeForSearch('ＤＸ \n銘 柄')
    expect(n.text).toBe('dx銘柄')
    expect(n.from).toEqual([0, 1, 4, 6])
    expect(n.to).toEqual([1, 2, 5, 7])
  })

  it('keeps one space between Latin words and digits, covering the whole run of spaces', () => {
    const n = normalizeForSearch('Data  \n Base 2026 年')
    expect(n.text).toBe('data base 2026年')
    expect([n.from[4], n.to[4]]).toEqual([4, 8])
    expect(normalizeForSearch('  page   12  ').text).toBe('page 12')
  })

  it('joins words broken at the end of a line with a hyphen', () => {
    expect(normalizeForSearch('manage-\nment').text).toBe('management')
    expect(normalizeForSearch('manage‐ \n ment').text).toBe('management')
    // 行の途中のハイフン、行末でも次が大文字や数字なら、ハイフンは残す（ハイフンのあとの改行は、英字・数字の間ではないので無視する）
    expect(normalizeForSearch('well-known').text).toBe('well-known')
    expect(normalizeForSearch('Covid-\n19').text).toBe('covid-19')
    expect(normalizeForSearch('end-\nThe').text).toBe('end-the')
    expect(normalizeForSearch('ソフト\u00adハイフン').text).toBe('ソフトハイフン')
  })
})

describe('findMatches', () => {
  it('finds matches across stray spaces and line breaks, in the original positions', () => {
    const text = 'デジタル トランス\nフォーメーションと DX'
    const [m] = findMatches(text, 'トランスフォーメーション')
    expect(text.slice(m.from, m.to)).toBe('トランス\nフォーメーション')
    expect(findMatches(text, 'ｄｘ')).toHaveLength(1)
  })

  it('does not match across a space between English words, but does across a line break with a hyphen', () => {
    expect(findMatches('the rapist', 'therapist')).toEqual([])
    expect(findMatches('database', 'data base')).toEqual([])
    expect(findMatches('data  base', 'Data base')).toHaveLength(1)
    const text = 'risk manage-\nment'
    const [m] = findMatches(text, 'management')
    expect(text.slice(m.from, m.to)).toBe('manage-\nment')
  })

  it('does not count overlapping matches, and finds nothing for an empty query', () => {
    expect(findMatches('aaaa', 'aa')).toHaveLength(2)
    expect(findMatches('abc', '  ')).toEqual([])
  })
})

describe('searchPages', () => {
  it('returns only the pages with matches, with counts and snippets', () => {
    const pages = ['DX 銘柄の選定', '', 'DX と IT。dx の推進']
    expect(searchPages(pages, 'dx')).toEqual([
      { pageIndex: 0, count: 1, snippets: ['【DX】 銘柄の選定'] },
      { pageIndex: 2, count: 2, snippets: ['【DX】 と IT。dx の推進', 'DX と IT。【dx】 の推進'] },
    ])
  })

  it('takes snippets from the original text when given normalized pages', () => {
    const pages = ['Ａ社']
    expect(searchPages(pages.map(normalizeForSearch), 'a社', pages)).toEqual([{ pageIndex: 0, count: 1, snippets: ['【Ａ社】'] }])
  })
})
