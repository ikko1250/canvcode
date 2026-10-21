import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssetManager, type PdfDocument, type PdfService } from './assets.ts'
import { MemoryPdfPageBackend, PdfPageStore } from './pdfPageStore.ts'

// 開いている PDF の数を抑える（MAI-66）

function fakePdfService() {
  const opened: string[] = []
  // 閉じた順
  const closed: string[] = []
  const service: PdfService = {
    async open(source) {
      const url = 'url' in source ? source.url : 'data'
      const destroy = async () => {
        closed.push(url)
      }
      opened.push(url)
      const doc: PdfDocument = {
        numPages: 1,
        pageSize: async () => ({ width: 100, height: 100 }),
        render: async () => ({}) as ImageBitmap,
        textItems: async () => [],
        destroy,
      }
      return doc
    },
  }
  return { service, opened, closed }
}

function setup() {
  const { service, opened, closed } = fakePdfService()
  const assets = new AssetManager({ pdf: service, baseUrl: '/api/assets' })
  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    assets.register({ typeName: 'asset', id: `asset:${name}`, mime: 'application/pdf', size: 1, hash: name, width: 0, height: 0, variants: [] })
  }
  const use = (name: string) => assets.withPdfDocument(`asset:${name}`, async (doc) => doc.numPages)
  const destroyed = () => [...closed]
  return { assets, opened, use, destroyed }
}

describe('AssetManager PDF documents', () => {
  it('reuses an open document', async () => {
    const { opened, use } = setup()
    await use('a')
    await use('a')
    expect(opened).toHaveLength(1)
  })

  it('closes the least recently used documents over the limit', async () => {
    const { assets, use, destroyed } = setup()
    await use('a')
    await use('b')
    await use('c')
    // 'a' を使い直すと、いちばん古いのは 'b' になる
    await use('a')
    await use('d')
    await vi.waitFor(() => expect(destroyed()).toEqual(['/api/assets/b']))
    expect(assets.stats.pdfDocuments).toBe(3)
  })

  it('does not close a document while it is in use', async () => {
    const { assets, use, destroyed } = setup()
    let release!: () => void
    const inUse = assets.withPdfDocument('asset:a', () => new Promise<void>((resolve) => (release = resolve)))
    await use('b')
    await use('c')
    await use('d')
    await use('e')
    // 'a' は使っている途中なので、その次に古い 'b' と 'c' を閉じる
    await vi.waitFor(() => expect(destroyed()).toEqual(['/api/assets/b', '/api/assets/c']))
    release()
    await inUse
    expect(assets.stats.pdfDocuments).toBe(3)
    // 使い終わったあとは、ほかと同じく古い順に閉じる
    await use('b')
    await vi.waitFor(() => expect(destroyed()).toEqual(['/api/assets/b', '/api/assets/c', '/api/assets/a']))
  })

  it('closes a document that was over the limit once it is no longer in use', async () => {
    const { assets, destroyed } = setup()
    const releases: (() => void)[] = []
    const inUse = ['a', 'b', 'c', 'd'].map((name) =>
      assets.withPdfDocument(`asset:${name}`, () => new Promise<void>((resolve) => releases.push(resolve))),
    )
    await vi.waitFor(() => expect(releases).toHaveLength(4))
    // どれも使っている途中なので、上限を超えていても閉じない
    expect(assets.stats.pdfDocuments).toBe(4)
    releases[0]()
    await inUse[0]
    await vi.waitFor(() => expect(destroyed()).toEqual(['/api/assets/a']))
    expect(assets.stats.pdfDocuments).toBe(3)
    for (const release of releases.slice(1)) release()
    await Promise.all(inUse)
    expect(destroyed()).toEqual(['/api/assets/a'])
  })
})

