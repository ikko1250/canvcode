import { describe, expect, it, vi } from 'vitest'
import type { ToolId } from '@canvcode/canvas'
import { buildPieMenus, TOOL_LABELS, type PieMenuContext } from './menus.ts'
import {
  PIE_IDLE,
  cancelPie,
  commitPie,
  hidePie,
  isSubmenu,
  movePie,
  pressPie,
  resolveLevel,
  sliceAt,
  slicePosition,
  type PieEntry,
  type PieMenuDef,
  type PieState,
} from './pieMenu.ts'

const leaf = (label: string, extra: { disabled?: boolean } = {}) => ({ label, onSelect: vi.fn(), ...extra })

function testMenus() {
  const a = {
    id: 'a',
    key: '-',
    label: 'A',
    items: [leaf('a0'), { label: 'sub', items: [leaf('s0'), { label: 'deep', items: [leaf('d0'), leaf('d1')] }] }, leaf('a2', { disabled: true }), leaf('a3')],
  }
  const b: PieMenuDef = { id: 'b', key: '.', label: 'B', items: [leaf('b0'), leaf('b1')] }
  return { a, b, menus: [a, b] as PieMenuDef[] }
}

// 中心 (100, 100) から、4 項目の輪の index 番の方向にポインタを動かす
const toward = (index: number, count = 4) => {
  const p = slicePosition(index, count, 60)
  return { x: 100 + p.x, y: 100 + p.y }
}
const AT = { x: 100, y: 100 }

describe('sliceAt', () => {
  it('puts slice 0 at the top and goes clockwise', () => {
    expect(sliceAt(0, -50, 4)).toBe(0)
    expect(sliceAt(50, 0, 4)).toBe(1)
    expect(sliceAt(0, 50, 4)).toBe(2)
    expect(sliceAt(-50, 0, 4)).toBe(3)
  })

  it('splits at the midpoints between slices', () => {
    // 8 項目なら 1 つ 45°。真上から時計回りに 22° は 0 番、23° は 1 番
    const at = (deg: number) => {
      const r = (deg * Math.PI) / 180
      return sliceAt(Math.sin(r) * 50, -Math.cos(r) * 50, 8)
    }
    expect(at(22)).toBe(0)
    expect(at(23)).toBe(1)
    expect(at(-22)).toBe(0)
    expect(at(-23)).toBe(7)
    expect(at(180)).toBe(4)
  })

  it('selects nothing inside the dead zone or with no items', () => {
    expect(sliceAt(3, 3, 4)).toBeNull()
    expect(sliceAt(0, -50, 0)).toBeNull()
  })

  it('agrees with slicePosition', () => {
    for (const count of [1, 2, 3, 5, 8, 11]) {
      for (let i = 0; i < count; i++) {
        const p = slicePosition(i, count, 80)
        expect(sliceAt(p.x, p.y, count)).toBe(i)
      }
    }
  })
})

describe('resolveLevel', () => {
  it('follows the path and falls back when it no longer resolves', () => {
    const { a } = testMenus()
    expect(resolveLevel(a, [1, 1]).items.map((e) => e.label)).toEqual(['d0', 'd1'])
    expect(resolveLevel(a, [1, 1]).trail).toEqual(['sub', 'deep'])
    // 1 → 0 は項目なので、そこでやめる
    expect(resolveLevel(a, [1, 0, 3]).path).toEqual([1])
    expect(resolveLevel(a, [9]).path).toEqual([])
  })
})

