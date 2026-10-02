import { describe, expect, it } from 'vitest'
import { normalizeHexColor, parseNumber } from './parse.ts'

// デザインパネルの入力部品の、文字の読み取り（MAI-73）

describe('design controls', () => {
  it('parses numbers with or without a unit', () => {
    expect(parseNumber('12')).toBe(12)
    expect(parseNumber(' 1.5 ')).toBe(1.5)
    expect(parseNumber('-3')).toBe(-3)
    expect(parseNumber('24px')).toBe(24)
    expect(parseNumber('50%')).toBe(50)
    expect(parseNumber('')).toBeNull()
    expect(parseNumber('abc')).toBeNull()
  })

  it('normalizes hex colors', () => {
    expect(normalizeHexColor('#AABBCC')).toBe('#aabbcc')
    expect(normalizeHexColor('abc')).toBe('#aabbcc')
    expect(normalizeHexColor(' #f00 ')).toBe('#ff0000')
    expect(normalizeHexColor('red')).toBeNull()
    expect(normalizeHexColor('#abcd')).toBeNull()
  })
})
