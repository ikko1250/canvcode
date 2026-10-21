import { describe, expect, it } from 'vitest'
import { MemoryPdfPageBackend, PdfPageStore, type PdfPageBackend } from './pdfPageStore.ts'

// 最後に見た PDF のページの画像（Issue #26）

function page(hash: string, pageIndex: number, bytes: number, level = 2) {
  return { hash, pageIndex, level, width: 10, height: 10, blob: new Blob([new Uint8Array(bytes)]) }
}

function setup(options: { maxEntries?: number; maxBytes?: number } = {}) {
  const backend = new MemoryPdfPageBackend()
  let now = 0
  const store = new PdfPageStore(backend, { ...options, now: () => ++now })
  return { backend, store }
}

describe('PdfPageStore', () => {
  it('returns a kept page only for the same level', async () => {
    const { store } = setup()
    await store.save(page('h', 3, 5, 2))
    expect((await store.load('h', 3, 2))?.bytes).toBe(5)
    expect(await store.load('h', 3, 1)).toBeNull()
    expect(await store.load('h', 4, 2)).toBeNull()
  })

  it('removes the least recently used pages over the count limit', async () => {
    const { backend, store } = setup({ maxEntries: 2 })
    await store.save(page('h', 0, 1))
    await store.save(page('h', 1, 1))
    // 0 を使い直したので、いちばん古いのは 1
    await store.load('h', 0, 2)
    await store.save(page('h', 2, 1))
    expect([...backend.pages.keys()].sort()).toEqual(['h#0@2', 'h#2@2'])
  })

  it('removes old pages over the byte limit, but keeps the one just saved', async () => {
    const { backend, store } = setup({ maxBytes: 10 })
    await store.save(page('h', 0, 4))
    await store.save(page('h', 1, 4))
    await store.save(page('h', 2, 4))
    expect([...backend.pages.keys()].sort()).toEqual(['h#1@2', 'h#2@2'])
    await store.save(page('h', 3, 20))
    expect([...backend.pages.keys()]).toEqual(['h#3@2'])
  })

  it('goes on without the pages when the backend fails', async () => {
    const failing: PdfPageBackend = {
      get: () => Promise.reject(new Error('no db')),
      put: () => Promise.reject(new Error('no db')),
      delete: () => Promise.reject(new Error('no db')),
      list: () => Promise.reject(new Error('no db')),
    }
    const store = new PdfPageStore(failing)
    expect(await store.load('h', 0, 1)).toBeNull()
    await expect(store.save(page('h', 0, 1))).resolves.toBeUndefined()
  })
})
