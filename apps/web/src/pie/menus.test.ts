import { describe, expect, it, vi } from 'vitest'
import { buildPieMenus, type PdfMenuContext, type PieMenuContext, type SelectionMenuContext } from './menus.ts'
import { isSubmenu, type PieEntry, type PieMenuDef } from './pieMenu.ts'

// パイメニュー「操作」（MAI-57、キー o）。今の選択とキャンバスに応じて項目が変わる

const NO_PDF: PdfMenuContext = { hasPages: false, canNext: false, canPrev: false, allLocked: true, noneLocked: true }
const NO_SELECTION: SelectionMenuContext = { count: 0, arrangeCount: 0, hasText: false, frame: false }

function context(pdf: Partial<PdfMenuContext> = {}, selection: Partial<SelectionMenuContext> = {}): PieMenuContext {
  return {
    toolId: 'select',
    setTool: vi.fn(),
    importPdf: vi.fn(),
    createFileCanvas: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    showStats: false,
    toggleStats: vi.fn(),
    benchRunning: false,
    cardBenchRunning: false,
    addBenchNodes: vi.fn(),
    clearNodes: vi.fn(),
    runBenchmark: vi.fn(),
    addMarkdownCards: vi.fn(),
    runCardBenchmark: vi.fn(),
    markdownCardCount: 20,
    pdf: { ...NO_PDF, ...pdf },
    selection: { ...NO_SELECTION, ...selection },
    panToPage: vi.fn(),
    unlockAndSelectPdfPages: vi.fn(),
    lockPdfPages: vi.fn(),
    stepFontSize: vi.fn(),
    setTextAlign: vi.fn(),
    alignSelection: vi.fn(),
    distributeSelection: vi.fn(),
    lockSelection: vi.fn(),
    duplicateSelection: vi.fn(),
    makeSlideFigure: vi.fn(),
    copyFigureReference: vi.fn(),
  }
}

const actionsOf = (ctx: PieMenuContext): PieMenuDef | undefined => buildPieMenus(ctx).find((m) => m.id === 'actions')
const labels = (items: PieEntry[] | undefined) => (items ?? []).map((e) => e.label)
const sub = (menu: PieMenuDef | undefined, label: string): PieEntry[] | undefined => {
  const entry = menu?.items.find((e) => e.label === label)
  return entry && isSubmenu(entry) ? entry.items : undefined
}
const run = (items: PieEntry[] | undefined, label: string) => {
  const entry = items?.find((e) => e.label === label)
  if (!entry || isSubmenu(entry)) throw new Error(`no leaf ${label}`)
  entry.onSelect()
}

