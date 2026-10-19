import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256HexSync } from './sha256.ts'

// crypto.subtle のないとき（http で開いたとき）の SHA-256

describe('sha256HexSync', () => {
  it('matches node:crypto for lengths around the block boundaries', () => {
    for (const length of [0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 1000, 100_000]) {
      const data = new Uint8Array(length).map((_, i) => (i * 31 + 7) & 0xff)
      expect(sha256HexSync(data), String(length)).toBe(createHash('sha256').update(data).digest('hex'))
    }
  })
})
