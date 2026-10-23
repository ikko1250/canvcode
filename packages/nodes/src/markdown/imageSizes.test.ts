// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

// 高さを中身に合わせる Markdown カードが、画像の大きさがわかってから測り直す（#33）

// fetch した画像（src → 結果を決める関数）。fetch が返すまで待たせ、テストの中で読めた・読めなかったを決める
const fetches = new Map<string, { resolve: (size: { width: number; height: number }) => void; reject: () => void }>()
// object URL → 画像（中身は大きさの JSON）
const blobs = new Map<string, Blob>()
let nextUrl = 0

vi.stubGlobal('fetch', (src: string) =>
  new Promise((resolve, reject) => {
    fetches.set(src, {
      resolve: (size) => resolve({ ok: true, blob: async () => new Blob([JSON.stringify(size)]) }),
      reject: () => reject(new TypeError('Failed to fetch')),
    })
  }),
)
URL.createObjectURL = (blob: Blob) => {
  const url = `blob:${nextUrl++}`
  blobs.set(url, blob)
  return url
}
URL.revokeObjectURL = () => {}

class FakeImage {
  naturalWidth = 0
  naturalHeight = 0
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  set src(url: string) {
    const blob = blobs.get(url)
    if (!blob) {
      setTimeout(() => this.onerror?.(), 0)
      return
    }
    void blob.text().then((text) => {
      const size = JSON.parse(text) as { width: number; height: number }
      this.naturalWidth = size.width
      this.naturalHeight = size.height
      this.onload?.()
    })
  }
}

vi.stubGlobal('Image', FakeImage)

// 画像の大きさがわかっていれば、その高さを足した高さを返す（jsdom ではレイアウトできないので、測り方は差し替える）
vi.mock('./layout.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./layout.ts')>()),
  measureCardHeight: (options: { html: string; imageSize?: (src: string) => { width: number; height: number } | null | undefined }) => {
    let height = 100
    for (const [, src] of options.html.matchAll(/<img src="([^"]+)"/g)) height += options.imageSize?.(src)?.height ?? 0
    return height
  },
}))

const { markdownImageSize, onMarkdownImageSize } = await import('./imageSizes.ts')
const { createMarkdownCardType } = await import('./markdownCard.ts')

const flush = () => new Promise((resolve) => setTimeout(resolve, 10))

afterEach(() => fetches.clear())

describe('markdownImageSize', () => {
  it('starts loading once, then returns the natural size and notifies once for images found together', async () => {
    const listener = vi.fn()
    const off = onMarkdownImageSize(listener)
    expect(markdownImageSize('/a.png')).toBeUndefined()
    expect(markdownImageSize('/a.png')).toBeUndefined()
    expect(markdownImageSize('/b.png')).toBeUndefined()
    expect([...fetches.keys()]).toEqual(['/a.png', '/b.png'])

    fetches.get('/a.png')!.resolve({ width: 640, height: 480 })
    fetches.get('/b.png')!.resolve({ width: 10, height: 20 })
    await flush()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(markdownImageSize('/a.png')).toEqual({ width: 640, height: 480 })
    expect(markdownImageSize('/b.png')).toEqual({ width: 10, height: 20 })
    off()
  })

  // fetch で読めない画像（CORS を許さないサイトなど）は、カードを描くときに代わりの文字になるので、高さを取らない
  it('remembers images that fetch cannot read as null', async () => {
    markdownImageSize('https://example.com/no-cors.png')
    fetches.get('https://example.com/no-cors.png')!.reject()
    await flush()
    expect(markdownImageSize('https://example.com/no-cors.png')).toBeNull()
    expect(fetches.size).toBe(1)
  })

  it('keeps every size it has read, so that waiting cards do not load them again', async () => {
    const srcs = Array.from({ length: 600 }, (_, i) => `/many/${i}.png`)
    for (const src of srcs) markdownImageSize(src)
    for (const src of srcs) fetches.get(src)!.resolve({ width: 1, height: 1 })
    await flush()
    fetches.clear()
    for (const src of srcs) expect(markdownImageSize(src)).toEqual({ width: 1, height: 1 })
    expect(fetches.size).toBe(0)
  })
})

describe('markdown card height with images', () => {
  it('measures again when the size of an image becomes known', async () => {
    const files = { get: () => ({ text: '![](/.canvcode/assets/ab12.png)\n\n最後の行', version: 'v1', path: 'a.md' }) }
    const type = createMarkdownCardType({ embedCss: async () => '', measureCss: '', files })
    const node = { id: 'n', typeName: 'node', type: 'markdown-card', parentId: 'c', index: 'a0', x: 0, y: 0, rotation: 0, locked: false, opacity: 1, props: { fileId: 'file:a', w: 480, h: 320, sizing: 'auto' as const, role: 'owner' as const } }
    const refreshed = vi.fn(() => type.getBounds(node as never).h)
    onMarkdownImageSize(refreshed)

    // 画像の大きさがわかるまでは、画像を 0 として測る
    expect(type.getBounds(node as never).h).toBe(100)
    fetches.get('/api/workspace/.canvcode/assets/ab12.png')!.resolve({ width: 300, height: 150 })
    await flush()
    // 画面への知らせの時点で、カードはもう測り直せる
    expect(refreshed).toHaveReturnedWith(250)
    expect(type.getBounds(node as never).h).toBe(250)
  })
})