describe('buildPieMenus: actions menu (MAI-57)', () => {
  it('is omitted entirely when nothing applies, and opens with "o" otherwise', () => {
    expect(actionsOf(context())).toBeUndefined()
    const menu = actionsOf(context({}, { count: 1 }))
    expect(menu?.key).toBe('o')
    expect(menu?.label).toBe('操作')
  })

  it('shows page items only when the canvas has PDF pages, omitting the ends and no-op lock items', () => {
    const ctx = context({ hasPages: true, canNext: true, canPrev: false, allLocked: true, noneLocked: false })
    const menu = actionsOf(ctx)
    expect(labels(menu?.items)).toEqual(['次のページ', 'ページをすべて選ぶ（固定を外す）'])
    run(menu?.items, '次のページ')
    expect(ctx.panToPage).toHaveBeenCalledWith('next')
    run(menu?.items, 'ページをすべて選ぶ（固定を外す）')
    expect(ctx.unlockAndSelectPdfPages).toHaveBeenCalledTimes(1)

    const middle = actionsOf(context({ hasPages: true, canNext: true, canPrev: true, allLocked: false, noneLocked: false }))
    expect(labels(middle?.items)).toEqual(['次のページ', '前のページ', 'ページをすべて選ぶ（固定を外す）', 'ページを固定する'])

    const last = context({ hasPages: true, canNext: false, canPrev: true, allLocked: false, noneLocked: true })
    expect(labels(actionsOf(last)?.items)).toEqual(['前のページ', 'ページを固定する'])
    run(actionsOf(last)?.items, '前のページ')
    expect(last.panToPage).toHaveBeenCalledWith('prev')
    run(actionsOf(last)?.items, 'ページを固定する')
    expect(last.lockPdfPages).toHaveBeenCalledTimes(1)

    // ページのない Canvas では、canNext などに関わらず出ない
    expect(actionsOf(context({ hasPages: false, canNext: true, canPrev: true, allLocked: false, noneLocked: false }))).toBeUndefined()
  })

  it('shows text items only when text or note nodes are selected', () => {
    const ctx = context({}, { count: 1, hasText: true })
    const menu = actionsOf(ctx)
    expect(labels(menu?.items)).toEqual(['文字を大きく', '文字を小さく', '揃え', '固定する', '複製'])
    run(menu?.items, '文字を大きく')
    expect(ctx.stepFontSize).toHaveBeenLastCalledWith(1)
    run(menu?.items, '文字を小さく')
    expect(ctx.stepFontSize).toHaveBeenLastCalledWith(-1)
    expect(labels(sub(menu, '揃え'))).toEqual(['左', '中央', '右'])
    run(sub(menu, '揃え'), '中央')
    expect(ctx.setTextAlign).toHaveBeenCalledWith('center')

    expect(labels(actionsOf(context({}, { count: 1 }))?.items)).toEqual(['固定する', '複製'])
  })

  it('shows 整列 from 2 arrange targets and 等間隔 from 3', () => {
    const one = actionsOf(context({}, { count: 2, arrangeCount: 1 }))
    expect(labels(one?.items)).toEqual(['固定する', '複製'])

    const two = context({}, { count: 2, arrangeCount: 2 })
    const menu2 = actionsOf(two)
    expect(labels(menu2?.items)).toEqual(['整列', '固定する', '複製'])
    expect(labels(sub(menu2, '整列'))).toEqual(['左', '左右中央', '右', '上', '上下中央', '下'])
    run(sub(menu2, '整列'), '上下中央')
    expect(two.alignSelection).toHaveBeenCalledWith('vcenter')

    const three = context({}, { count: 3, arrangeCount: 3 })
    const menu3 = actionsOf(three)
    expect(labels(menu3?.items)).toEqual(['整列', '等間隔', '固定する', '複製'])
    expect(labels(sub(menu3, '等間隔'))).toEqual(['横', '縦'])
    run(sub(menu3, '等間隔'), '縦')
    expect(three.distributeSelection).toHaveBeenCalledWith('y')
  })

  it('locks and duplicates the selection', () => {
    const ctx = context({}, { count: 1 })
    const menu = actionsOf(ctx)
    run(menu?.items, '固定する')
    expect(ctx.lockSelection).toHaveBeenCalledTimes(1)
    run(menu?.items, '複製')
    expect(ctx.duplicateSelection).toHaveBeenCalledTimes(1)
  })

  it('offers to use a single selected frame as a slide figure', () => {
    const ctx = context({}, { count: 1, frame: true })
    const menu = actionsOf(ctx)
    expect(labels(menu?.items)).toEqual(['固定する', '複製', 'スライドの図にする…', '図の参照をコピー'])
    run(menu?.items, 'スライドの図にする…')
    expect(ctx.makeSlideFigure).toHaveBeenCalledTimes(1)
    run(menu?.items, '図の参照をコピー')
    expect(ctx.copyFigureReference).toHaveBeenCalledTimes(1)
  })

  it('folds the page items into a submenu when the ring would exceed 8 items', () => {
    const pdf = { hasPages: true, canNext: true, canPrev: true, allLocked: false, noneLocked: false }
    const menu = actionsOf(context(pdf, { count: 3, arrangeCount: 3, hasText: true }))
    expect(labels(menu?.items)).toEqual(['ページ', '文字を大きく', '文字を小さく', '揃え', '整列', '等間隔', '固定する', '複製'])
    expect(labels(sub(menu, 'ページ'))).toEqual(['次のページ', '前のページ', 'ページをすべて選ぶ（固定を外す）', 'ページを固定する'])
    // 8 つまでなら、ページの項目もそのまま並べる
    const fits = actionsOf(context(pdf, { count: 2, arrangeCount: 2, hasText: false }))
    expect(fits?.items).toHaveLength(7)
    expect(labels(fits?.items)[0]).toBe('次のページ')
  })
})
