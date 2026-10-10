import { describe, expect, it, vi } from 'vitest'
import { buildPieMenus, type PdfMenuContext, type PieMenuContext, type SelectionMenuContext } from './menus.ts'
import { isSubmenu, type PieEntry, type PieMenuDef } from './pieMenu.ts'

// パイメニュー「操作」（MAI-57、キー o）。今の選択とキャンバスに応じて項目が変わる

const NO_PDF: PdfMenuContext = { hasPages: false, canNext: false, canPrev: false, allLocked: true, noneLocked: true }
const NO_SELECTION: SelectionMenuContext = { count: 0, arrangeCount: 0, reorderCount: 0, hasText: false, slideCount: 0, slidesHidden: false, slideRows: null, slideTemplate: false }

function context(pdf: Partial<PdfMenuContext> = {}, selection: Partial<SelectionMenuContext> = {}, hasSlides = false): PieMenuContext {
  return {
    toolId: 'select',
    setTool: vi.fn(),
    importPdf: vi.fn(),
    createFileCanvas: vi.fn(),
    placeSlide: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    showStats: false,
    toggleStats: vi.fn(),
    benchRunning: false,
    cardBenchRunning: false,
    addBenchNodes: vi.fn(),
    addBenchShadowNodes: vi.fn(),
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
    reorderSelection: vi.fn(),
    lockSelection: vi.fn(),
    duplicateSelection: vi.fn(),
    toggleSlideRatio: vi.fn(),
    toggleSlidesHidden: vi.fn(),
    addSlideRow: vi.fn(),
    removeSlideRow: vi.fn(),
    resetSlideRowHeight: vi.fn(),
    applySlideTemplate: vi.fn(),
    hasSlides,
    exportSlidesPdf: vi.fn(),
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

  it('shows 重なり順 when something inside a frame is selected', () => {
    expect(labels(actionsOf(context({}, { count: 1, reorderCount: 0 }))?.items)).not.toContain('重なり順')
    const ctx = context({}, { count: 1, reorderCount: 1 })
    const menu = actionsOf(ctx)
    expect(labels(menu?.items)).toEqual(['重なり順', '固定する', '複製'])
    expect(labels(sub(menu, '重なり順'))).toEqual(['最前面', '前面', '背面', '最背面'])
    run(sub(menu, '重なり順'), '背面')
    expect(ctx.reorderSelection).toHaveBeenCalledWith('backward')
  })

  it('locks and duplicates the selection', () => {
    const ctx = context({}, { count: 1 })
    const menu = actionsOf(ctx)
    run(menu?.items, '固定する')
    expect(ctx.lockSelection).toHaveBeenCalledTimes(1)
    run(menu?.items, '複製')
    expect(ctx.duplicateSelection).toHaveBeenCalledTimes(1)
  })

  it('shows the slide items when slides are selected (slides v2)', () => {
    const ctx = context({}, { count: 2, arrangeCount: 2, slideCount: 2 })
    const menu = actionsOf(ctx)
    expect(labels(menu?.items)).toEqual(['整列', '固定する', '複製', '比率を切り替え', '非表示にする'])
    run(menu?.items, '比率を切り替え')
    expect(ctx.toggleSlideRatio).toHaveBeenCalledTimes(1)
    run(menu?.items, '非表示にする')
    expect(ctx.toggleSlidesHidden).toHaveBeenCalledTimes(1)

    // 全部が非表示なら「表示する」
    const hidden = context({}, { count: 1, slideCount: 1, slidesHidden: true })
    expect(labels(actionsOf(hidden)?.items)).toEqual(['固定する', '複製', '比率を切り替え', '表示する'])
    run(actionsOf(hidden)?.items, '表示する')
    expect(hidden.toggleSlidesHidden).toHaveBeenCalledTimes(1)
  })

  it('folds the text items into a submenu when the slide items would push the ring over 8', () => {
    const ctx = context({}, { count: 3, arrangeCount: 3, reorderCount: 1, hasText: true, slideCount: 1 })
    const menu = actionsOf(ctx)
    expect(labels(menu?.items)).toEqual(['文字', '整列', '等間隔', '重なり順', '固定する', '複製', '比率を切り替え', '非表示にする'])
    expect(labels(sub(menu, '文字'))).toEqual(['文字を大きく', '文字を小さく', '揃え'])
    run(sub(menu, '文字'), '文字を大きく')
    expect(ctx.stepFontSize).toHaveBeenCalledWith(1)
    // 8 つに収まるなら、文字の項目もそのまま並べる
    const fits = actionsOf(context({}, { count: 2, hasText: true, slideCount: 1 }))
    expect(labels(fits?.items)).toEqual(['文字を大きく', '文字を小さく', '揃え', '固定する', '複製', '比率を切り替え', '非表示にする'])
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

  it('offers to export the slides to PDF when the canvas has slides, even with nothing selected (slides v2)', () => {
    expect(actionsOf(context({}, {}, false))).toBeUndefined()
    const ctx = context({}, {}, true)
    const menu = actionsOf(ctx)
    expect(labels(menu?.items)).toEqual(['スライドを PDF に出力'])
    run(menu?.items, 'スライドを PDF に出力')
    expect(ctx.exportSlidesPdf).toHaveBeenCalledTimes(1)
    // スライドを選んでいれば、スライドの項目のあとに並べる
    expect(labels(actionsOf(context({}, { count: 1, slideCount: 1 }, true))?.items)).toEqual([
      '固定する',
      '複製',
      '比率を切り替え',
      '非表示にする',
      'スライドを PDF に出力',
    ])
    // PDF のページの項目と一緒でも出る
    const pdf = { hasPages: true, canNext: true, canPrev: false, allLocked: true, noneLocked: false }
    expect(labels(actionsOf(context(pdf, {}, true))?.items)).toEqual(['次のページ', 'ページをすべて選ぶ（固定を外す）', 'スライドを PDF に出力'])
  })

  it('folds the slide items into a submenu when they would still push the ring over 8 after folding the text items', () => {
    const ctx = context({}, { count: 3, arrangeCount: 3, reorderCount: 1, hasText: true, slideCount: 1 }, true)
    const menu = actionsOf(ctx)
    expect(labels(menu?.items)).toEqual(['文字', '整列', '等間隔', '重なり順', '固定する', '複製', 'スライド'])
    expect(labels(sub(menu, 'スライド'))).toEqual(['比率を切り替え', '非表示にする', 'スライドを PDF に出力'])
    run(sub(menu, 'スライド'), 'スライドを PDF に出力')
    expect(ctx.exportSlidesPdf).toHaveBeenCalledTimes(1)
    // 文字の項目をまとめれば 8 つに収まるなら、スライドの項目はそのまま並べる
    const fits = actionsOf(context({}, { count: 2, arrangeCount: 2, hasText: true, slideCount: 1 }, true))
    expect(labels(fits?.items)).toEqual(['文字', '整列', '固定する', '複製', '比率を切り替え', '非表示にする', 'スライドを PDF に出力'])
    // 8 項目以下に収まる
    const full = actionsOf(context({ hasPages: true, canNext: true, canPrev: true, allLocked: false, noneLocked: false }, { count: 3, arrangeCount: 3, reorderCount: 1, hasText: true, slideCount: 2 }, true))
    expect(full?.items).toHaveLength(8)
    expect(labels(full?.items)[0]).toBe('ページ')
  })

  it('adds and removes a row of the slide contents when a cell or its slide is selected (slides v2)', () => {
    // 行のセルを選んでいれば「行を足す」「行を消す」を、スライドの項目の並びに出す
    const ctx = context({}, { count: 1, reorderCount: 1, slideRows: { canRemove: true } }, true)
    const menu = actionsOf(ctx)
    expect(labels(menu?.items)).toEqual(['重なり順', '固定する', '複製', '行を足す', '行を消す', 'スライドを PDF に出力'])
    run(menu?.items, '行を足す')
    expect(ctx.addSlideRow).toHaveBeenCalledTimes(1)
    run(menu?.items, '行を消す')
    expect(ctx.removeSlideRow).toHaveBeenCalledTimes(1)
    // 消せないとき（最後の 1 行・スライドを選んでいる）は「行を足す」だけ
    const slide = actionsOf(context({}, { count: 1, slideCount: 1, slideRows: { canRemove: false } }, true))
    expect(labels(slide?.items)).toEqual(['固定する', '複製', '比率を切り替え', '非表示にする', '行を足す', 'スライドを PDF に出力'])
    // 8 つを超えるなら、文字の項目に続いてスライドの項目を「スライド ›」にまとめる
    const full = actionsOf(context({}, { count: 3, arrangeCount: 3, reorderCount: 1, hasText: true, slideCount: 1, slideRows: { canRemove: true } }, true))
    expect(labels(full?.items)).toEqual(['文字', '整列', '等間隔', '重なり順', '固定する', '複製', 'スライド'])
    expect(labels(sub(full, 'スライド'))).toEqual(['比率を切り替え', '非表示にする', '行を足す', '行を消す', 'スライドを PDF に出力'])
    // スライドを選んでいて 8 つちょうどなら、まとめずに並べる
    const fits = actionsOf(context({}, { count: 1, reorderCount: 1, slideCount: 1, slideRows: { canRemove: false } }, true))
    expect(labels(fits?.items)).toEqual(['重なり順', '固定する', '複製', '比率を切り替え', '非表示にする', '行を足す', 'スライドを PDF に出力'])
  })

  it('resets the row height to auto when the row of the selected cell has a manual height (slides v2)', () => {
    // 手で高さを決めた行のセルを選んでいれば「行の高さを自動に戻す」を、行の項目に続けて出す
    const ctx = context({}, { count: 1, reorderCount: 1, slideRows: { canRemove: true, manualHeight: true } }, true)
    const menu = actionsOf(ctx)
    expect(labels(menu?.items)).toEqual(['重なり順', '固定する', '複製', '行を足す', '行を消す', '行の高さを自動に戻す', 'スライドを PDF に出力'])
    run(menu?.items, '行の高さを自動に戻す')
    expect(ctx.resetSlideRowHeight).toHaveBeenCalledTimes(1)
    // 自動の行（manualHeight が無い・false）なら出さない
    expect(labels(actionsOf(context({}, { count: 1, reorderCount: 1, slideRows: { canRemove: true, manualHeight: false } }, true))?.items)).not.toContain(
      '行の高さを自動に戻す',
    )
    // 8 つを超えるなら「スライド ›」にまとめた中に出す
    const full = actionsOf(
      context({}, { count: 3, arrangeCount: 3, reorderCount: 1, hasText: true, slideCount: 1, slideRows: { canRemove: true, manualHeight: true } }, true),
    )
    expect(labels(sub(full, 'スライド'))).toEqual(['比率を切り替え', '非表示にする', '行を足す', '行を消す', '行の高さを自動に戻す', 'スライドを PDF に出力'])
  })

  it('applies a template to the only selected slide when it has no children (slides v2)', () => {
    // 子の無いスライドを 1 つだけ選んでいれば「テンプレート ›」を、スライドの項目の並びに出す
    const ctx = context({}, { count: 1, reorderCount: 1, slideCount: 1, slideTemplate: true }, true)
    const menu = actionsOf(ctx)
    expect(labels(menu?.items)).toEqual(['重なり順', '固定する', '複製', '比率を切り替え', '非表示にする', 'テンプレート', 'スライドを PDF に出力'])
    expect(labels(sub(menu, 'テンプレート'))).toEqual(['表紙', '箇条書き', '表', '表＋画像', '表＋2画像'])
    run(sub(menu, 'テンプレート'), '表')
    expect(ctx.applySlideTemplate).toHaveBeenLastCalledWith('table')
    run(sub(menu, 'テンプレート'), '表＋画像')
    expect(ctx.applySlideTemplate).toHaveBeenLastCalledWith('table-image')
    run(sub(menu, 'テンプレート'), '表紙')
    expect(ctx.applySlideTemplate).toHaveBeenLastCalledWith('title')
    run(sub(menu, 'テンプレート'), '箇条書き')
    expect(ctx.applySlideTemplate).toHaveBeenLastCalledWith('bullets')
    // 子のあるスライド・スライドを 2 つ以上選んでいるとき（slideTemplate が false）は出さない
    expect(labels(actionsOf(context({}, { count: 1, slideCount: 1 }, true))?.items)).not.toContain('テンプレート')
    expect(labels(actionsOf(context({}, { count: 2, arrangeCount: 2, slideCount: 2 }, true))?.items)).not.toContain('テンプレート')
    // 8 つを超えるなら「スライド ›」にまとめ、テンプレートはその中のサブメニューになる
    const pdf = { hasPages: true, canNext: true, canPrev: true, allLocked: false, noneLocked: false }
    const full = actionsOf(context(pdf, { count: 1, reorderCount: 1, slideCount: 1, slideTemplate: true }, true))
    expect(labels(full?.items)).toEqual(['ページ', '重なり順', '固定する', '複製', '比率を切り替え', '非表示にする', 'テンプレート', 'スライドを PDF に出力'])
    const folded = actionsOf(context({}, { count: 1, reorderCount: 1, hasText: true, slideCount: 1, slideTemplate: true }, true))
    expect(labels(folded?.items)).toEqual(['文字', '重なり順', '固定する', '複製', '比率を切り替え', '非表示にする', 'テンプレート', 'スライドを PDF に出力'])
    const rings = (items: PieEntry[]): number[] => [items.length, ...items.flatMap((e) => (isSubmenu(e) ? rings(e.items) : []))]
    for (const ring of [menu, full, folded]) for (const size of rings(ring!.items)) expect(size).toBeLessThanOrEqual(8)
  })
})
