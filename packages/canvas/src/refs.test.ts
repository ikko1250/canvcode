import type { Box } from '@canvcode/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canvasRefTarget,
  fetchReference,
  postReference,
  putReferenceImage,
  refImageRegion,
  refImageSize,
  type CanvasRefSource,
  type RefImageSource,
} from './refs.ts'

// AI に渡す参照（ref）を作る

const bounds: Record<string, Box> = {
  'node:a': { x: 0, y: 0, w: 100, h: 50 },
  'node:b': { x: 200, y: 100, w: 50.004, h: 50 },
}

function source(fields: Partial<CanvasRefSource>): CanvasRefSource {
  return {
    canvasId: 'canvas:c',
    selectedIds: new Set(),
    lastBrush: null,
    boundsOf: (id) => bounds[id],
    nodesInBrush: () => [],
    ...fields,
  }
}

describe('canvasRefTarget', () => {
  it('uses the box around the selected nodes', () => {
    expect(canvasRefTarget(source({ selectedIds: new Set(['node:a', 'node:b']) }))).toEqual({
      kind: 'canvas',
      canvasId: 'canvas:c',
      rect: { x: 0, y: 0, w: 250, h: 150 },
      nodes: [
        { id: 'node:a', bounds: bounds['node:a'] },
        { id: 'node:b', bounds: { x: 200, y: 100, w: 50, h: 50 } },
      ],
    })
  })

  it('uses the last brush while the selection is what the brush picked', () => {
    const rect = { x: -10, y: -10, w: 150, h: 90 }
    const picked = new Set(['node:a'])
    expect(canvasRefTarget(source({ selectedIds: picked, lastBrush: { rect, ids: picked } }))?.rect).toEqual(rect)
    // 範囲選択のあとで選択を変えたら、選んでいるノードを囲む箱
    const changed = source({ selectedIds: new Set(['node:b']), lastBrush: { rect, ids: picked } })
    expect(canvasRefTarget(changed)?.rect).toEqual({ x: 200, y: 100, w: 50, h: 50 })
  })

  it('uses the last brush after a right-click on the empty canvas cleared the selection', () => {
    const rect = { x: -10, y: -10, w: 150, h: 90 }
    const target = canvasRefTarget(source({ lastBrush: { rect, ids: new Set(['node:a']) }, nodesInBrush: () => ['node:a'] }))
    expect(target).toEqual({ kind: 'canvas', canvasId: 'canvas:c', rect, nodes: [{ id: 'node:a', bounds: bounds['node:a'] }] })
  })

  it('keeps a brushed empty area, and is null without a selection or brush', () => {
    const rect = { x: 500, y: 500, w: 10, h: 10 }
    expect(canvasRefTarget(source({ lastBrush: { rect, ids: new Set() } }))).toEqual({ kind: 'canvas', canvasId: 'canvas:c', rect, nodes: [] })
    expect(canvasRefTarget(source({}))).toBeNull()
  })
})

describe('postReference', () => {
  afterEach(() => vi.unstubAllGlobals())
  const target = { kind: 'lines', fileId: 'file:a', startLine: 1, endLine: 1, snapshot: 'x' } as const

  it('saves the reference with the given id', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 201 }))
    vi.stubGlobal('fetch', fetch)
    const saved = await postReference(target, 'ref:Ab12Cd34Ef')
    expect(saved).toMatchObject({ ...target, typeName: 'ref', id: 'ref:Ab12Cd34Ef' })
    expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ id: 'ref:Ab12Cd34Ef' })
  })

  it('retries once with a new id when the id is taken', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 409 })).mockResolvedValueOnce(new Response('{}', { status: 201 }))
    vi.stubGlobal('fetch', fetch)
    const saved = await postReference(target, 'ref:Ab12Cd34Ef')
    expect(saved.id).not.toBe('ref:Ab12Cd34Ef')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('throws when the server refuses it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 400 })))
    await expect(postReference(target, 'ref:Ab12Cd34Ef')).rejects.toThrow('400')
  })

  it('reads a reference, and returns null for an unknown one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"id":"ref:Ab12Cd34Ef"}', { status: 200 })))
    expect(await fetchReference('ref:Ab12Cd34Ef')).toEqual({ id: 'ref:Ab12Cd34Ef' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
    expect(await fetchReference('ref:Zz99Zz99Zz')).toBeNull()
  })
})