describe('pie state', () => {
  const press = (state: PieState, menuId: string) => pressPie(state, menuId, AT)

  it('runs the highlighted item on release and forgets the level', () => {
    const { a, menus } = testMenus()
    let state = press(PIE_IDLE, 'a')
    expect(state.open).toEqual(AT)
    state = movePie(state, menus, toward(3))
    expect(state.highlight).toBe(3)
    const { state: next, run } = commitPie(state, menus)
    expect(run).toBe(a.items[3])
    expect(next).toEqual(PIE_IDLE)
  })

  it('remembers the submenu level across presses (release → press shows the next level)', () => {
    const { menus } = testMenus()
    let state = movePie(press(PIE_IDLE, 'a'), menus, toward(1))
    let result = commitPie(state, menus)
    expect(result.run).toBeNull()
    expect(result.state.open).toBeNull()
    expect(result.state.path).toEqual([1])
    // 次に押すと、サブメニュー（2 項目）が出る
    state = press(result.state, 'a')
    expect(resolveLevel(menus[0], state.path).items.map((e) => e.label)).toEqual(['s0', 'deep'])
    // 2 項目の輪の 1 番（下）がさらにサブメニュー
    state = movePie(state, menus, { x: 100, y: 160 })
    result = commitPie(state, menus)
    expect(result.state.path).toEqual([1, 1])
    state = movePie(press(result.state, 'a'), menus, { x: 100, y: 40 })
    result = commitPie(state, menus)
    expect(result.run?.label).toBe('d0')
    expect(result.state).toEqual(PIE_IDLE)
  })

  it('keeps the level when released without choosing anything', () => {
    const { menus } = testMenus()
    const entered = commitPie(movePie(press(PIE_IDLE, 'a'), menus, toward(1)), menus).state
    const opened = press(entered, 'a')
    const released = commitPie(movePie(opened, menus, { x: 102, y: 101 }), menus)
    expect(released.run).toBeNull()
    expect(released.state.path).toEqual([1])
    expect(released.state.open).toBeNull()
  })

  it('opening another pie menu starts it (and the next one) from the top level', () => {
    const { menus } = testMenus()
    const entered = commitPie(movePie(press(PIE_IDLE, 'a'), menus, toward(1)), menus).state
    const other = press(entered, 'b')
    expect(other.menuId).toBe('b')
    expect(other.path).toEqual([])
    const closed = commitPie(other, menus).state
    expect(press(closed, 'a').path).toEqual([])
  })

  it('Esc forgets the level and hides the menu', () => {
    const { menus } = testMenus()
    const entered = commitPie(movePie(press(PIE_IDLE, 'a'), menus, toward(1)), menus).state
    expect(cancelPie(entered)).toEqual(PIE_IDLE)
    expect(cancelPie(press(entered, 'a'))).toEqual(PIE_IDLE)
    expect(press(cancelPie(entered), 'a').path).toEqual([])
  })

  it('hiding (window blur) keeps the level and runs nothing', () => {
    const { menus } = testMenus()
    const entered = commitPie(movePie(press(PIE_IDLE, 'a'), menus, toward(1)), menus).state
    const hidden = hidePie(movePie(press(entered, 'a'), menus, toward(0, 2)))
    expect(hidden.open).toBeNull()
    expect(hidden.path).toEqual([1])
  })

  it('ignores key repeat while open', () => {
    const { menus } = testMenus()
    const state = movePie(press(PIE_IDLE, 'a'), menus, toward(3))
    expect(pressPie(state, 'a', { x: 0, y: 0 })).toBe(state)
  })

  it('does not highlight or run disabled items', () => {
    const { menus } = testMenus()
    const state = movePie(press(PIE_IDLE, 'a'), menus, toward(2))
    expect(state.highlight).toBeNull()
    expect(commitPie(state, menus).run).toBeNull()
  })

  it('enters a submenu without closing when clicked (keepOpen)', () => {
    const { menus } = testMenus()
    const state = movePie(press(PIE_IDLE, 'a'), menus, toward(1))
    const { state: next } = commitPie(state, menus, { keepOpen: true })
    expect(next.open).toEqual(AT)
    expect(next.path).toEqual([1])
    expect(next.highlight).toBeNull()
  })

  it('does nothing when not open', () => {
    const { menus } = testMenus()
    expect(commitPie(PIE_IDLE, menus)).toEqual({ state: PIE_IDLE, run: null })
    expect(movePie(PIE_IDLE, menus, AT)).toBe(PIE_IDLE)
  })
})

