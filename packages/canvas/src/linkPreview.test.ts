import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssetRecord } from '@canvcode/core'
import type { AssetManager } from './assets.ts'
import { insertLinkCard } from './clipboard.ts'
import { Editor } from './editor.ts'
import { LinkPreviewer } from './linkPreview.ts'

// リンクのカードに、サーバーが取ってきたタイトル・サムネイルを書き込む

const asset: AssetRecord = { typeName: 'asset', id: 'asset:thumb', mime: 'image/png', size: 10, hash: 'thumb', width: 1200, height: 630, variants: [256, 1024] }

function setup(responses: Record<string, () => Response>) {
  const editor = new Editor({ canvasId: 'canvas:1' })
  const importImage = vi.fn(async () => asset)
  const previewer = new LinkPreviewer({ importImage } as unknown as AssetManager)
  const unlisten = editor.store.listen((event) => previewer.watch(editor, event))
  const fetch = vi.fn(async (input: string) => {
    const key = Object.keys(responses).find((prefix) => input.startsWith(prefix))
    return key ? responses[key]() : new Response('', { status: 404 })
  })
  vi.stubGlobal('fetch', fetch)
  return { editor, previewer, fetch, importImage, unlisten }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('link previews', () => {
  it('fills in the title, description and thumbnail of a pasted link, outside the undo history', async () => {
    const { editor, previewer, fetch, importImage } = setup({
      '/api/link-preview/image?': () => new Response(new Blob([new Uint8Array(4)], { type: 'image/png' })),
      '/api/link-preview?': () => Response.json({ title: ' Example ', description: 'About it', siteName: null, image: 'https://example.com/og.png' }),
    })
    const id = insertLinkCard(editor, 'https://example.com/page', { x: 0, y: 0 })
    await previewer.settled()
    expect(fetch).toHaveBeenCalledWith('/api/link-preview?url=https%3A%2F%2Fexample.com%2Fpage')
    expect(fetch).toHaveBeenCalledWith('/api/link-preview/image?url=https%3A%2F%2Fexample.com%2Fog.png')
    expect(importImage).toHaveBeenCalledOnce()
    expect(editor.getNode(id)!.props).toMatchObject({
      title: 'Example',
      description: 'About it',
      siteName: null,
      image: { assetId: 'asset:thumb', aspect: 630 / 1200 },
      status: 'done',
    })
    // Undo すると貼り付けそのものが消え、Redo するとタイトルなどの入ったカードが戻る（取り直さない）
    editor.undo()
    expect(editor.getNode(id)).toBeUndefined()
    editor.redo()
    expect(editor.getNode(id)!.props).toMatchObject({ title: 'Example', status: 'done' })
    await previewer.settled()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps a URL-only card when the page cannot be read', async () => {
    const { editor, previewer, importImage } = setup({ '/api/link-preview?': () => new Response('{}', { status: 502 }) })
    const id = insertLinkCard(editor, 'https://example.com/missing', { x: 0, y: 0 })
    await previewer.settled()
    expect(editor.getNode(id)!.props).toMatchObject({ title: null, image: null, status: 'failed' })
    expect(importImage).not.toHaveBeenCalled()
  })

  it('skips the thumbnail when it is not an image, and does nothing for a card deleted meanwhile', async () => {
    const { editor, previewer } = setup({
      '/api/link-preview/image?': () => new Response('{}', { status: 415 }),
      '/api/link-preview?': () => Response.json({ title: 'T', description: null, siteName: 'Site', image: 'https://example.com/x' }),
    })
    const kept = insertLinkCard(editor, 'https://example.com/a', { x: 0, y: 0 })
    const deleted = insertLinkCard(editor, 'https://example.com/b', { x: 0, y: 0 })
    editor.transact('delete', (tx) => tx.remove(deleted))
    await previewer.settled()
    expect(editor.getNode(kept)!.props).toMatchObject({ title: 'T', siteName: 'Site', image: null, status: 'done' })
    expect(editor.getNode(deleted)).toBeUndefined()
  })

  it('tries the next thumbnail candidate when one fails or is too small, and keeps the site icon', async () => {
    const { editor, previewer, importImage } = setup({
      '/api/link-preview/image?url=https%3A%2F%2Fexample.com%2Fmissing.jpg': () => new Response('{}', { status: 502 }),
      '/api/link-preview/image?': () => new Response(new Blob([new Uint8Array(4)], { type: 'image/png' })),
      '/api/link-preview?': () =>
        Response.json({ title: 'T', description: null, siteName: null, image: 'https://example.com/missing.jpg', images: ['https://example.com/missing.jpg', 'https://example.com/small.png', 'https://example.com/big.png'], icons: ['https://example.com/apple.png'] }),
    })
    const small: AssetRecord = { ...asset, id: 'asset:small', hash: 'small', width: 40, height: 40, variants: [] }
    const icon: AssetRecord = { ...asset, id: 'asset:icon', hash: 'icon', width: 180, height: 180, variants: [] }
    importImage.mockResolvedValueOnce(small).mockResolvedValueOnce(asset).mockResolvedValueOnce(icon)
    const id = insertLinkCard(editor, 'https://example.com/page', { x: 0, y: 0 })
    await previewer.settled()
    expect(editor.getNode(id)!.props).toMatchObject({ image: { assetId: 'asset:thumb' }, icon: { assetId: 'asset:icon', size: 180 }, status: 'done' })
    expect(importImage).toHaveBeenCalledTimes(3)
  })
})
