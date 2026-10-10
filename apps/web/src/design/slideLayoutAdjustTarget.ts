import type { NodeRecord } from '@canvcode/core'
import { hasSlideLayoutRows, type Editor } from '@canvcode/canvas'

// デザインパネルの「配置」（SlideLayoutAdjustSection.tsx）を出すノードの、変える slide-layout。
// 行を持つ slide-layout（表紙は除く）が属するノード（スライド・slide-layout・その子）なら、その slide-layout。ロックしたものは除く
export function slideLayoutAdjustTarget(editor: Editor | undefined, node: NodeRecord): NodeRecord | null {
  const layout = editor?.slideLayoutFor(node.id)
  if (!layout || layout.locked) return null
  return hasSlideLayoutRows((layout.props as Record<string, unknown>).layout) ? layout : null
}
