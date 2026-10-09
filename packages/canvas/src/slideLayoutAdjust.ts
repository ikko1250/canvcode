import type { NodeRecord } from '@canvcode/core'
import { adjustOf, type SlideLayoutAdjust, type SlideLayoutSlots } from '@canvcode/nodes'
import { clampTableImageWidth, type CanvasSlideLayoutOptions } from '@canvcode/slides'

// slide-layout（スライド v2）の手で直した配置（props.adjust）の計算。DOM に依存しない純粋な関数だけを置く。
// 値はスライドの幾何の単位（16:9 の 1920 幅の px）。キャンバスの座標とは、横だけ scaleX（4:3 は 1440/1920）倍の違いがある

// 位置と大きさを比べるときの許し（小数の誤差で書き込まない）
const EPSILON = 1e-6

// 並べ直しの幾何（canvasSlideLayout）に渡す、手で直した配置
export function adjustLayoutOptions(adjust: SlideLayoutAdjust): Pick<CanvasSlideLayoutOptions, 'tableWidth' | 'tableOffset' | 'figureOffset'> {
  const { table, figure } = adjust
  return {
    ...(table?.w !== undefined ? { tableWidth: table.w } : {}),
    ...(table?.dx || table?.dy ? { tableOffset: { dx: table.dx ?? 0, dy: table.dy ?? 0 } } : {}),
    ...(figure?.dx || figure?.dy ? { figureOffset: { dx: figure.dx ?? 0, dy: figure.dy ?? 0 } } : {}),
  }
}

// adjust の一部を変えたもの。値が undefined の項目は消す（既定に戻す）。table の w は範囲に収める
export function patchAdjust(
  adjust: SlideLayoutAdjust,
  patch: { table?: { dx?: number; dy?: number; w?: number }; figure?: { dx?: number; dy?: number } },
): SlideLayoutAdjust {
  const merge = (current: object | undefined, next: Record<string, number | undefined> | undefined) => {
    if (!next) return current as Record<string, number | undefined> | undefined
    const out: Record<string, number | undefined> = { ...current }
    for (const [key, value] of Object.entries(next)) out[key] = value
    return out
  }
  const table = merge(adjust.table, patch.table)
  if (table?.w !== undefined) table.w = clampTableImageWidth(table.w)
  return adjustOf({ table, figure: merge(adjust.figure, patch.figure) })
}

// 表パネルか右図枠を手で動かした・表パネルの幅を変えたときの、新しい adjust。変えるものが無ければ null。
// - 大きさを変えずに動かした（その向きの大きさが同じ）なら、動かした量を dx / dy に足す
// - table-image の表パネルの幅を変えたら、その幅を w にする（左端を動かしたなら、その分 dx も足す）。ほかのレイアウトの表パネルは幅を変えられない
// - 高さを変えたもの（上端・下端のリサイズ）と、右図枠のリサイズは書かない（並べ直しで元の箱に戻る）
// changed は id の子のトランザクションの前と後（変わっていなければ undefined）。scaleX は横の倍率（4:3 は 1440/1920）
export function adjustWithMovedChildren(
  kind: unknown,
  slots: SlideLayoutSlots,
  adjust: SlideLayoutAdjust,
  changed: (id: string) => { before: NodeRecord; after: NodeRecord } | undefined,
  scaleX: number,
): SlideLayoutAdjust | null {
  let next = adjust
  const roles = [
    { id: slots.panel, key: 'table' as const, resizable: kind === 'table-image' },
    { id: kind === 'table-image' ? slots.figure : undefined, key: 'figure' as const, resizable: false },
  ]
  for (const role of roles) {
    const change = role.id ? changed(role.id) : undefined
    if (!change || change.after.parentId !== change.before.parentId) continue
    const before = change.before.props as Record<string, unknown>
    const after = change.after.props as Record<string, unknown>
    if (typeof before.w !== 'number' || typeof after.w !== 'number' || typeof before.h !== 'number' || typeof after.h !== 'number') continue
    const current: Record<string, number | undefined> = { ...next[role.key] }
    const dx = (change.after.x - change.before.x) / scaleX
    const dy = change.after.y - change.before.y
    const sameW = Math.abs(after.w - before.w) < EPSILON
    const sameH = Math.abs(after.h - before.h) < EPSILON
    const patch: Record<string, number> = {}
    if (sameW || role.resizable) {
      if (Math.abs(dx) > EPSILON) patch.dx = tidy((current.dx ?? 0) + dx)
      if (!sameW) patch.w = Math.round(after.w / scaleX)
    }
    if (sameH && Math.abs(dy) > EPSILON) patch.dy = tidy((current.dy ?? 0) + dy)
    if (Object.keys(patch).length === 0) continue
    next = patchAdjust(next, { [role.key]: patch })
  }
  return next === adjust ? null : next
}

// 1px に丸める（デザインパネルに出す値を整数にする。吸い付いた位置との差は 0.5px 未満）
function tidy(value: number): number {
  return Math.round(value)
}