// サーバーが前もって作ったページの画像と、ブラウザに置いたページの画像（Issue #26）
describe('AssetManager PDF page images', () => {
  const manifest = {
    version: 1,
    // 2 ページ目は横長
    pages: [
      { w: 600, h: 800 },
      { w: 800, h: 600 },
    ],
    sheets: [{ width: 448, height: 256 }],
    thumbs: [
      { sheet: 0, x: 0, y: 0, w: 192, h: 256 },
      { sheet: 0, x: 192, y: 0, w: 256, h: 192 },
    ],
    mid: { size: 1024 },
  }

  function setupPreviews(response: { status: number; body: unknown } = { status: 200, body: manifest }) {
    const requests: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      requests.push(url)
      if (url.endsWith('/preview')) return new Response(JSON.stringify(response.body), { status: response.status })
      return new Response(new Blob([url]))
    })
    const crops: unknown[][] = []
    vi.stubGlobal('createImageBitmap', async (...args: unknown[]) => {
      crops.push(args.slice(1))
      const [w, h] = args.length > 1 ? [args[3] as number, args[4] as number] : [100, 100]
      return { width: w, height: h, close() {} }
    })
    const { service, opened } = fakePdfService()
    const backend = new MemoryPdfPageBackend()
    const assets = new AssetManager({ pdf: service, baseUrl: '/api/assets', pageStore: new PdfPageStore(backend) })
    assets.register({ typeName: 'asset', id: 'asset:p', mime: 'application/pdf', size: 1, hash: 'p', width: 0, height: 0, variants: [] })
    let changes = 0
    assets.onPdfPreviewChange(() => changes++)
    return { assets, requests, crops, opened, backend, changes: () => changes }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('tells it is still checking, then gives the levels of the sheet and the page images', async () => {
    const { assets, changes } = setupPreviews()
    expect(assets.pdfPreviewLevels('asset:p', 0)).toBeNull()
    await assets.preparePdfPreview('asset:p')
    expect(changes()).toBe(1)
    // 192 / (600 × 96/72) と 1024 / 800 / (96/72)
    for (const pageIndex of [0, 1]) {
      const levels = assets.pdfPreviewLevels('asset:p', pageIndex)!
      expect(levels).toHaveLength(2)
      expect(levels[0]).toBeCloseTo(0.24)
      expect(levels[1]).toBeCloseTo(0.96)
    }
    expect(assets.pdfPreviewLevels('asset:p', 2)).toEqual([])
  })

  it('has no levels when the server has not made them', async () => {
    const { assets, changes } = setupPreviews({ status: 404, body: { status: 'pending' } })
    await assets.preparePdfPreview('asset:p')
    expect(assets.pdfPreviewLevels('asset:p', 0)).toEqual([])
    expect(changes()).toBe(1)
  })

  it('cuts the page out of the sheet, reading the sheet once, and reads the page image for the larger level', async () => {
    const { assets, requests, crops, opened } = setupPreviews()
    await assets.preparePdfPreview('asset:p')
    const [thumb, large] = assets.pdfPreviewLevels('asset:p', 1)!
    const first = await assets.loadPdfPreview('asset:p', 0, thumb)
    const second = await assets.loadPdfPreview('asset:p', 1, thumb)
    expect([first.level, first.width, first.height]).toEqual([thumb, 192, 256])
    expect(second.width).toBe(256)
    expect(crops.filter((args) => args.length > 0)).toEqual([
      [0, 0, 192, 256],
      [192, 0, 256, 192],
    ])
    const mid = await assets.loadPdfPreview('asset:p', 1, large)
    expect(mid.level).toBe(large)
    expect(requests).toEqual(['/api/assets/p/preview', '/api/assets/p/preview/v1/sheet/0', '/api/assets/p/preview/v1/page/1'])
    // PDF は開かない
    expect(opened).toEqual([])
  })

  it('returns a kept page image of the same level without opening the PDF, and keeps each page once', async () => {
    const { assets, opened, backend } = setupPreviews()
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return { drawImage() {} }
        }
        async convertToBlob() {
          return new Blob(['webp'])
        }
      },
    )
    const raster = { image: {} as ImageBitmap, width: 100, height: 100, level: 2 }
    await assets.rememberPdfPage('asset:p', 0, raster)
    await assets.rememberPdfPage('asset:p', 0, raster)
    // level 1 より下は置かない
    await assets.rememberPdfPage('asset:p', 1, { ...raster, level: 0.5 })
    expect([...backend.pages.keys()]).toEqual(['p#0@2'])

    expect((await assets.renderPdfPage('asset:p', 0, 2)).level).toBe(2)
    expect(opened).toEqual([])
    // 違う level は、PDF を開いて描く
    await assets.renderPdfPage('asset:p', 0, 4)
    expect(opened).toEqual(['/api/assets/p'])
  })
})
