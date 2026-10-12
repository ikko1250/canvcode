import type { NodeRecord } from '@canvcode/core'
import { arrowAngle, arrowLength, arrowWithDirection, type ArrowPivot, type ArrowProps } from '@canvcode/nodes'
import type { Editor } from './editor.ts'

// 矢印の向き（角度）と長さを、数字で変える（デザインパネル）。
// 角度・長さの決め方は @canvcode/nodes の arrowAngle・arrowLength（0° が右、時計回り、0〜360°）。
// 動かさない点：
// - どちらの端もつながっていなければ、真ん中（ノードの回転が中心のまわりなのと同じ。グラデーションの角度も真ん中を保つ）
// - 一方の端がノードにつながっていれば、その端（動かすと、つながりが元の位置に戻してしまうので）
// - 両端ともつながっていれば、向きも長さもつながった先で決まるので、変えない（null）

export type ArrowDirectionChange = { angle: number } | { length: number }

export function arrowPivot(editor: Editor, arrowId: string): ArrowPivot | null {
  const bound = new Set(editor.bindingsOfArrow(arrowId).map((binding) => binding.props.terminal))
  if (bound.has('start') && bound.has('end')) return null
  if (bound.has('start')) return 'start'
  if (bound.has('end')) return 'end'
  return 'middle'
}

// 選んでいる矢印に当てる変更（PropertyEdit・editNodes に渡す）。矢印でないノード・両端がつながった矢印はそのまま
export function arrowDirectionUpdate(editor: Editor, change: ArrowDirectionChange): (node: NodeRecord) => NodeRecord {
  return (node) => {
    if (node.type !== 'arrow') return node
    const pivot = arrowPivot(editor, node.id)
    if (!pivot) return node
    const arrow = node as NodeRecord<ArrowProps>
    const angle = 'angle' in change ? change.angle : arrowAngle(arrow.props)
    const length = 'length' in change ? Math.max(0, change.length) : arrowLength(arrow.props)
    const props = arrowWithDirection(arrow.props, angle, length, pivot)
    return props === arrow.props ? node : { ...arrow, props: { ...props, clip: [0, 1] } }
  }
}
