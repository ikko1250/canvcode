import { describe, expect, it } from 'vitest'
import { isNodeRecord, type NodeRecord, type Patch } from '@canvcode/core'
import { Editor } from './editor.ts'
import { createFigureFrame, FIGURE_MAX_EDGE, figureFramesTouched, figureRenderBox } from './figures.ts'

// スライドの図にするフレーム（提案 B）：描き直すフレームの見つけ方と、描く範囲

function setup() {
  const editor = new Editor({ canvasId: 'canvas:1' })
  const frame = editor.makeNode('frame', { x: 0, y: 0, props: { w: 400, h: 300, name: '図' } })
  const other = editor.makeNode('frame', { x: 1000, y: 0, props: { w: 400, h: 300, name: '別' } })
  const group = editor.makeNode('group', { x: 10, y: 10, parentId: frame.id })
  const inside = editor.makeNode('geo', { x: 0, y: 0, parentId: group.id, props: { shape: 'rect', w: 50, h: 50 } })
  const outside = editor.makeNode('geo', { x: 600, y: 0, props: { shape: 'rect', w: 50, h: 50 } })
  editor.createNodes([frame, other, group, inside, outside])
  // 次の操作の差分（確定したもの）を集める
  const patches: Patch<NodeRecord>[] = []
  editor.store.listen((event) => {
    if (event.phase !== 'commit') return
    patches.push(new Map([...event.patch].filter(([, change]) => isNodeRecord(change.before) || isNodeRecord(change.after))) as Patch<NodeRecord>)
  })
  const touched = () => {
    const all = new Set<string>()
    for (const patch of patches.splice(0)) for (const id of figureFramesTouched(editor, patch, (id) => id === frame.id)) all.add(id)
    return [...all]
  }
  return { editor, frame, other, inside, outside, touched }
}

describe('figureFramesTouched', () => {
  it('finds the figure frame when a node deep inside it changes', () => {
    const { editor, frame, inside, touched } = setup()
    editor.moveNodes([inside.id], 5, 0)
    expect(touched()).toEqual([frame.id])
  })

  it('ignores nodes outside figure frames, and frames that are not figures', () => {
    const { editor, other, outside, touched } = setup()
    editor.moveNodes([outside.id], 5, 0)
    editor.moveNodes([other.id], 5, 0)
    expect(touched()).toEqual([])
  })

  it('notices nodes that leave the frame or are deleted from it', () => {
    const { editor, frame, inside, touched } = setup()
    editor.transact('out', (tx) => editor.reparent(tx, [inside.id], editor.canvasId))
    expect(touched()).toEqual([frame.id])
    const added = editor.makeNode('geo', { x: 20, y: 20, parentId: frame.id, props: { shape: 'rect', w: 10, h: 10 } })
    editor.createNodes([added])
    expect(touched()).toEqual([frame.id])
    editor.deleteNodes([added.id])
    expect(touched()).toEqual([frame.id])
  })
})

describe('figureRenderBox', () => {
  it('draws the long edge at the figure size and keeps the frame border out', () => {
    const { box, maxEdge } = figureRenderBox({ x: 100, y: 200, w: 400, h: 300 })
    expect(maxEdge).toBe(FIGURE_MAX_EDGE)
    const inset = 400 / FIGURE_MAX_EDGE
    expect(box.x).toBeCloseTo(100 + inset)
    expect(box.y).toBeCloseTo(200 + inset)
    expect(box.w).toBeCloseTo(400 - inset * 2)
    expect(box.h).toBeCloseTo(300 - inset * 2)
  })
})

describe('createFigureFrame', () => {
  it('places a new figure frame below the deck and the other figures, once', () => {
    const { editor, frame } = setup()
    const isFigure = (id: string) => id === frame.id
    const create = () =>
      createFigureFrame(editor, { frameId: 'node:NewFigure', fileId: 'file:deck', w: 920, h: 732, name: '構成', isFigure, fallback: { x: 0, y: 0 } })
    expect(create()).toBe(true)
    // 図のフレーム（0, 0, 400×300）の下に 160 空けて置く。図でない「別」のフレームと、外の図形は見ない
    expect(editor.getNode('node:NewFigure')).toMatchObject({ type: 'frame', x: 0, y: 460, props: { w: 920, h: 732, name: '構成' } })
    expect(create()).toBe(false)
  })

  it('centres the frame on the fallback point when nothing related is on the canvas', () => {
    const editor = new Editor({ canvasId: 'canvas:1' })
    createFigureFrame(editor, { frameId: 'node:Lonely', fileId: 'file:deck', w: 200, h: 100, name: '図', isFigure: () => false, fallback: { x: 500, y: 500 } })
    expect(editor.getNode('node:Lonely')).toMatchObject({ x: 400, y: 450 })
  })
})
