import type { NodeRecord } from '@canvcode/core'
import { adjustOf, type SlideLayoutAdjust, type SlideLayoutSlots } from '@canvcode/nodes'
import {
  clampTableImageWidth,
  clampTablePanelHeight,
  isSlideLayout,
  layoutUsesRowGrid,
  tablePanelTop,
  type CanvasSlideLayoutOptions,
} from '@canvcode/slides'

// slide-layout（スライド v2）の手で直した配置（props.adjust）の計算。DOM に依存しない純粋な関数だけを置く。
// 値はスライドの幾何の単位（16:9 の 1920 幅の px）。キャンバスの座標とは、横だけ scaleX（4:3 は 1440/1920）倍の違いがある

// 位置と大きさを比べるときの許し（小数の誤差で書き込まない）
const EPSILON = 1e-6

// 並べ直しの幾何（canvasSlideLayout）に渡す、手で直した配置
export function adjustLayoutOptions(
  adjust: SlideLayoutAdjust,
): Pick<CanvasSlideLayoutOptions, 'tableWidth' | 'tableHeight' | 'tableOffset' | 'figureOffset' | 'titleOffset'> {
  const { table, figure, title } = adjust
  return {
    ...(table?.w !== undefined ? { tableWidth: table.w } : {}),
    ...(table?.h !== undefined ? { tableHeight: table.h } : {}),
    ...(table?.dx || table?.dy ? { tableOffset: { dx: table.dx ?? 0, dy: table.dy ?? 0 } } : {}),
    ...(figure?.dx || figure?.dy ? { figureOffset: { dx: figure.dx ?? 0, dy: figure.dy ?? 0 } } : {}),
    ...(title?.dx || title?.dy ? { titleOffset: { dx: title.dx ?? 0, dy: title.dy ?? 0 } } : {}),
  }
}

// adjust の一部を変えたもの。値が undefined の項目は消す（既定に戻す）。table の w は範囲に収める
// （table の h の範囲は行数で決まるので、ここでは収めない。tableHeightPatch と並べ直しの幾何が clampTablePanelHeight で収める）
export function patchAdjust(
  adjust: SlideLayoutAdjust,
  patch: {
    table?: { dx?: number; dy?: number; w?: number; h?: number }
    figure?: { dx?: number; dy?: number }
    title?: { dx?: number; dy?: number }
  },
): SlideLayoutAdjust {
  const merge = (current: object | undefined, next: Record<string, number | undefined> | undefined) => {
    if (!next) return current as Record<string, number | undefined> | undefined
    const out: Record<string, number | undefined> = { ...current }
    for (const [key, value] of Object.entries(next)) out[key] = value
    return out
  }
  const table = merge(adjust.table, patch.table)
  if (table?.w !== undefined) table.w = clampTableImageWidth(table.w)
  return adjustOf({ table, figure: merge(adjust.figure, patch.figure), title: merge(adjust.title, patch.title) })
}

// 表パネルの高さ（h）を決めるときの table の値（patchAdjust の table に渡す）。高さを決めた表パネルは全高のときの上端
// （tablePanelTop）+ dy に置くので、今のパネルの上端（panelY。スライドのローカル座標。無ければ dy は変えない）が動かないように dy も決め直す。
// 高さは行数（rowCount）で決まる範囲に収める。h が undefined なら高さを消す（行数と内容から決める。dy はそのまま）。行を持たないレイアウトなら null
export function tableHeightPatch(kind: unknown, rowCount: number, panelY: number | undefined, h: number | undefined): { h?: number; dy?: number } | null {
  if (!isSlideLayout(kind) || !layoutUsesRowGrid(kind)) return null
  if (h === undefined) return { h: undefined }
  const height = clampTablePanelHeight(kind, rowCount, h)!
  return panelY === undefined ? { h: height } : { h: height, dy: tidy(panelY - tablePanelTop(kind)) }
}