// ref に添える画像（MAI-64）：手書き線や画像のある範囲だけ
describe('refImageRegion', () => {
  // node:group の中に node:draw、node:frame の中に node:image。node:text は文字だけ
  const types: Record<string, string> = {
    'node:text': 'text',
    'node:group': 'group',
    'node:draw': 'draw',
    'node:frame': 'frame',
    'node:image': 'image',
    'node:page': 'pdf-page',
    'node:ink': 'draw',
  }
  const children: Record<string, string[]> = { 'node:group': ['node:draw'], 'node:frame': ['node:image'] }
  function imageSource(inRange: string[], fields: Partial<RefImageSource> = {}): RefImageSource {
    return {
      canvasId: 'canvas:c',
      typeOf: (id) => types[id],
      childrenOf: (id) => children[id] ?? [],
      search: () => inRange,
      pdfPage: () => undefined,
      ...fields,
    }
  }
  const rect = { x: 0, y: 0, w: 200, h: 100 }
  const canvas = (ids: string[]) => ({ kind: 'canvas', canvasId: 'canvas:c', rect, nodes: ids.map((id) => ({ id, bounds: rect })) }) as const

  it('is null for a region with text only', () => {
    expect(refImageRegion(canvas(['node:text']), imageSource(['node:text']))).toBeNull()
    expect(refImageRegion(canvas([]), imageSource([]))).toBeNull()
  })

  it('is the region when it has a freehand stroke or an image, also inside groups and frames', () => {
    expect(refImageRegion(canvas(['node:text', 'node:group']), imageSource([]))).toEqual(rect)
    expect(refImageRegion(canvas(['node:frame']), imageSource([]))).toEqual(rect)
    // 選んでいなくても、範囲に触れていれば画像に写る
    expect(refImageRegion(canvas(['node:text']), imageSource(['node:text', 'node:ink']))).toEqual(rect)
  })

  it('is null for a region of another canvas', () => {
    expect(refImageRegion(canvas(['node:group']), imageSource([], { canvasId: 'canvas:other' }))).toBeNull()
  })

  it('maps a PDF region to the page, and needs a freehand stroke on it', () => {
    const target = { kind: 'pdf', fileId: 'file:pdf', pageIndex: 1, rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.25 }, text: 'x' } as const
    const pdfPage = (fileId: string, pageIndex: number) => (fileId === 'file:pdf' && pageIndex === 1 ? { x: 100, y: 1000, w: 600, h: 800 } : undefined)
    const searched: Box[] = []
    const withInk = imageSource(['node:page', 'node:ink'], { pdfPage, search: (box) => (searched.push(box), ['node:page', 'node:ink']) })
    expect(refImageRegion(target, withInk)).toEqual({ x: 160, y: 1160, w: 300, h: 200 })
    expect(searched).toEqual([{ x: 160, y: 1160, w: 300, h: 200 }])
    // ページだけ（手書き線なし）、画像のノードだけ、ページがこの Canvas にない：添えない
    expect(refImageRegion(target, imageSource(['node:page'], { pdfPage }))).toBeNull()
    expect(refImageRegion(target, imageSource(['node:page', 'node:frame'], { pdfPage }))).toBeNull()
    expect(refImageRegion(target, imageSource(['node:ink']))).toBeNull()
  })

  it('never adds an image to lines', () => {
    expect(refImageRegion({ kind: 'lines', fileId: 'file:a', startLine: 1, endLine: 1, snapshot: 'x' }, imageSource(['node:ink']))).toBeNull()
  })
})

describe('refImageSize', () => {
  it('keeps the long edge within the limit, and does not blow up small regions', () => {
    expect(refImageSize({ x: 0, y: 0, w: 3136, h: 1000 })).toEqual({ width: 1568, height: 500, scale: 0.5 })
    expect(refImageSize({ x: 0, y: 0, w: 1000, h: 4000 }, 1000)).toEqual({ width: 250, height: 1000, scale: 0.25 })
    expect(refImageSize({ x: 0, y: 0, w: 100, h: 50 })).toEqual({ width: 200, height: 100, scale: 2 })
  })
})

describe('putReferenceImage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends the PNG with the region it shows', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 201 }))
    vi.stubGlobal('fetch', fetch)
    const png = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    await putReferenceImage('ref:Ab12Cd34Ef', png, { x: -10.5, y: 20, w: 300, h: 150 })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/refs/ref%3AAb12Cd34Ef/image?x=-10.5&y=20&w=300&h=150')
    expect(init).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/png' }, body: png })
  })

  it('throws when the server refuses it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 415 })))
    await expect(putReferenceImage('ref:Ab12Cd34Ef', new Blob([]), { x: 0, y: 0, w: 1, h: 1 })).rejects.toThrow('415')
  })
})
