import { describe, expect, it } from 'vitest'
import type { AssetResolver, ImageRequester, RasterImage } from './defineNodeType.ts'
import { requestPdfPageImage } from './pdfPage.ts'

// PDF のページの画像を、倍率に応じて前もって作った画像（Issue #26）と PDF.js のどちらに頼むか

function setup(previews: number[] | null, atHand: number | null = null) {
  const made: string[] = []
  const image = (level: number): RasterImage => ({ image: {} as CanvasImageSource, width: 1, height: 1, level })
  const assets: AssetResolver = {
    get: () => undefined,
    load: async () => image(1),
    renderPdfPage: async (_id, _page, scale) => {
      made.push(`pdf.js ${scale}`)
      return image(scale)
    },
    pdfPreviewLevels: () => previews,
    loadPdfPreview: async (_id, _page, level) => {
      made.push(`preview ${level}`)
      return image(level)
    },
  }
  const requested: number[] = []
  const peeked: number[] = []
  const images: ImageRequester = {
    get(_key, _version, level, produce) {
      requested.push(level)
      void produce()
      return null
    },
    peek(_key, _version, level) {
      peeked.push(level)
      return atHand === null ? null : image(atHand)
    },
  }
  return { assets, images, requested, peeked, made }
}

describe('requestPdfPageImage', () => {
  it('uses the sheet image for the whole view, without PDF.js', () => {
    const { assets, images, requested, made } = setup([0.17, 0.69])
    requestPdfPageImage(assets, images, 'asset:a', 0, 0.16)
    expect(requested).toEqual([0.17])
    expect(made).toEqual(['preview 0.17'])
  })

  it('stretches a page image a little rather than drawing with PDF.js', () => {
    const { assets, images, requested } = setup([0.17, 0.69])
    // 0.69 は 0.8 × 0.8 = 0.64 以上
    requestPdfPageImage(assets, images, 'asset:a', 0, 0.8)
    expect(requested).toEqual([0.69])
  })

  it('asks for the largest page image first, then PDF.js, when zoomed in', () => {
    const { assets, images, requested, made } = setup([0.17, 0.69])
    requestPdfPageImage(assets, images, 'asset:a', 0, 1.5)
    expect(requested).toEqual([0.69, 2])
    expect(made).toEqual(['preview 0.69', 'pdf.js 2'])
  })

  it('does not ask for the page image again when a sharper image is at hand', () => {
    const { assets, images, requested } = setup([0.17, 0.69], 2)
    requestPdfPageImage(assets, images, 'asset:a', 0, 1.5)
    expect(requested).toEqual([2])
  })

  it('draws with PDF.js when there are no page images', () => {
    const { assets, images, requested } = setup([])
    requestPdfPageImage(assets, images, 'asset:a', 0, 0.1)
    expect(requested).toEqual([0.25])
  })

  it('only shows what is at hand while it is still checking for page images', () => {
    const { assets, images, requested, peeked, made } = setup(null)
    requestPdfPageImage(assets, images, 'asset:a', 0, 0.1)
    expect(requested).toEqual([])
    expect(peeked).toEqual([0.25])
    expect(made).toEqual([])
  })
})
