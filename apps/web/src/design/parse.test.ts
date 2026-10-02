import { describe, expect, it } from 'vitest'
import { normalizeHexColor, parseLineHeight, parseNumber } from './parse.ts'

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

  it('parses line heights as a multiplier, a percentage or pixels (MAI-76)', () => {
    expect(parseLineHeight('1.5', 'multiplier')).toEqual({ unit: 'multiplier', value: 1.5 })
    expect(parseLineHeight('150%', 'px')).toEqual({ unit: 'multiplier', value: 1.5 })
    expect(parseLineHeight('24px', 'multiplier')).toEqual({ unit: 'px', value: 24 })
    expect(parseLineHeight('24', 'px')).toEqual({ unit: 'px', value: 24 })
    // 範囲に収め、刻みに丸める
    expect(parseLineHeight('1.234', 'multiplier')).toEqual({ unit: 'multiplier', value: 1.23 })
    expect(parseLineHeight('0', 'multiplier')).toEqual({ unit: 'multiplier', value: 0.5 })
    expect(parseLineHeight('-4px', 'multiplier')).toEqual({ unit: 'px', value: 1 })
    expect(parseLineHeight('', 'multiplier')).toBeNull()
    expect(parseLineHeight('abc', 'px')).toBeNull()
  })
})
