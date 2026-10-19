import { describe, expect, it } from 'vitest'
import { findMatches, normalizeForSearch, searchPages } from './pdfSearch.ts'

describe('normalizeForSearch', () => {
  it('folds width and case, drops spaces, and keeps where each unit came from', () => {
    const n = normalizeForSearch('Ｄ Ｘ\n銘柄')
    expect(n.text).toBe('dx銘柄')
    expect(n.from).toEqual([0, 2, 4, 5])
    expect(n.to).toEqual([1, 3, 5, 6])
  })
})

describe('findMatches', () => {
  it('finds matches across stray spaces and line breaks, in the original positions', () => {
    const text = 'デジタル トランス\nフォーメーションと DX'
    const [m] = findMatches(text, 'トランスフォーメーション')
    expect(text.slice(m.from, m.to)).toBe('トランス\nフォーメーション')
    expect(findMatches(text, 'ｄｘ')).toHaveLength(1)
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
