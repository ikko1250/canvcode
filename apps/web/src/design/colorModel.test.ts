import { describe, expect, it } from 'vitest'
import { eyeDropperColor, hexToHsv, hsvToHex, syncHsv } from './colorModel.ts'

// カラーピッカーの色の計算（MAI-81）

describe('color model', () => {
  it('converts between hex and HSV', () => {
    expect(hexToHsv('#ff0000')).toEqual({ h: 0, s: 1, v: 1 })
    expect(hexToHsv('#00ff00')).toEqual({ h: 120, s: 1, v: 1 })
    expect(hexToHsv('#808080')?.s).toBe(0)
    expect(hexToHsv('red')).toBeNull()
    for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#3b5bdb', '#e8eefc', '#000000', '#ffffff', '#123456']) {
      expect(hsvToHex(hexToHsv(hex)!)).toBe(hex)
    }
    expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe('#ff0000')
  })

  it('keeps the hue when the color has none (gray, black)', () => {
    const current = { h: 200, s: 0.5, v: 0.5 }
    expect(syncHsv(current, hsvToHex(current))).toBe(current)
    expect(syncHsv(current, '#808080')).toEqual({ h: 200, s: 0, v: hexToHsv('#808080')!.v })
    expect(syncHsv(current, '#000000')).toEqual({ h: 200, s: 0.5, v: 0 })
    expect(syncHsv(current, '#ff0000')).toEqual({ h: 0, s: 1, v: 1 })
    expect(syncHsv(null, 'oops')).toBeNull()
  })

  it('reads the eyedropper result', () => {
    expect(eyeDropperColor('#AABBCC')).toBe('#aabbcc')
    expect(eyeDropperColor('rgb(255, 0, 16)')).toBe('#ff0010')
    expect(eyeDropperColor('nope')).toBeNull()
  })
})
