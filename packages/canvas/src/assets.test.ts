import { describe, expect, it, vi } from 'vitest'
import { AssetManager, type PdfDocument, type PdfService } from './assets.ts'

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
