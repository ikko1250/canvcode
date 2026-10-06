import { describe, expect, it } from 'vitest'
import { analyzeMeasuredRows } from './slide-row-capacity.ts'
import { computeSlideGeometry, getLayoutProfile } from './slide-layout-spec.ts'

// 行の容量の規則：compact パネルに収まらなければ全高パネルで分類し直す（v1 の lint の full-panel fallback と同じ）

describe('analyzeMeasuredRows: full-panel fallback', () => {
  it('switches a compact table-image slide to the full-height panel when the rows do not fit', () => {
    // 3 行の table-image は compact（行高 162px、予算 576px）。どの行も 190px 要ると収まらないが、全高（行高 195px 以上）なら収まる
    const compact = computeSlideGeometry('table-image', 3)
    expect(compact.compact).toBe(true)
    const result = analyzeMeasuredRows('table-image', 3, () => [190, 190, 190])
    expect(result.fullPanel).toBe(true)
    expect(result.warnings.some((w) => w.includes('超過'))).toBe(false)
    expect(result.warnings[0]).toContain('全高パネル')
    expect(result.budgetPx).toBe(getLayoutProfile('table-image', 3, { forceFull: true }).budgetPx)
    const full = computeSlideGeometry('table-image', 3, { forceFull: true })
    expect(full.compact).toBe(false)
    expect(full.panelHeight).toBe(772)
    expect(full.grid.defaultRowPx).toBeGreaterThanOrEqual(195)
  })

  it('keeps the compact panel when the rows fit', () => {
    const result = analyzeMeasuredRows('table-image', 3, () => [100, 100, 100])
    expect(result.fullPanel).toBe(false)
    expect(result.classification).toBe('ok')
    expect(result.warnings).toEqual([])
  })

  it('still warns when even the full-height panel cannot hold the rows', () => {
    const result = analyzeMeasuredRows('table-image', 3, () => [600, 600, 600])
    expect(result.fullPanel).toBe(false)
    expect(result.warnings.join('\n')).toContain('超過')
  })
})
