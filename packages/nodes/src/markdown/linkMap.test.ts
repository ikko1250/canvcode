import { describe, expect, it } from 'vitest'
import { LINK_MAP_MAX_LINKS, LinkRectCollector, linkMapColor, linkMapIndex } from './linkMap.ts'

// 幅 w・高さ h の透明な画素に、矩形を色で塗る
function pixels(w: number, h: number, fills: Array<{ x: number; y: number; w: number; h: number; color: number[] }>): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4)
  for (const f of fills) {
    for (let y = f.y; y < f.y + f.h; y++) {
      for (let x = f.x; x < f.x + f.w; x++) data.set(f.color.length === 4 ? f.color : [...f.color, 255], (y * w + x) * 4)
    }
  }
  return data
}

describe('linkMapColor / linkMapIndex', () => {
  it('どのリンクの色も、元の番号に読み戻せる', () => {
    for (let i = 0; i < LINK_MAP_MAX_LINKS; i++) {
      const [r, g, b] = linkMapColor(i)
      expect(linkMapIndex(r, g, b, 255)).toBe(i)
      // 少しずれた色（色の変換の誤差）でも読める
      expect(linkMapIndex(r + 5, g - 5, b + 3, 255)).toBe(i)
    }
  })

  it('半透明の画素や、2 色が混ざった色は読まない', () => {
    const [r, g, b] = linkMapColor(7)
    expect(linkMapIndex(r, g, b, 128)).toBe(-1)
    const [r2, g2, b2] = linkMapColor(8)
    expect(linkMapIndex((r + r2) / 2, (g + g2) / 2, (b + b2) / 2, 255)).toBe(-1)
  })
})

describe('LinkRectCollector', () => {
  it('塗った矩形を、CSS ピクセルのリンクの位置にする（縁の 1 画素ずつ広げる）', () => {
    const collector = new LinkRectCollector(0.5, 0.5)
    collector.addStrip(pixels(100, 40, [{ x: 10, y: 20, w: 30, h: 12, color: linkMapColor(0) }]), 100, 40, 0)
    expect(collector.regions(['https://example.com/'], 200, 80)).toEqual([
      { href: 'https://example.com/', rects: [{ x: 18, y: 38, w: 64, h: 28 }] },
    ])
  })

  it('折り返したリンクは、行ごとの矩形になる（上下の行が接していても）', () => {
    const collector = new LinkRectCollector(1, 1)
    const color = linkMapColor(3)
    collector.addStrip(
      pixels(100, 30, [
        { x: 60, y: 0, w: 40, h: 10, color },
        { x: 0, y: 10, w: 25, h: 10, color },
      ]),
      100,
      30,
      0,
    )
    const [region] = collector.regions(['a', 'b', 'c', 'd'], 100, 30)
    expect(region.href).toBe('d')
    expect(region.rects).toEqual([
      { x: 59, y: 0, w: 41, h: 11 },
      { x: 0, y: 9, w: 26, h: 12 },
    ])
  })

  it('帯をまたぐ矩形は、1 つにつなぐ', () => {
    const collector = new LinkRectCollector(1, 1)
    const color = linkMapColor(1)
    collector.addStrip(pixels(50, 10, [{ x: 5, y: 6, w: 20, h: 4, color }]), 50, 10, 0)
    collector.addStrip(pixels(50, 10, [{ x: 5, y: 0, w: 20, h: 5, color }]), 50, 10, 10)
    expect(collector.regions(['a', 'b'], 50, 20)[0].rects).toEqual([{ x: 4, y: 5, w: 22, h: 11 }])
  })

  it('並んだ 2 つのリンクは分け、境目の 1 画素の混ざった色は読まない', () => {
    const collector = new LinkRectCollector(1, 1)
    const mixed = linkMapColor(2).map((v, i) => (v + linkMapColor(5)[i]) / 2)
    collector.addStrip(
      pixels(60, 10, [
        { x: 0, y: 0, w: 20, h: 10, color: linkMapColor(2) },
        { x: 20, y: 0, w: 1, h: 10, color: mixed },
        { x: 21, y: 0, w: 20, h: 10, color: linkMapColor(5) },
      ]),
      60,
      10,
      0,
    )
    const regions = collector.regions(['a', 'b', 'c', 'd', 'e', 'f'], 60, 10)
    expect(regions.map((r) => r.href)).toEqual(['c', 'f'])
  })
})
