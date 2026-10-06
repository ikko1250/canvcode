import { describe, expect, it } from 'vitest'
import { indicesBetween } from '@canvcode/core'
import { reorderIds, reorderSiblings, type ReorderDirection, type Sibling } from './reorder.ts'

// 重なり順の変更（最前面へ・前面へ・背面へ・最背面へ）

const ORDER = ['a', 'b', 'c', 'd', 'e']

describe('reorderIds', () => {
  it.each<[ReorderDirection, string[], string[]]>([
    ['front', ['b'], ['a', 'c', 'd', 'e', 'b']],
    ['back', ['d'], ['d', 'a', 'b', 'c', 'e']],
    ['forward', ['b'], ['a', 'c', 'b', 'd', 'e']],
    ['backward', ['d'], ['a', 'b', 'd', 'c', 'e']],
    // 続いた選択はまとめて 1 つ越える
    ['forward', ['b', 'c'], ['a', 'd', 'b', 'c', 'e']],
    ['backward', ['c', 'd'], ['a', 'c', 'd', 'b', 'e']],
    // 離れた選択はそれぞれ 1 つ越える。端にあるものは動かない
    ['forward', ['a', 'c', 'e'], ['b', 'a', 'd', 'c', 'e']],
    ['backward', ['a', 'c', 'e'], ['a', 'c', 'b', 'e', 'd']],
    // 選んだものどうしの順は保つ
    ['front', ['d', 'a'], ['b', 'c', 'e', 'a', 'd']],
  ])('%s %j', (direction, moving, expected) => {
    expect(reorderIds(ORDER, new Set(moving), direction)).toEqual(expected)
  })
})

function siblingsOf(ids: string[]): Sibling[] {
  const indices = indicesBetween(null, null, ids.length)
  return ids.map((id, i) => ({ id, index: indices[i] }))
}

function apply(siblings: Sibling[], changes: Map<string, string>): string[] {
  return siblings
    .map((s) => ({ id: s.id, index: changes.get(s.id) ?? s.index }))
    .sort((x, y) => (x.index < y.index ? -1 : x.index > y.index ? 1 : 0))
    .map((s) => s.id)
}

describe('reorderSiblings', () => {
  it('rewrites only the moved nodes and yields the new order', () => {
    const siblings = siblingsOf(ORDER)
    for (const direction of ['front', 'forward', 'backward', 'back'] as const) {
      for (const moving of [['b'], ['b', 'c'], ['a', 'e'], ['a', 'c', 'e']]) {
        const set = new Set(moving)
        const changes = reorderSiblings(siblings, set, direction)
        for (const id of changes.keys()) expect(set.has(id)).toBe(true)
        expect(apply(siblings, changes)).toEqual(reorderIds(ORDER, set, direction))
      }
    }
  })

  it('returns nothing when the order does not change', () => {
    const siblings = siblingsOf(ORDER)
    expect(reorderSiblings(siblings, new Set(['e']), 'front').size).toBe(0)
    expect(reorderSiblings(siblings, new Set(['d', 'e']), 'forward').size).toBe(0)
    expect(reorderSiblings(siblings, new Set(['a']), 'backward').size).toBe(0)
  })

  it('reindexes all siblings when some share an index', () => {
    const siblings: Sibling[] = [
      { id: 'a', index: 'a0' },
      { id: 'b', index: 'a1' },
      { id: 'c', index: 'a1' },
      { id: 'd', index: 'a2' },
    ]
    const changes = reorderSiblings(siblings, new Set(['d']), 'backward')
    expect(apply(siblings, changes)).toEqual(['a', 'b', 'd', 'c'])
  })
})
