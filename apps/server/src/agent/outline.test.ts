import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RecordStore } from '../records.ts'
import { listCanvases, readCanvas, readNodes } from './outline.ts'

// AI に Canvas の上のものを読ませる（list_canvases・read_canvas・read_nodes）

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function setup(): RecordStore {
  const dir = mkdtempSync(join(tmpdir(), 'canvcode-outline-'))
  const records = new RecordStore(dir)
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  cleanups.push(() => records.close())
  return records
}

const node = (id: string, type: string, parentId: string, index: string, props: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  typeName: 'node',
  id,
  type,
  parentId,
  x: 0,
  y: 0,
  rotation: 0,
  index,
  opacity: 1,
  locked: false,
  props,
  meta: {},
  ...extra,
})

const canvas = (id: string, title: string, parentCanvasId: string | null, extra: Record<string, unknown> = {}) => ({
  typeName: 'canvas',
  id,
  title,
  parentCanvasId,
  ownerNodeId: null,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  trash: null,
  ...extra,
})

function sample(records: RecordStore): string {
  const root = records.rootCanvasId
  records.apply(
    [
      node('node:note', 'note', root, 'a1', { paragraphs: [{ runs: [{ text: '課題：' }, { text: '同期が遅い' }] }], w: 200, h: 120 }),
      node('node:rect', 'geo', root, 'a2', { shape: 'rect', w: 120, h: 80, label: '対策', fill: { type: 'solid', color: '#e8eefc', opacity: 1 } }, { x: 280 }),
      node('node:arrow', 'arrow', root, 'a3', { start: { x: 200, y: 60 }, end: { x: 280, y: 40 }, label: '原因' }),
      { typeName: 'binding', id: 'binding:1', type: 'arrow', fromId: 'node:arrow', toId: 'node:note', props: { terminal: 'start', normalizedAnchor: { x: 1, y: 0.5 }, isPrecise: false } },
      { typeName: 'binding', id: 'binding:2', type: 'arrow', fromId: 'node:arrow', toId: 'node:rect', props: { terminal: 'end', normalizedAnchor: { x: 0, y: 0.5 }, isPrecise: false } },
      // 回したフレームの中の付箋は、ワールド座標で出す
      node('node:frame', 'frame', root, 'a4', { name: 'フェーズ1', w: 800, h: 600 }, { x: 0, y: 400, rotation: Math.PI / 2 }),
      node('node:inner', 'note', 'node:frame', 'a1', { text: '中の付箋', w: 100, h: 100 }, { x: 10, y: 20 }),
      node('node:portal', 'portal', root, 'a5', { targetId: 'canvas:child', role: 'owner', w: 240, h: 170 }, { x: 900, locked: true }),
      canvas('canvas:child', '設計メモ', root, { ownerNodeId: 'node:portal' }),
      canvas('canvas:loose', '未整理', null),
      canvas('canvas:old', '古い', null, { deletedAt: 1 }),
      node('node:c1', 'text', 'canvas:child', 'a1', { text: 'こんにちは', fontSize: 20, autoWidth: true }),
    ],
    [],
  )
  return root
}