// 表パネルか右図枠を手で動かした・表パネルの大きさを変えたときの、新しい adjust。変えるものが無ければ null。
// - 大きさを変えずに動かした（その向きの大きさが同じ）なら、動かした量を dx / dy に足す
// - table-image の表パネルの幅を変えたら、その幅を w にする（左端を動かしたなら、その分 dx も足す）。ほかのレイアウトの表パネルは幅を変えられない
// - 表パネルの高さを変えたら（上端・下端のリサイズ）、その高さを h にし、動かした端と逆の端が動かないように dy を決め直す
//   （高さは行数で決まる範囲に収める。収めた分は、動かした端の方で縮む）
// - タイトルを動かしたら、動かした量を title の dx / dy に足す（タイトルは文字の箱で h を持たない。幅のリサイズは書かない。
//   表パネルと一緒に動かしたなら、表パネルの縦の量は付いて動く分なので引く）
// - 右図枠のリサイズは書かない（並べ直しで元の箱に戻る）
// changed は id の子のトランザクションの前と後（変わっていなければ undefined）。scaleX は横の倍率（4:3 は 1440/1920）
export function adjustWithMovedChildren(
  kind: unknown,
  slots: SlideLayoutSlots,
  adjust: SlideLayoutAdjust,
  changed: (id: string) => { before: NodeRecord; after: NodeRecord } | undefined,
  scaleX: number,
): SlideLayoutAdjust | null {
  let next = adjust
  // 表パネルを（大きさを変えずに）縦に動かした量
  let tableMovedDy = 0
  const roles = [
    { id: slots.panel, key: 'table' as const, resizable: kind === 'table-image', heightResizable: true },
    { id: kind === 'table-image' ? slots.figure : undefined, key: 'figure' as const, resizable: false, heightResizable: false },
    { id: isSlideLayout(kind) && layoutUsesRowGrid(kind) ? slots.title : undefined, key: 'title' as const, resizable: false, heightResizable: false },
  ]
  for (const role of roles) {
    const change = role.id ? changed(role.id) : undefined
    if (!change || change.after.parentId !== change.before.parentId) continue
    const before = change.before.props as Record<string, unknown>
    const after = change.after.props as Record<string, unknown>
    if (typeof before.w !== 'number' || typeof after.w !== 'number') continue
    // 文字の箱（タイトル）は h を持たない。h を持たない役は高さが変わらないものとして扱う
    const hasH = typeof before.h === 'number' && typeof after.h === 'number'
    if (!hasH && role.heightResizable) continue
    const current: Record<string, number | undefined> = { ...next[role.key] }
    const dx = (change.after.x - change.before.x) / scaleX
    const dy = change.after.y - change.before.y
    const sameW = Math.abs(after.w - before.w) < EPSILON
    const sameH = !hasH || Math.abs((after.h as number) - (before.h as number)) < EPSILON
    const patch: Record<string, number> = {}
    if (sameW || role.resizable) {
      if (Math.abs(dx) > EPSILON) patch.dx = tidy((current.dx ?? 0) + dx)
      if (!sameW) patch.w = Math.round(after.w / scaleX)
    }
    // タイトルは表パネルの縦のずらし量に付いて動くので、表パネルと一緒に動かした分は title に足さない
    const ownDy = role.key === 'title' ? dy - tableMovedDy : dy
    if (role.key === 'table' && sameH) tableMovedDy = dy
    if (sameH && Math.abs(ownDy) > EPSILON) patch.dy = tidy((current.dy ?? 0) + ownDy)
    if (!sameH && role.heightResizable) {
      // 上端を動かした（上端のリサイズ）なら下端を、そうでなければ上端を、今の位置に残す
      const bottom = change.after.y + (after.h as number)
      const height = tableHeightPatch(kind, slots.rows.length, undefined, after.h as number)?.h
      if (height !== undefined) Object.assign(patch, tableHeightPatch(kind, slots.rows.length, Math.abs(dy) > EPSILON ? bottom - height : change.after.y, height))
    }
    if (Object.keys(patch).length === 0) continue
    next = patchAdjust(next, { [role.key]: patch })
  }
  return next === adjust ? null : next
}

// 1px に丸める（デザインパネルに出す値を整数にする。吸い付いた位置との差は 0.5px 未満）
function tidy(value: number): number {
  return Math.round(value)
}
