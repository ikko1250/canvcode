import { describe, expect, it } from 'vitest'
import { decodeTableFile } from './table.ts'

describe('decodeTableFile', () => {
  it('reads UTF-8 and drops the BOM', () => {
    const bytes = new TextEncoder().encode('﻿名前,値\n')
    expect(decodeTableFile(bytes)).toBe('名前,値\n')
  })

  it('reads Shift_JIS when the bytes are not UTF-8', () => {
    // 「名前,値」の Shift_JIS
    const bytes = new Uint8Array([0x96, 0xbc, 0x91, 0x4f, 0x2c, 0x92, 0x6c])
    expect(decodeTableFile(bytes)).toBe('名前,値')
  })
})
