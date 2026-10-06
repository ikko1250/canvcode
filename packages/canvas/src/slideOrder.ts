import type { Box } from '@canvcode/core'

// スライドの順番と番号を、キャンバス上の位置から決める。DOM に依存しない純粋な関数だけを置く。
// 順番は保存せず、描くたび（PDF に出すたび）に呼んで計算する。
// - 行ごとに読む。上から順に、まだ行に入っていないスライドのうちいちばん上のもの（y が同じなら x、さらに id の順）を
//   行の基準にし、基準と上下で半分以上重なるものを同じ行に入れる
// - 「半分以上重なる」：基準との縦の重なりの長さが、2 つの高さの小さい方の半分以上（ちょうど半分も含む）。
//   比べるのはいつも行の基準とだけで、行に入ったものどうしでは比べない。少しずつずれた配置でも、
//   ずれが連鎖して行が下へ伸び続けることはない
// - 行の中は x の順。x が同じなら y、さらに id の順にする
// - 非表示のスライドは行分けにも含めない（番号に関係しないものが、ほかのスライドの行分けを変えないように）。
//   番号は表示するものだけに 1 から振る（非表示の分は詰める）
// - 同じ位置などの同点はいつも id で決めるので、結果は入力の並びによらない

export interface SlideOrderInput {
  id: string
  // ワールド座標の箱
  box: Box
  hidden: boolean
}

export interface SlideOrder {
  // 表示するスライドの id を順に並べたもの
  order: string[]
  // id → 番号（1 から）。非表示のスライドは含めない
  numbers: Map<string, number>
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// 2 つの箱が上下で半分以上重なるか
function sameRow(base: Box, other: Box): boolean {
  const overlap = Math.min(base.y + base.h, other.y + other.h) - Math.max(base.y, other.y)
  return overlap > 0 && overlap >= Math.min(base.h, other.h) / 2
}

export function slideOrder(slides: readonly SlideOrderInput[]): SlideOrder {
  // 上から（y、x、id の順に）並べる。行の基準はこの順で選ぶ
  const rest = slides
    .filter((s) => !s.hidden)
    .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x || compareId(a.id, b.id))
  const order: string[] = []
  const used = new Set<string>()
  for (const base of rest) {
    if (used.has(base.id)) continue
    const row = rest.filter((s) => !used.has(s.id) && (s === base || sameRow(base.box, s.box)))
    row.sort((a, b) => a.box.x - b.box.x || a.box.y - b.box.y || compareId(a.id, b.id))
    for (const s of row) {
      used.add(s.id)
      order.push(s.id)
    }
  }
  const numbers = new Map(order.map((id, i) => [id, i + 1]))
  return { order, numbers }
}
