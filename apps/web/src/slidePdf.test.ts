import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { buildSlidePdf, slidePdfFileName } from './slidePdf.ts'

// キャンバスのスライドを PDF にする（スライド v2）

// 1×1 の PNG
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), (c) => c.charCodeAt(0))

describe('buildSlidePdf', () => {
  it('makes one page per slide, sized to each slide, titled with the canvas name', async () => {
    const progress: [number, number][] = []
    const data = await buildSlidePdf(
      [
        { png: PNG, width: 1920, height: 1080 },
        { png: new Blob([PNG], { type: 'image/png' }), width: 1440, height: 1080 },
        { png: PNG, width: 1920, height: 1080 },
      ],
      { title: '発表 2026', onProgress: (done, total) => progress.push([done, total]) },
    )
    const pdf = await PDFDocument.load(data)
    expect(pdf.getPageCount()).toBe(3)
    expect(pdf.getPages().map((page) => page.getSize())).toEqual([
      { width: 960, height: 540 },
      { width: 720, height: 540 },
      { width: 960, height: 540 },
    ])
    expect(pdf.getTitle()).toBe('発表 2026')
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ])
  })
})

describe('slidePdfFileName', () => {
  it('appends .pdf to the canvas name', () => {
    expect(slidePdfFileName('発表 2026')).toBe('発表 2026.pdf')
  })

  it('replaces characters that cannot be in a file name', () => {
    expect(slidePdfFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j.pdf')
    expect(slidePdfFileName('  改行\nと\tタブ  ')).toBe('改行-と-タブ.pdf')
  })

  it('falls back when the name is empty', () => {
    expect(slidePdfFileName('   ')).toBe('slides.pdf')
  })
})
