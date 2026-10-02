import { normalizeColor } from '@canvcode/nodes'
import type { Editor } from './editor.ts'

// 「このキャンバスで使った色」（MAI-81：カラーピッカーの一覧）。
// 今の Canvas のノード（入れ子の中も含む）が使っている色を、ノードの型の colors（塗り・線・文字・文字の範囲ごとの色など）から集める。
// - 並びは使っている数の多い順。同じ数なら、重なり順で奥にあるノードの色から
// - 同じ色は 1 つにまとめる（#ABC と #aabbcc は同じ。16 進でない色はそのままの文字で比べる）
// - 多すぎると選びにくいので、limit 個まで

export const USED_COLORS_LIMIT = 16

export function usedColors(editor: Editor, limit = USED_COLORS_LIMIT): string[] {
  const counts = new Map<string, { count: number; order: number }>()
  let order = 0
  const visit = (ids: readonly string[]) => {
    for (const id of ids) {
      const node = editor.getNode(id)
      if (!node) continue
      for (const raw of editor.getType(node).colors?.(node) ?? []) {
        if (typeof raw !== 'string' || raw.trim() === '') continue
        const color = normalizeColor(raw)
        const entry = counts.get(color)
        if (entry) entry.count++
        else counts.set(color, { count: 1, order: order++ })
      }
      visit(editor.index.childrenOf(id))
    }
  }
  visit(editor.index.allIds())
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].order - b[1].order)
    .slice(0, limit)
    .map(([color]) => color)
}
