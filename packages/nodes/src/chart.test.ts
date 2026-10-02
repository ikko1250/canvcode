import { describe, expect, it } from 'vitest'
import {
  CHART_COLORS,
  chartFractions,
  chartRowColor,
  chartRowsOf,
  chartType,
  formatPercent,
  parseChartNumber,
  parseChartTable,
  pieGeometry,
  type ChartProps,
} from './chart.ts'

// グラフ（MAI-88）

const props = (patch: Partial<ChartProps> = {}): ChartProps => ({ ...chartType.defaultProps(), ...patch })

const node = (patch: Partial<ChartProps> = {}) =>
  ({ id: 'node:c', typeName: 'node', type: 'chart', x: 0, y: 0, rotation: 0, opacity: 1, parentId: 'canvas:1', index: 'a1', locked: false, props: props(patch) }) as never

describe('chart rows', () => {
  it('reads rows, dropping broken ones and keeping only hex colors', () => {
    expect(chartRowsOf([{ label: 'a', value: 1 }, null, 'x', { label: 3, value: 'NaN' }, { label: 'c', value: 2, color: '#ABC' }, { label: 'd', value: 1, color: 'red' }])).toEqual([
      { label: 'a', value: 1 },
      { label: '3', value: 0 },
      { label: 'c', value: 2, color: '#aabbcc' },
      { label: 'd', value: 1 },
    ])
    expect(chartRowsOf(undefined)).toEqual([])
  })

  it('assigns template colors in row order unless a row has its own', () => {
    const rows = [{ label: 'a', value: 1 }, { label: 'b', value: 1, color: '#123456' }, { label: 'c', value: 1 }]
    expect(rows.map(chartRowColor)).toEqual([CHART_COLORS[0], '#123456', CHART_COLORS[2]])
    expect(chartRowColor({ label: '', value: 1 }, CHART_COLORS.length)).toBe(CHART_COLORS[0])
  })

  it('counts only positive values in the fractions', () => {
    expect(chartFractions([{ label: '', value: 3 }, { label: '', value: -5 }, { label: '', value: 0 }, { label: '', value: 1 }])).toEqual([0.75, 0, 0, 0.25])
    expect(chartFractions([{ label: '', value: 0 }, { label: '', value: -1 }])).toEqual([0, 0])
  })

  it('formats percents, with a decimal below 1 %', () => {
    expect(formatPercent(0.5)).toBe('50%')
    expect(formatPercent(0.333)).toBe('33%')
    expect(formatPercent(0.004)).toBe('0.4%')
    expect(formatPercent(0)).toBe('0%')
  })
})

describe('parseChartTable', () => {
  it('reads TSV from a spreadsheet, skipping the header row', () => {
    expect(parseChartTable('品目\t売上\nりんご\t120\nみかん\t80\n')).toEqual([
      { label: 'りんご', value: 120 },
      { label: 'みかん', value: 80 },
    ])
  })

  it('reads CSV with quotes, thousand separators, percents and colors', () => {
    expect(parseChartTable('"東京, 本社","1,200",#ff0000\r\n大阪,30%,blue\n\n福岡,¥15')).toEqual([
      { label: '東京, 本社', value: 1200, color: '#ff0000' },
      { label: '大阪', value: 30 },
      { label: '福岡', value: 15 },
    ])
  })

  it('keeps a first row whose value is a number', () => {
    expect(parseChartTable('a,1\nb,2')).toEqual([
      { label: 'a', value: 1 },
      { label: 'b', value: 2 },
    ])
  })

  it('reads semicolons, single columns and unreadable values', () => {
    expect(parseChartTable('a;1\nb;x')).toEqual([
      { label: 'a', value: 1 },
      { label: 'b', value: 0 },
    ])
    expect(parseChartTable('10\n20')).toEqual([
      { label: '', value: 10 },
      { label: '', value: 20 },
    ])
    expect(parseChartTable('  \n')).toBeNull()
  })

  it('parses numbers loosely', () => {
    expect(parseChartNumber(' １２３ ')).toBe(123)
    expect(parseChartNumber('-4.5')).toBe(-4.5)
    expect(parseChartNumber('12,345,678')).toBe(12345678)
    expect(parseChartNumber('abc')).toBeNull()
    expect(parseChartNumber('')).toBeNull()
  })
})

