import { describe, expect, it, vi } from 'vitest'
import type { SlidePdfPage } from './slidePdf.ts'
import { createSlidePdfExporter, slideOverflowNotice, type SlidePdfJob, type SlidePdfLibrary } from './slidePdfExport.ts'

// スライドを PDF に出力する手順（スライド v2）

const page = (width = 1920): SlidePdfPage => ({ png: new Uint8Array([1]), width, height: 1080 })

function library() {
  return {
    buildSlidePdf: vi.fn<SlidePdfLibrary['buildSlidePdf']>(async () => new Uint8Array([37, 80, 68, 70])),
    slidePdfFileName: vi.fn<SlidePdfLibrary['slidePdfFileName']>((name) => `${name}.pdf`),
    downloadSlidePdf: vi.fn<SlidePdfLibrary['downloadSlidePdf']>(),
  }
}

function job(slideIds: string[], renderSlide: SlidePdfJob['renderSlide'] = async () => page()) {
  return { canvasName: '発表', slideIds, renderSlide, notify: vi.fn<SlidePdfJob['notify']>() }
}

describe('createSlidePdfExporter', () => {
  it('renders the slides in order, builds the PDF titled with the canvas name, and downloads it', async () => {
    const lib = library()
    const rendered: string[] = []
    const pages: Record<string, SlidePdfPage> = { a: page(1920), b: page(1440), c: page(1920) }
    const task = job(['b', 'a', 'c'], async (id) => {
      rendered.push(id)
      return pages[id]
    })
    await createSlidePdfExporter(async () => lib)(task)
    expect(rendered).toEqual(['b', 'a', 'c'])
    expect(lib.buildSlidePdf).toHaveBeenCalledWith([pages.b, pages.a, pages.c], { title: '発表' })
    expect(lib.downloadSlidePdf).toHaveBeenCalledWith(new Uint8Array([37, 80, 68, 70]), '発表.pdf')
    expect(task.notify.mock.calls.map(([m]) => m)).toEqual(['スライドの PDF を作っています…（3 枚）', '発表.pdf を出力しました'])
  })

  it('builds the PDF and then tells which slides overflow', async () => {
    const lib = library()
    const task = { ...job(['a', 'b', 'c', 'd', 'e']), overflowNumbers: [5, 3] }
    await createSlidePdfExporter(async () => lib)(task)
    expect(lib.downloadSlidePdf).toHaveBeenCalledTimes(1)
    expect(task.notify.mock.calls.map(([m]) => m)).toEqual([
      'スライドの PDF を作っています…（5 枚）',
      '発表.pdf を出力しました',
      '3・5 枚目の文字があふれています',
    ])
    // あふれが無ければ知らせない
    expect(slideOverflowNotice([])).toBeNull()
    expect(slideOverflowNotice([2])).toBe('2 枚目の文字があふれています')
    const clean = { ...job(['a']), overflowNumbers: [] }
    await createSlidePdfExporter(async () => lib)(clean)
    expect(clean.notify).toHaveBeenLastCalledWith('発表.pdf を出力しました')
  })

  it('notifies and does nothing when no slide is shown', async () => {
    const lib = library()
    const load = vi.fn(async () => lib)
    const task = job([])
    await createSlidePdfExporter(load)(task)
    expect(task.notify).toHaveBeenCalledWith('PDF に出力するスライドがありません（すべて非表示です）')
    expect(load).not.toHaveBeenCalled()
    expect(lib.downloadSlidePdf).not.toHaveBeenCalled()
  })

  it('does not start again while exporting, and can start once it has finished', async () => {
    const lib = library()
    const exportPdf = createSlidePdfExporter(async () => lib)
    let finish = (): void => {}
    const first = job(['a'], () => new Promise((resolve) => (finish = () => resolve(page()))))
    const running = exportPdf(first)
    const second = job(['a'])
    await exportPdf(second)
    expect(second.notify).not.toHaveBeenCalled()
    expect(lib.buildSlidePdf).not.toHaveBeenCalled()
    finish()
    await running
    expect(lib.downloadSlidePdf).toHaveBeenCalledTimes(1)
    const third = job(['a'])
    await exportPdf(third)
    expect(lib.downloadSlidePdf).toHaveBeenCalledTimes(2)
  })

  it('reports the progress every 10 slides, skips slides it cannot render, and notifies failures', async () => {
    const lib = library()
    const ids = Array.from({ length: 25 }, (_, i) => `s${i}`)
    const task = job(ids, async (id) => (id === 's3' ? null : page()))
    await createSlidePdfExporter(async () => lib)(task)
    expect(task.notify.mock.calls.map(([m]) => m)).toEqual([
      'スライドの PDF を作っています…（25 枚）',
      'スライドの PDF を作っています…（10 / 25 枚）',
      'スライドの PDF を作っています…（20 / 25 枚）',
      '発表.pdf を出力しました',
    ])
    expect(lib.buildSlidePdf.mock.calls[0][0]).toHaveLength(24)

    const failing = library()
    failing.buildSlidePdf.mockRejectedValueOnce(new Error('壊れた画像'))
    const exportPdf = createSlidePdfExporter(async () => failing)
    const broken = job(['a'])
    await exportPdf(broken)
    expect(broken.notify).toHaveBeenLastCalledWith('スライドを PDF に出力できませんでした：壊れた画像')
    expect(failing.downloadSlidePdf).not.toHaveBeenCalled()
    // 失敗したあとは、また始められる
    await exportPdf(job(['a']))
    expect(failing.downloadSlidePdf).toHaveBeenCalledTimes(1)
  })
})