describe('canvas outline', () => {
  it('lists the canvas tree with node counts', () => {
    const records = setup()
    const root = sample(records)
    const out = listCanvases(records)
    expect(out.split('\n')).toEqual([
      `rev=${records.rev} canvases=3`,
      `${root} "ホーム" nodes=6`,
      '  canvas:child "設計メモ" nodes=1',
      'unplaced:',
      '  canvas:loose "未整理" nodes=0',
      'trash: 1 canvases (not listed)',
    ])
    expect(listCanvases(records, 'メモ').split('\n')[1]).toBe('canvas:child "設計メモ" nodes=1 path="ホーム/設計メモ"')
  })

  it('reads a canvas as one line per node in world coordinates', () => {
    const records = setup()
    const root = sample(records)
    const lines = readCanvas(records, {}).split('\n')
    expect(lines).toEqual([
      `${root} "ホーム" rev=${records.rev} nodes=6 shown=5`,
      'node:note note 0,0 200x120 "課題：同期が遅い"',
      'node:rect geo/rect 280,0 120x80 fill=#e8eefc "対策"',
      'node:arrow arrow node:note→node:rect "原因"',
      'node:frame frame 0,400 800x600 rot=90 "フェーズ1" [1 children]',
      'node:portal portal 900,0 240x170 canvas:child "設計メモ" locked',
    ])
    // depth で group / frame の中を開く。回したフレームの中の (10, 20) は、ワールドでは (-20, 410)
    expect(readCanvas(records, { depth: 1 }).split('\n')).toContain('  node:inner note -20,410 100x100 rot=90 "中の付箋"')
  })

  it('filters by query, types and rect, and searches inside frames', () => {
    const records = setup()
    sample(records)
    const byQuery = readCanvas(records, { query: '付箋' }).split('\n')
    expect(byQuery[0]).toContain('matched=1')
    expect(byQuery[1]).toBe('node:inner note -20,410 100x100 rot=90 "中の付箋" in=node:frame')
    expect(readCanvas(records, { types: ['geo/rect', 'arrow'] }).split('\n').slice(1).map((l) => l.split(' ')[0])).toEqual(['node:rect', 'node:arrow'])
    expect(readCanvas(records, { rect: { x: 850, y: -10, w: 100, h: 100 } }).split('\n').slice(1).map((l) => l.split(' ')[0])).toEqual(['node:portal'])
  })

  it('pages with a cursor', () => {
    const records = setup()
    sample(records)
    const first = readCanvas(records, { limit: 2 }).split('\n')
    expect(first[0]).toMatch(/shown=2 next=2$/)
    const second = readCanvas(records, { limit: 2, cursor: '2' }).split('\n')
    expect(second[1]).toMatch(/^node:arrow /)
    expect(() => readCanvas(records, { cursor: 'x' })).toThrow('Invalid cursor')
    expect(() => readCanvas(records, { canvasId: 'canvas:nope' })).toThrow('list_canvases')
  })

  it('returns only what changed since a rev, and the deleted ids', () => {
    const records = setup()
    sample(records)
    const rev = records.rev
    records.apply([node('node:rect', 'geo', records.rootCanvasId, 'a2', { shape: 'ellipse', w: 10, h: 10, label: '' })], ['node:note', 'binding:1'])
    const lines = readCanvas(records, { since: rev }).split('\n')
    expect(lines[0]).toContain('matched=1')
    expect(lines[1]).toBe('deleted=node:note')
    expect(lines[2]).toMatch(/^node:rect geo\/ellipse /)
    // 矢印のつながりが変わった矢印も出す
    const rev2 = records.rev
    records.apply([{ typeName: 'binding', id: 'binding:2', type: 'arrow', fromId: 'node:arrow', toId: 'node:portal', props: { terminal: 'end', normalizedAnchor: { x: 0, y: 0 }, isPrecise: false } }], [])
    expect(readCanvas(records, { since: rev2 }).split('\n').slice(1)).toEqual(['node:arrow arrow 200,60→node:portal "原因"'])
  })

  it('reads node details as compact, AI-friendly JSON', () => {
    const records = setup()
    sample(records)
    const { nodes, missing } = readNodes(records, ['node:note', 'node:inner', 'node:arrow', 'node:c1', 'node:nope'])
    expect(missing).toEqual(['node:nope'])
    expect(nodes[0]).toMatchObject({ id: 'node:note', type: 'note', x: 0, y: 0, w: 200, h: 120, text: '課題：同期が遅い' })
    expect(nodes[1]).toMatchObject({ id: 'node:inner', parent: 'node:frame', x: -20, y: 410, rotation: 90, text: '中の付箋' })
    expect(nodes[1]!.canvas).toBe(records.rootCanvasId)
    expect(nodes[2]).toMatchObject({ start: { x: 200, y: 60, node: 'node:note' }, end: { x: 280, y: 40, node: 'node:rect' }, label: '原因' })
    expect(nodes[3]).toMatchObject({ canvas: 'canvas:child', text: 'こんにちは', sizeEstimated: true })
  })
})
