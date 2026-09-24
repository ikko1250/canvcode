import type { Box } from '@canvcode/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canvasRefTarget, fetchReference, postReference, type CanvasRefSource } from './refs.ts'

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
