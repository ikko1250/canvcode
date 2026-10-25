import { describe, expect, it } from 'vitest'
import { defaultPlotSpec, findPlotColumn, normalizePlotSpec, plotTable, plotUsesX, PLOT_DEFAULT_WIDTH } from './plot.ts'

// CSV から作るグラフの作り方（plot.ts）

const CSV = '月,東京,大阪,メモ\n1月,"1,200",800,寒い\n2月,1500,950,\n3月,,1000,暖かい\n'

describe('plotTable', () => {
  it('names the columns from the header and tells number columns apart', () => {
    const table = plotTable(CSV, 'sales.csv', true)
    expect(table.columns).toEqual([
      { index: 0, name: '月', numeric: false },
      { index: 1, name: '東京', numeric: true },
      { index: 2, name: '大阪', numeric: true },
      { index: 3, name: 'メモ', numeric: false },
    ])
    expect(table.rows).toHaveLength(3)
    expect(table.rows[0]).toEqual(['1月', '1,200', '800', '寒い'])
  })

  it('names the columns 列 N without a header, and reads a .tsv by tabs', () => {
    const table = plotTable('a\t1\nb\t2\n', 'x.tsv', false)
    expect(table.columns.map((c) => c.name)).toEqual(['列 1', '列 2'])
    expect(table.columns[1]!.numeric).toBe(true)
    expect(table.rows).toEqual([
      ['a', '1'],
      ['b', '2'],
    ])
  })
})

describe('defaultPlotSpec', () => {
  it('uses the first text column for x and the other number columns for y', () => {
    const spec = defaultPlotSpec('file:a', plotTable(CSV, 'sales.csv', true), true, '標準')
    expect(spec).toMatchObject({ fileId: 'file:a', header: true, x: 0, y: [1, 2], kind: 'line', style: '標準', xlabel: null, legend: null, width: PLOT_DEFAULT_WIDTH })
  })

  it('uses row numbers when every column is a number', () => {
    const spec = defaultPlotSpec('file:a', plotTable('a,b\n1,2\n3,4\n', 'n.csv', true), true, '')
    expect(spec.x).toBeNull()
    expect(spec.y).toEqual([0, 1])
  })

  it('falls back to a text column for y when there is no number column (the drawing then says why it fails)', () => {
    const spec = defaultPlotSpec('file:a', plotTable('a,b\nx,y\n', 't.csv', true), true, '')
    expect(spec.x).toBe(0)
    expect(spec.y).toEqual([1])
  })
})

describe('normalizePlotSpec', () => {
  it('keeps a valid spec and fills defaults', () => {
    expect(normalizePlotSpec({ fileId: 'file:a', y: [1, 2], kind: 'bar', x: 0, style: '論文', width: 99999 })).toEqual({
      fileId: 'file:a',
      header: true,
      x: 0,
      y: [1, 2],
      kind: 'bar',
      style: '論文',
      title: '',
      xlabel: null,
      ylabel: null,
      legend: null,
      width: 4000,
      height: 800,
    })
  })

  it('rejects a spec without a file or value columns, and drops broken columns and kinds', () => {
    expect(normalizePlotSpec(null)).toBeNull()
    expect(normalizePlotSpec({ y: [1] })).toBeNull()
    expect(normalizePlotSpec({ fileId: 'file:a', y: [] })).toBeNull()
    expect(normalizePlotSpec({ fileId: 'file:a', y: [-1, 'x', 1.5] })).toBeNull()
    expect(normalizePlotSpec({ fileId: 'file:a', y: [2, -1], x: 'a', kind: 'radar', header: false, xlabel: '' })).toMatchObject({
      y: [2],
      x: null,
      kind: 'line',
      header: false,
      xlabel: '',
    })
  })
})

describe('findPlotColumn', () => {
  const columns = plotTable(CSV, 'sales.csv', true).columns
  it('finds a column by name (ignoring width, case and spaces), by index, or by 1-based number', () => {
    expect(findPlotColumn(columns, '大阪')).toBe(2)
    expect(findPlotColumn(columns, ' 東京 ')).toBe(1)
    expect(findPlotColumn(columns, 3)).toBe(3)
    expect(findPlotColumn(columns, '列 2')).toBe(1)
    expect(findPlotColumn(columns, '4')).toBe(3)
  })

  it('returns null for an unknown column', () => {
    expect(findPlotColumn(columns, '名古屋')).toBeNull()
    expect(findPlotColumn(columns, 4)).toBeNull()
    expect(findPlotColumn(columns, '5')).toBeNull()
  })
})

it('hist and box charts do not use the x column', () => {
  expect(plotUsesX('hist')).toBe(false)
  expect(plotUsesX('box')).toBe(false)
  expect(plotUsesX('pie')).toBe(true)
})
