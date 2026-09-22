import { describe, expect, it } from 'vitest'
import { indexBetween, indicesBetween, isValidIndex } from './fractionalIndex.ts'

describe('fractional index', () => {
  it('creates keys at the start, the end and in between', () => {
    const first = indexBetween(null, null)
    const after = indexBetween(first, null)
    const before = indexBetween(null, first)
    const middle = indexBetween(first, after)
    expect([before, first, middle, after]).toEqual([...[before, first, middle, after]].sort())
    for (const key of [before, first, middle, after]) expect(isValidIndex(key)).toBe(true)
  })

  it('keeps keys short when appending many times', () => {
    let key: string | null = null
    for (let i = 0; i < 10_000; i++) key = indexBetween(key, null)
    expect(key!.length).toBeLessThanOrEqual(4)
  })

  it('keeps order under random insertions', () => {
    const keys: string[] = []
    let seed = 42
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed / 2 ** 31
    }
    for (let i = 0; i < 2000; i++) {
      const at = Math.floor(random() * (keys.length + 1))
      const key = indexBetween(keys[at - 1] ?? null, keys[at] ?? null)
      keys.splice(at, 0, key)
    }
    expect(keys).toEqual([...keys].sort())
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.every(isValidIndex)).toBe(true)
  })

  it('creates many sorted keys between two keys', () => {
    const a = indexBetween(null, null)
    const b = indexBetween(a, null)
    const keys = indicesBetween(a, b, 500)
    expect(keys).toHaveLength(500)
    expect([a, ...keys, b]).toEqual([a, ...keys, b].sort())
    expect(new Set(keys).size).toBe(500)
    expect(Math.max(...keys.map((key) => key.length))).toBeLessThanOrEqual(6)
  })

  it('rejects keys in the wrong order', () => {
    expect(() => indexBetween('a1', 'a0')).toThrow()
  })
})
