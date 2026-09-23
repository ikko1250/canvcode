// パイメニュー（MAI-39）の中身と状態。画面に依らない部分をここに置く（描画とキーの受け取りは PieMenu.tsx）。
// - メニューはキー 1 つに 1 つ。キーを押している間、ポインタの位置に出し、ポインタを向けた項目を選ぶ
// - キーを離すと消え、選んでいた項目を実行する。サブメニューなら、その階層を覚えておき、次に押したときに出す
// - 覚えた階層は、項目を実行する・別のパイメニューを開く・Esc を押すと最初の階層に戻る

export interface PieLeaf {
  label: string
  onSelect(): void
  // 今選ばれている状態（今のツールなど）
  active?: boolean
  disabled?: boolean
}

export interface PieSubmenu {
  label: string
  items: PieEntry[]
}

export type PieEntry = PieLeaf | PieSubmenu

export interface PieMenuDef {
  id: string
  // 開くキー（KeyboardEvent.key）
  key: string
  label: string
  items: PieEntry[]
}

export function isSubmenu(entry: PieEntry): entry is PieSubmenu {
  return 'items' in entry
}

// 中心からこの距離（CSS ピクセル）より内側では、どの項目も選ばない
export const PIE_DEAD_ZONE = 24

// 中心からの向き（dx, dy は画面の座標。y は下向き）にある項目の番号。
// 0 番を真上に置き、時計回りに並べる。中心の近くなら null
export function sliceAt(dx: number, dy: number, count: number, deadZone = PIE_DEAD_ZONE): number | null {
  if (count <= 0 || Math.hypot(dx, dy) < deadZone) return null
  const step = (Math.PI * 2) / count
  // 真上からの時計回りの角度（0〜2π）
  const angle = (Math.atan2(dy, dx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2)
  return Math.floor((angle + step / 2) / step) % count
}

// 項目 index の中心の位置（中心からの相対。sliceAt と同じ並び）
export function slicePosition(index: number, count: number, radius: number): { x: number; y: number } {
  const angle = (index / count) * Math.PI * 2 - Math.PI / 2
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

// 階層 path（各階層で選んだサブメニューの番号）の項目と、そこまでのサブメニューの名前。
// メニューの中身が変わって path がたどれなくなったら、たどれたところまでにする
export function resolveLevel(menu: PieMenuDef, path: readonly number[]): { items: PieEntry[]; path: number[]; trail: string[] } {
  let items = menu.items
  const resolved: number[] = []
  const trail: string[] = []
  for (const index of path) {
    const entry = items[index]
    if (!entry || !isSubmenu(entry)) break
    items = entry.items
    resolved.push(index)
    trail.push(entry.label)
  }
  return { items, path: resolved, trail }
}

export interface PieState {
  // 階層を覚えているメニュー（null なら、どれも最初の階層）
  menuId: string | null
  path: number[]
  // 出しているなら、その中心（画面の座標）
  open: { x: number; y: number } | null
  // ポインタを向けている項目
  highlight: number | null
}

export const PIE_IDLE: PieState = { menuId: null, path: [], open: null, highlight: null }

// キーを押した：覚えている階層で出す。別のメニューの階層を覚えていたら、忘れて最初の階層から出す
export function pressPie(state: PieState, menuId: string, at: { x: number; y: number }): PieState {
  if (state.open) return state
  const path = state.menuId === menuId ? state.path : []
  return { menuId, path, open: at, highlight: null }
}

// ポインタが動いた：向けている項目を選ぶ（選べない項目は選ばない）
export function movePie(state: PieState, menus: readonly PieMenuDef[], pointer: { x: number; y: number }): PieState {
  const menu = state.open && menus.find((m) => m.id === state.menuId)
  if (!state.open || !menu) return state
  const { items } = resolveLevel(menu, state.path)
  const index = sliceAt(pointer.x - state.open.x, pointer.y - state.open.y, items.length)
  const entry = index === null ? undefined : items[index]
  const highlight = entry && !(!isSubmenu(entry) && entry.disabled) ? index : null
  return highlight === state.highlight ? state : { ...state, highlight }
}

// キーを離した（または項目をクリックした）：選んでいる項目を実行するか、サブメニューに入る。
// keepOpen なら、サブメニューに入ったまま出し続ける（クリックのとき）。
// 実行する項目は返すだけで、呼ぶのは呼び出し側
export function commitPie(
  state: PieState,
  menus: readonly PieMenuDef[],
  options: { keepOpen?: boolean } = {},
): { state: PieState; run: PieLeaf | null } {
  const menu = state.open && menus.find((m) => m.id === state.menuId)
  if (!state.open || !menu) return { state, run: null }
  const { items, path } = resolveLevel(menu, state.path)
  const entry = state.highlight === null ? undefined : items[state.highlight]
  if (entry && isSubmenu(entry)) {
    const next = [...path, state.highlight!]
    return { state: { menuId: menu.id, path: next, open: options.keepOpen ? state.open : null, highlight: null }, run: null }
  }
  if (entry && !entry.disabled) return { state: PIE_IDLE, run: entry }
  // 何も選ばずに離した：今の階層を覚えたまま消す
  return { state: { menuId: menu.id, path, open: null, highlight: null }, run: null }
}

// Esc：消して、覚えている階層を忘れる
export function cancelPie(state: PieState): PieState {
  return state.menuId === null && !state.open ? state : PIE_IDLE
}

// ウィンドウからフォーカスが外れたときなど：何もせずに消す（階層は覚えたまま）
export function hidePie(state: PieState): PieState {
  return state.open ? { ...state, open: null, highlight: null } : state
}
