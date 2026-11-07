import { describe, expect, it } from 'vitest'
import type { AssetResolver, ImageRequester, RasterImage, RenderInfo } from './defineNodeType.ts'
import { pdfPageType, requestPdfPageImage, type PdfPageNode } from './pdfPage.ts'

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

// 描いた文字と、そのときの位置・フォントを記録する ctx
function recordingContext() {
  const texts: { text: string; x: number; y: number; font: string }[] = []
  const state: Record<string, unknown> = { globalAlpha: 1, font: '' }
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key === 'fillText') return (text: string, x: number, y: number) => texts.push({ text, x, y, font: target.font as string })
      if (key === 'measureText') return (text: string) => ({ width: text.length * 6 })
      if (key in target) return target[key as string]
      return () => {}
    },
    set(target, key, value) {
      target[key as string] = value
      return true
    },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts }
}

// ページの番号の札（MAI-92）。画面に描くとき（RenderInfo.pageNumbers）だけ、PDF の中での番号を左上に描く
describe('page number label', () => {
  const page = {
    typeName: 'node',
    id: 'node:p',
    type: 'pdf-page',
    props: { assetId: 'asset:a', fileId: 'file:a', pageIndex: 11, w: 816, h: 1056 },
  } as unknown as PdfPageNode
  const raster: RasterImage = { image: {} as CanvasImageSource, width: 1, height: 1, level: 1 }
  // ページの画像がある（読み込み中の仮の表示を描かない）ときの引く先
  const loaded = {
    assets: { get: () => undefined, load: async () => raster, renderPdfPage: async () => raster, pdfPreviewLevels: () => [] } satisfies AssetResolver,
    images: { get: () => raster } satisfies ImageRequester,
  }
  const draw = (info: Partial<RenderInfo>) => {
    const recorded = recordingContext()
    pdfPageType.render(recorded.ctx, page, { zoom: 0.5, devicePixelRatio: 1, detail: 'full', ...info })
    return recorded.texts
  }

  it('draws the number in the PDF (from 1) at the top left, only when asked', () => {
    const texts = draw({ ...loaded, pageNumbers: true })
    expect(texts.map((t) => t.text)).toEqual(['12'])
    // ページの内側の左上（画面上で 4px 内側の札の中）
    expect(texts[0].x).toBeGreaterThan(0)
    expect(texts[0].x).toBeLessThan(20 / 0.5)
    expect(texts[0].y).toBeGreaterThan(0)
    expect(texts[0].y).toBeLessThan(20 / 0.5)
    expect(draw(loaded)).toEqual([])
    expect(draw({ ...loaded, pageNumbers: false })).toEqual([])
  })

  it('keeps the text 11px on screen at any zoom', () => {
    for (const zoom of [0.25, 1, 3]) {
      const [label] = draw({ ...loaded, pageNumbers: true, zoom })
      expect(label.font).toContain(` ${11 / zoom}px `)
    }
  })

  it('does not draw it when the page is shorter than 48px on screen', () => {
    // 短い辺（幅 816）が画面上で 47px・49px
    expect(draw({ ...loaded, pageNumbers: true, zoom: 47 / 816 })).toEqual([])
    expect(draw({ ...loaded, pageNumbers: true, zoom: 49 / 816 }).map((t) => t.text)).toEqual(['12'])
  })

  it('draws it over the page image and over the placeholder alike', () => {
    expect(draw({ ...loaded, pageNumbers: true }).map((t) => t.text)).toEqual(['12'])
    // 読み込み中は、仮の表示の下の中央の番号と、左上の札の両方
    const placeholder = draw({ pageNumbers: true })
    expect(placeholder.map((t) => t.text)).toEqual(['12', '12'])
    expect(placeholder[1].y).toBeLessThan(placeholder[0].y)
    expect(draw({}).map((t) => t.text)).toEqual(['12'])
  })
})
