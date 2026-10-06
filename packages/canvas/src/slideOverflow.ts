import type { NodeRecord } from '@canvcode/core'
import { slotIds, slotsOf, textOverflow } from '@canvcode/nodes'
import { getMaxRowCount } from '@canvcode/slides'
import { presentRows } from './slideLayoutArrange.ts'
import { hasSlideLayoutRows } from './slideLayoutRows.ts'

// slide-layout（スライド v2）の中のあふれの計算。DOM に依存しない純粋な関数だけを置く。
// 文字は縮めずに折り返すので、折り返した文字がセルに収まらなければ、あふれとして知らせる（印を出すのは呼び出し側）。
// - 対象は slots に入っている子のうち geo（行の見出し・本文、credits、panel など）。測るのは描画と同じレイアウト（textOverflow）
// - 上限（getMaxRowCount）を超えて並べなかった行は、セルを測らずに、行の数（extraRows）だけを数える（並べ直しの overflowRows と同じ）

export interface SlideOverflow {
  // 文字があふれている子の id（slots の順）
  nodes: string[]
  // 上限を超えて並べられなかった行の数
  extraRows: number
}

// slide-layout の子（id → レコード）のうち、文字があふれている子と、並べられなかった行の数。
// ここにない id は、slots に入っていても無視する
export function slideLayoutOverflow(layout: NodeRecord, children: ReadonlyMap<string, NodeRecord>): SlideOverflow {
  const props = layout.props as Record<string, unknown>
  const slots = slotsOf(props.slots)
  // 行を持たないレイアウト（表紙）は、行を並べない（並べ直しと同じ）
  const rows = hasSlideLayoutRows(props.layout) ? presentRows(slots, (id) => children.has(id)) : []
  const max = hasSlideLayoutRows(props.layout) ? getMaxRowCount(props.layout) : 0
  const placed = rows.slice(0, max)
  const nodes = slotIds({ ...slots, rows: placed }).filter((id) => {
    const child = children.get(id)
    return child?.type === 'geo' && textOverflow(child)?.overflows === true
  })
  return { nodes, extraRows: rows.length - placed.length }
}
