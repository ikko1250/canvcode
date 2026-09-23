import { describe, expect, it } from 'vitest'
import { buildScrollMap, previewToSource, sourceToPreview } from './scrollSync.ts'

describe('buildScrollMap', () => {
  it('基準点がなければ両端だけの表になる（同じ割合で動く）', () => {
    const map = buildScrollMap([], 1000, 500)
    expect(map).toEqual({ source: [0, 1000], preview: [0, 500] })
    expect(sourceToPreview(map, 500)).toBe(250)
    expect(previewToSource(map, 250)).toBe(500)
  })

  it('基準点を昇順に並べ、両端を足す', () => {
    const map = buildScrollMap(
      [
        { source: 600, preview: 300 },
        { source: 200, preview: 400 },
      ],
      1000,
      1000,
    )
    expect(map.source).toEqual([0, 200, 600, 1000])
    // 順序が崩れた点は前の点にそろえる（400 → 400）
    expect(map.preview).toEqual([0, 400, 400, 1000])
  })

  it('最大スクロール位置を超える基準点は捨てる', () => {
    const map = buildScrollMap(
      [
        { source: 100, preview: 50 },
        { source: 900, preview: 2000 },
        { source: 1500, preview: 100 },
      ],
      1000,
      1000,
    )
    expect(map).toEqual({ source: [0, 100, 1000], preview: [0, 50, 1000] })
  })

  it('同じ点の重なりや、数でない値は入れない', () => {
    const map = buildScrollMap(
      [
        { source: 100, preview: 50 },
        { source: 100, preview: 50 },
        { source: Number.NaN, preview: 70 },
      ],
      1000,
      1000,
    )
    expect(map).toEqual({ source: [0, 100, 1000], preview: [0, 50, 1000] })
  })

  it('最大が負なら 0 として扱う', () => {
    expect(buildScrollMap([], -10, -5)).toEqual({ source: [0, 0], preview: [0, 0] })
  })
})

describe('sourceToPreview / previewToSource', () => {
  const map = buildScrollMap(
    [
      { source: 100, preview: 400 },
      { source: 300, preview: 500 },
    ],
    1000,
    2000,
  )

  it('区間ごとに直線で補う', () => {
    expect(sourceToPreview(map, 50)).toBe(200)
    expect(sourceToPreview(map, 100)).toBe(400)
    expect(sourceToPreview(map, 200)).toBe(450)
    expect(sourceToPreview(map, 650)).toBe(1250)
  })

  it('逆向きも同じ表で引ける', () => {
    expect(previewToSource(map, 200)).toBe(50)
    expect(previewToSource(map, 450)).toBe(200)
    expect(previewToSource(map, 1250)).toBe(650)
  })

  it('両端の外は端の値に留める', () => {
    expect(sourceToPreview(map, -50)).toBe(0)
    expect(sourceToPreview(map, 5000)).toBe(2000)
    expect(previewToSource(map, -1)).toBe(0)
    expect(previewToSource(map, 9999)).toBe(1000)
  })

  it('幅のない区間（同じ位置に並んだ点）でも落ちない', () => {
    const flat = buildScrollMap(
      [
        { source: 100, preview: 200 },
        { source: 300, preview: 200 },
      ],
      1000,
      1000,
    )
    expect(sourceToPreview(flat, 200)).toBe(200)
    expect(previewToSource(flat, 200)).toBe(300)
  })
})