describe('pie geometry', () => {
  it('starts at 12 o’clock clockwise and skips non-positive rows', () => {
    const g = pieGeometry(props({ rows: [{ label: 'a', value: 1 }, { label: 'b', value: 0 }, { label: 'c', value: -2 }, { label: 'd', value: 3 }], showLabels: false, showPercent: false }))
    expect(g.slices.map((s) => s.index)).toEqual([0, 3])
    expect(g.slices[0].start).toBeCloseTo(-Math.PI / 2)
    expect(g.slices[0].end).toBeCloseTo(-Math.PI / 2 + Math.PI / 2)
    expect(g.slices[1].end).toBeCloseTo(Math.PI * 1.5)
    expect(g.labels).toEqual([])
    expect(g.center).toEqual({ x: 120, y: 120 })
    expect(g.radius).toBe(120)
  })

  it('rotates by the start angle', () => {
    const g = pieGeometry(props({ startAngle: 90 }))
    expect(g.slices[0].start).toBeCloseTo(0)
  })

  it('is empty when nothing is positive', () => {
    expect(pieGeometry(props({ rows: [] })).empty).toBe(true)
    expect(pieGeometry(props({ rows: [{ label: 'a', value: 0 }] })).empty).toBe(true)
  })

  it('puts labels inside big slices and outside small ones, shrinking the pie to fit them', () => {
    const g = pieGeometry(props({ rows: [{ label: '大きい', value: 97 }, { label: '小さい', value: 3 }] }))
    const [big, small] = g.labels
    expect(big.inside).toBe(true)
    expect(small.inside).toBe(false)
    expect(small.leader).toHaveLength(3)
    expect(g.radius).toBeLessThan(120)
    expect(g.radius).toBeGreaterThanOrEqual(120 * 0.6)
  })

  it('places a donut label in the middle of the ring', () => {
    const g = pieGeometry(props({ innerRadius: 0.5, rows: [{ label: 'a', value: 1 }], showLabels: false }))
    const label = g.labels[0]
    expect(label.inside).toBe(true)
    // 1 つの扇（円全体）は 12 時から始まり、ラベルは真ん中の角度（6 時）の輪の中
    const cy = label.box.y + label.box.h / 2
    expect(cy).toBeCloseTo(120 + 90, 0)
  })
})

describe('chart node type', () => {
  it('hits the pie but not the donut hole or the box corners', () => {
    expect(chartType.hitTest(node(), { x: 120, y: 120 }, 0, 1)).toBe(true)
    expect(chartType.hitTest(node(), { x: 5, y: 5 }, 0, 1)).toBe(false)
    const donut = node({ innerRadius: 0.5 })
    expect(chartType.hitTest(donut, { x: 120, y: 120 }, 0, 1)).toBe(false)
    expect(chartType.hitTest(donut, { x: 120, y: 20 }, 0, 1)).toBe(true)
  })

  it('binds arrows to the circle', () => {
    const outline = chartType.outline!(node())
    expect(outline[0]).toEqual({ x: 240, y: 120 })
    expect(outline.every((p) => Math.abs(Math.hypot(p.x - 120, p.y - 120) - 120) < 1e-9)).toBe(true)
  })

  it('lists the drawn colors of the rows', () => {
    expect(chartType.colors!(node({ rows: [{ label: 'a', value: 1, color: '#ffffff' }, { label: 'b', value: 1 }] }))).toEqual(['#ffffff', CHART_COLORS[1]])
  })

  it('has no outset when the labels fit', () => {
    expect(chartType.renderOutset!(node())).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
  })
})
