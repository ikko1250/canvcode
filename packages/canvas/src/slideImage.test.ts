import { describe, expect, it } from 'vitest'
import type { SlideProps } from '@canvcode/nodes'
import { Editor } from './editor.ts'
import { drawNodes, visibleIds, type Viewport } from './renderer.ts'
import { SLIDE_IMAGE_SCALE, slideImageRegion } from './slideImage.ts'

// PDF に出すスライドの画像（スライド v2）。描く範囲・倍率・描くノードと、印刷用の描き方

function setup() {
  const editor = new Editor({ canvasId: 'canvas:1' })
  const slide = (x: number, y: number, props: Partial<SlideProps> = {}, parentId?: string) => {
    const node = editor.makeNode('slide', { x, y, parentId, props: { ratio: '16:9', name: '', hidden: false, ...props } })
    editor.createNodes([node])
    return node.id
  }
  const rect = (x: number, y: number, parentId?: string) => {
    const node = editor.makeNode('geo', { x, y, parentId, props: { shape: 'rect', w: 400, h: 300 } })
    editor.createNodes([node])
    return node.id
  }
  return { editor, slide, rect }
}

describe('slideImageRegion', () => {
  it('covers exactly the slide at twice the scale', () => {
    const { editor, slide } = setup()
    const wide = slide(100, 200)
    const square = slide(3000, 200, { ratio: '4:3' })
    expect(SLIDE_IMAGE_SCALE).toBe(2)
    const a = slideImageRegion(editor, wide)!
    expect(a.box).toEqual({ x: 100, y: 200, w: 1920, h: 1080 })
    expect(a).toMatchObject({ scale: 2, width: 3840, height: 2160, size: { w: 1920, h: 1080 } })
    const b = slideImageRegion(editor, square)!
    expect(b.box).toEqual({ x: 3000, y: 200, w: 1440, h: 1080 })
    expect(b).toMatchObject({ width: 2880, height: 2160, size: { w: 1440, h: 1080 } })
  })

  it('draws only the slide and its descendants', () => {
    const { editor, slide, rect } = setup()
    const s = slide(0, 0)
    const inner = rect(100, 100, s)
    const group = editor.makeNode('group', { x: 500, y: 500, parentId: s, props: {} })
    editor.createNodes([group])
    const deep = rect(0, 0, group.id)
    // スライドの上に重なっているが、子ではないノード
    const over = rect(200, 200)
    const region = slideImageRegion(editor, s)!
    expect([...region.only].sort()).toEqual([s, inner, group.id, deep].sort())
    expect(region.only.has(over)).toBe(false)
  })

  it('returns null for a missing node or a node that is not a slide', () => {
    const { editor, rect } = setup()
    const frame = editor.makeNode('frame', { x: 0, y: 0, props: { w: 1920, h: 1080, name: 'F' } })
    editor.createNodes([frame])
    expect(slideImageRegion(editor, 'node:none')).toBeNull()
    expect(slideImageRegion(editor, frame.id)).toBeNull()
    expect(slideImageRegion(editor, rect(0, 0))).toBeNull()
  })

  it('keeps hidden slides (the caller decides whether to export them)', () => {
    const { editor, slide } = setup()
    const hidden = slide(0, 0, { hidden: true })
    expect(slideImageRegion(editor, hidden)?.width).toBe(3840)
  })
})

// 描いた文字・塗り・線と、そのときの不透明度を記録する ctx
function recordingContext() {
  const texts: string[] = []
  const fills: number[] = []
  const strokes: number[] = []
  const state: Record<string, unknown> = { globalAlpha: 1 }
  const stack: Record<string, unknown>[] = []
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key === 'fillText') return (text: string) => texts.push(text)
      if (key === 'fillRect' || key === 'fill') return () => fills.push(target.globalAlpha as number)
      if (key === 'strokeRect' || key === 'stroke') return () => strokes.push(target.globalAlpha as number)
      if (key === 'save') return () => stack.push({ ...target })
      if (key === 'restore') return () => Object.assign(target, stack.pop())
      if (key === 'measureText') return (text: string) => ({ width: text.length * 10 })
      if (key in target) return target[key as string]
      return () => {}
    },
    set(target, key, value) {
      target[key as string] = value
      return true
    },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, fills, strokes }
}

describe('drawing a slide for print', () => {
  // renderRegion と同じく、スライドの範囲を描く倍率のカメラで、only のノードだけを描く
  function draw(editor: Editor, slideId: string, print: boolean) {
    const region = slideImageRegion(editor, slideId)!
    const view: Viewport = {
      camera: { x: region.box.x, y: region.box.y, zoom: region.scale },
      width: region.width,
      height: region.height,
      dpr: 1,
      print,
    }
    const recorded = recordingContext()
    drawNodes(recorded.ctx, editor, visibleIds(editor, view).filter((id) => region.only.has(id)), view)
    return recorded
  }

  it('draws neither the numbered name nor the border, but keeps the white ground', () => {
    const { editor, slide, rect } = setup()
    const s = slide(0, 0, { name: 'はじめに' })
    rect(100, 100, s)
    const screen = draw(editor, s, false)
    expect(screen.texts).toEqual(['1. はじめに'])
    expect(screen.strokes.length).toBeGreaterThan(0)
    const print = draw(editor, s, true)
    expect(print.texts).toEqual([])
    // 図形（rect）の線は描く。スライドの枠の線だけを描かない
    expect(print.strokes).toHaveLength(screen.strokes.length - 1)
    // スライドの白い地と、中の図形の塗り
    expect(print.fills).toEqual(screen.fills)
  })

  it('does not fade hidden slides nor their contents', () => {
    const { editor, slide, rect } = setup()
    const hidden = slide(0, 0, { name: 'メモ', hidden: true })
    rect(100, 100, hidden)
    expect(draw(editor, hidden, false).fills.every((alpha) => alpha < 1)).toBe(true)
    const print = draw(editor, hidden, true)
    expect(print.texts).toEqual([])
    expect(print.fills.length).toBeGreaterThanOrEqual(2)
    expect(print.fills.every((alpha) => alpha === 1)).toBe(true)
  })
})
