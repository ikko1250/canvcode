import { describe, expect, it } from 'vitest'
import { detectDelimiter, parseDelimited, splitDelimited } from './delimited.ts'

describe('detectDelimiter', () => {
  it('prefers tabs, then commas, then semicolons', () => {
    expect(detectDelimiter('a\tb,c')).toBe('\t')
    expect(detectDelimiter('a,b;c')).toBe(',')
    expect(detectDelimiter('a;b')).toBe(';')
    expect(detectDelimiter('a')).toBe(',')
  })
})

describe('splitDelimited', () => {
  it('reads quoted cells with delimiters, doubled quotes and newlines', () => {
    expect(splitDelimited('a,"b,c","say ""hi""","x\ny"\n1,2,3,4', ',')).toEqual([
      ['a', 'b,c', 'say "hi"', 'x\ny'],
      ['1', '2', '3', '4'],
    ])
  })
})

describe('parseDelimited', () => {
  it('drops the BOM and the trailing empty line, and reads CRLF', () => {
    expect(parseDelimited('﻿名前,値\r\nりんご,120\r\n')).toEqual([
      ['名前', '値'],
      ['りんご', '120'],
    ])
  })

  it('pads short rows to the widest row', () => {
    expect(parseDelimited('a,b,c\n1\n2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', ''],
      ['2', '3', ''],
    ])
  })

  it('uses the given delimiter (.tsv) and returns no rows for empty text', () => {
    expect(parseDelimited('a,b\tc', '\t')).toEqual([['a,b', 'c']])
    expect(parseDelimited('')).toEqual([])
    expect(parseDelimited('\n\n')).toEqual([])
  })
})