describe('buildPieMenus', () => {
  const context = (toolId: ToolId = 'select'): PieMenuContext => ({
    toolId,
    setTool: vi.fn(),
    importPdf: vi.fn(),
    createFileCanvas: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    showStats: true,
    toggleStats: vi.fn(),
    benchRunning: false,
    cardBenchRunning: true,
    addBenchNodes: vi.fn(),
    clearNodes: vi.fn(),
    runBenchmark: vi.fn(),
    addMarkdownCards: vi.fn(),
    runCardBenchmark: vi.fn(),
    markdownCardCount: 20,
    // 操作のメニュー（MAI-57）は menus.test.ts で確かめる。ここでは出さない
    pdf: { hasPages: false, canNext: false, canPrev: false, allLocked: true, noneLocked: true },
    selection: { count: 0, arrangeCount: 0, hasText: false },
    panToPage: vi.fn(),
    unlockAndSelectPdfPages: vi.fn(),
    lockPdfPages: vi.fn(),
    stepFontSize: vi.fn(),
    setTextAlign: vi.fn(),
    alignSelection: vi.fn(),
    distributeSelection: vi.fn(),
    lockSelection: vi.fn(),
    duplicateSelection: vi.fn(),
  })
  const flatten = (items: PieEntry[]): PieEntry[] => items.flatMap((e) => (isSubmenu(e) ? flatten(e.items) : [e]))

  it('opens the tools menu with "-" and the others with ".", and has no actions menu when nothing applies', () => {
    const menus = buildPieMenus(context())
    expect(menus.map((m) => m.key)).toEqual(['-', '.'])
  })

  it('has every tool once in the tools menu, and no ring with more than 8 items', () => {
    const ctx = context()
    const menus = buildPieMenus(ctx)
    for (const entry of flatten(menus[0].items)) if (!isSubmenu(entry)) entry.onSelect()
    const tools = vi.mocked(ctx.setTool).mock.calls.map(([id]) => id)
    expect([...tools].sort()).toEqual(Object.keys(TOOL_LABELS).sort())
    const rings = (items: PieEntry[]): number[] => [items.length, ...items.flatMap((e) => (isSubmenu(e) ? rings(e.items) : []))]
    for (const menu of menus) for (const size of rings(menu.items)) expect(size).toBeLessThanOrEqual(8)
  })

  it('puts freehand and the eraser at the top level, the arrow in shapes, and Portal / Card groups (MAI-42)', () => {
    const [tools] = buildPieMenus(context())
    const labels = (items: PieEntry[]) => items.map((e) => e.label)
    expect(labels(tools.items)).toEqual(['選択', '手のひら', 'フリーハンド', '消しゴム', '図形', '文字', 'Portal', 'Card'])
    const sub = (label: string) => {
      const entry = tools.items.find((e) => e.label === label)!
      return isSubmenu(entry) ? entry.items : []
    }
    expect(labels(sub('図形'))).toEqual(['矩形', '楕円', 'フレーム', '矢印'])
    expect(labels(sub('文字'))).toEqual(['テキスト', '付箋'])
    expect(labels(sub('Portal'))).toEqual(['空', 'PDF', 'Python', 'Markdown'])
    expect(labels(sub('Card'))).toEqual(['Python', 'Markdown'])
  })

  it('creates canvases from the Portal group and switches tools from the Card group', () => {
    const ctx = context()
    const [tools] = buildPieMenus(ctx)
    const leafIn = (group: string, label: string) => {
      const entry = tools.items.find((e) => e.label === group)!
      const leaf = isSubmenu(entry) ? entry.items.find((e) => e.label === label) : undefined
      return leaf && !isSubmenu(leaf) ? leaf : undefined
    }
    leafIn('Portal', '空')!.onSelect()
    expect(ctx.setTool).toHaveBeenLastCalledWith('portal')
    leafIn('Portal', 'PDF')!.onSelect()
    expect(ctx.importPdf).toHaveBeenCalledTimes(1)
    leafIn('Portal', 'Python')!.onSelect()
    expect(ctx.createFileCanvas).toHaveBeenLastCalledWith('code')
    leafIn('Portal', 'Markdown')!.onSelect()
    expect(ctx.createFileCanvas).toHaveBeenLastCalledWith('markdown')
    leafIn('Card', 'Python')!.onSelect()
    expect(ctx.setTool).toHaveBeenLastCalledWith('code')
    leafIn('Card', 'Markdown')!.onSelect()
    expect(ctx.setTool).toHaveBeenLastCalledWith('markdown')
    expect(ctx.createFileCanvas).toHaveBeenCalledTimes(2)
  })

  it('marks the current tool and switches tools', () => {
    const ctx = context('ellipse')
    const [tools] = buildPieMenus(ctx)
    const all = flatten(tools.items)
    const ellipse = all.find((e) => e.label === '楕円')!
    expect(!isSubmenu(ellipse) && ellipse.active).toBe(true)
    expect(all.filter((e) => !isSubmenu(e) && e.active)).toHaveLength(1)
    const rect = all.find((e) => e.label === '矩形')!
    if (!isSubmenu(rect)) rect.onSelect()
    expect(ctx.setTool).toHaveBeenCalledWith('rect')
  })

  it('disables a benchmark while it runs', () => {
    const [, others] = buildPieMenus(context())
    const card = flatten(others.items).find((e) => e.label.startsWith('カードのベンチマーク'))
    expect(card && !isSubmenu(card) && card.disabled).toBe(true)
  })
})
