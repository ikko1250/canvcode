import { indicesBetween } from '@canvcode/core'

// 重なり順の変更（最前面へ・前面へ・背面へ・最背面へ）。DOM に依存しない純粋な関数だけを置く。
// 入力は 1 つの親の子（奥から手前の順）と、動かすものの id。出力は index を書き換えるノードとその新しい index。
// 呼び出し側（Editor）が、親ごとに呼んで書き込む。

export type ReorderDirection = 'front' | 'forward' | 'backward' | 'back'

export interface Sibling {
  id: string
  index: string
}

// 新しい並び（奥から手前）。前面へ・背面へは、選んだものを隣の選んでいないもの 1 つ分だけ動かす。
// 選んだものが続いていれば、まとめて動く。選んだものどうしの順は変えない
export function reorderIds(order: string[], moving: ReadonlySet<string>, direction: ReorderDirection): string[] {
  const rest = order.filter((id) => !moving.has(id))
  const picked = order.filter((id) => moving.has(id))
  if (direction === 'front') return [...rest, ...picked]
  if (direction === 'back') return [...picked, ...rest]
  const out = [...order]
  if (direction === 'forward') {
    // 手前から見ていき、選んだものの手前が選んでいないものなら入れ替える（続いた選択は 1 つずつ順に越える）
    for (let i = out.length - 2; i >= 0; i--) {
      if (moving.has(out[i]) && !moving.has(out[i + 1])) [out[i], out[i + 1]] = [out[i + 1], out[i]]
    }
  } else {
    for (let i = 1; i < out.length; i++) {
      if (moving.has(out[i]) && !moving.has(out[i - 1])) [out[i], out[i - 1]] = [out[i - 1], out[i]]
    }
  }
  return out
}

// siblings（奥から手前の順）のうち moving を direction へ動かすとき、index を書き換えるものと新しい index。
// 動かないもの（すでに最前面にあるなど）は含めない。動かすものの続きごとに、両隣の選んでいないものの index の間に置く。
// 兄弟に同じ index があって間に置けなければ、兄弟すべてを振り直す
export function reorderSiblings(siblings: Sibling[], moving: ReadonlySet<string>, direction: ReorderDirection): Map<string, string> {
  const before = siblings.map((s) => s.id)
  const after = reorderIds(before, moving, direction)
  const changes = new Map<string, string>()
  if (after.every((id, i) => id === before[i])) return changes
  const indexOf = new Map(siblings.map((s) => [s.id, s.index]))
  const strictlyIncreasing = siblings.every((s, i) => i === 0 || siblings[i - 1].index < s.index)
  if (!strictlyIncreasing) {
    const indices = indicesBetween(null, null, after.length)
    for (const [i, id] of after.entries()) if (indices[i] !== indexOf.get(id)) changes.set(id, indices[i])
    return changes
  }
  let i = 0
  while (i < after.length) {
    if (!moving.has(after[i])) {
      i++
      continue
    }
    let end = i
    while (end < after.length && moving.has(after[end])) end++
    const run = after.slice(i, end)
    const lower = i > 0 ? indexOf.get(after[i - 1])! : null
    const upper = end < after.length ? indexOf.get(after[end])! : null
    // 今の index のままで両隣の間に収まっていれば、書き換えない
    const keys = [lower, ...run.map((id) => indexOf.get(id)!), upper]
    const fits = keys.every((key, k) => k === 0 || key === null || keys[k - 1] === null || keys[k - 1]! < key)
    if (!fits) {
      const indices = indicesBetween(lower, upper, run.length)
      for (const [k, id] of run.entries()) changes.set(id, indices[k])
    }
    i = end
  }
  return changes
}
