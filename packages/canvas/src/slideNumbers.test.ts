import { describe, expect, it } from 'vitest'
import { HIDDEN_SLIDE_OPACITY, type SlideProps } from '@canvcode/nodes'
import { Editor } from './editor.ts'
import { drawNodes, type Viewport } from './renderer.ts'

// スライドの番号（スライド v2）。Editor が位置から計算し、描画と当たり判定に渡す

function setup() {
  const editor = new Editor({ canvasId: 'canvas:1' })
  const slide = (x: number, y: number, props: Partial<SlideProps> = {}, parentId?: string) => {
    const node = editor.makeNode('slide', { x, y, parentId, props: { ratio: '16:9', name: '', hidden: false, ...props } })
    editor.createNodes([node])
    return node.id
  }
  const numbers = () => Object.fromEntries(editor.slideNumbers().numbers)
  return { editor, slide, numbers }
}

describe('Editor.slideNumbers', () => {
  it('numbers the slides of the canvas by their position', () => {
    const { editor, slide } = setup()
    const b = slide(2000, 0)
    const a = slide(0, 0)
    const c = slide(0, 2000)
    expect(editor.slideNumbers().order).toEqual([a, b, c])
    expect(editor.slides.number(c)).toBe(3)
    // スライドでないノードや、知らない id は番号なし
    expect(editor.slides.number('node:none')).toBeNull()
  })

  it('renumbers when a slide moves', () => {
    const { editor, slide } = setup()
    const a = slide(0, 0)
    const b = slide(2000, 0)
    expect(editor.slideNumbers().order).toEqual([a, b])
    editor.moveNodes([a], 4000, 0)
    expect(editor.slideNumbers().order).toEqual([b, a])
    expect(editor.slides.number(a)).toBe(2)
    editor.undo()
    expect(editor.slides.number(a)).toBe(1)
  })

  it('skips hidden slides and closes the gap', () => {
    const { editor, slide, numbers } = setup()
    const a = slide(0, 0)
    const b = slide(2000, 0)
    const c = slide(4000, 0)
    editor.setSelection([b])
    editor.toggleSlidesHidden()
    expect(numbers()).toEqual({ [a]: 1, [c]: 2 })
    expect(editor.slides.number(b)).toBeNull()
    editor.toggleSlidesHidden()
    expect(numbers()).toEqual({ [a]: 1, [b]: 2, [c]: 3 })
  })

  it('counts slides inside groups and frames by their world box', () => {
    const { editor, slide } = setup()
    const frame = editor.makeNode('frame', { x: 5000, y: -500, props: { w: 6000, h: 3000, name: 'F' } })
    editor.createNodes([frame])
    const a = slide(0, 0)
    // フレームのローカル座標では左だが、ワールドでは a より右
    const inside = slide(100, 500, {}, frame.id)
    expect(editor.slideNumbers().order).toEqual([a, inside])
    // フレームを動かすと、中のスライドの番号も変わる
    editor.moveNodes([frame.id], -10000, 0)
    expect(editor.slideNumbers().order).toEqual([inside, a])
  })

  it('does not count slides of another canvas', () => {
    const { editor, slide } = setup()
    const a = slide(0, 0)
    const { canvasId } = editor.createPortal({ x: -3000, y: 0 })
    const child = new Editor({ workspace: editor.workspace, canvasId })
    const other = child.makeNode('slide', { x: -9000, y: 0, props: { ratio: '16:9', name: '', hidden: false } })
    const before = editor.slideNumbers()
    child.createNodes([other])
    // 別のキャンバスの変更では計算し直さない
    expect(editor.slideNumbers()).toBe(before)
    expect(editor.slideNumbers().order).toEqual([a])
    expect(child.slideNumbers().order).toEqual([other.id])
    child.dispose()
  })

  it('does not recompute while the store does not change, nor for changes unrelated to slides', () => {
    const { editor, slide } = setup()
    slide(0, 0)
    const first = editor.slideNumbers()
    expect(editor.slideNumbers()).toBe(first)
    const rect = editor.makeNode('geo', { x: 0, y: 3000, props: { shape: 'rect', w: 100, h: 100 } })
    editor.createNodes([rect])
    expect(editor.slideNumbers()).toBe(first)
    editor.moveNodes([rect.id], 10, 0)
    expect(editor.slideNumbers()).toBe(first)
    slide(2000, 0)
    expect(editor.slideNumbers()).not.toBe(first)
    expect(editor.slideNumbers().order).toHaveLength(2)
  })

  it('forgets deleted slides', () => {
    const { editor, slide } = setup()
    const a = slide(0, 0)
    const b = slide(2000, 0)
    editor.deleteNodes([a])
    expect(editor.slideNumbers().order).toEqual([b])
    expect(editor.slides.number(b)).toBe(1)
  })

  it('widens the name hit area to the numbered label', () => {
    const { editor, slide } = setup()
    slide(0, 0)
    const b = slide(2000, 0, { name: 'あ' })
    // 「2. あ」は 4 文字分（12px × 4 + 8）。名前だけ（1 文字）なら 20 まで
    expect(editor.hitTest({ x: 2040, y: -5 }, 0)?.id).toBe(b)
    expect(editor.hitTest({ x: 2060, y: -5 }, 0)).toBeNull()
  })
})

// 描いた文字と、そのときの不透明度を記録する ctx
function recordingContext() {
  const texts: { text: string; alpha: number }[] = []
  const fills: number[] = []
  const state: Record<string, unknown> = { globalAlpha: 1 }
  const stack: Record<string, unknown>[] = []
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key === 'fillText') return (text: string) => texts.push({ text, alpha: target.globalAlpha as number })
      if (key === 'fillRect' || key === 'fill') return () => fills.push(target.globalAlpha as number)
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
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, fills }
}

describe('drawing slides', () => {
  const view: Viewport = { camera: { x: -100, y: -100, zoom: 0.1 }, width: 2000, height: 1000, dpr: 1 }

  it('draws the number before the name, and fades hidden slides with their contents', () => {
    const { editor, slide } = setup()
    const a = slide(0, 0, { name: 'はじめに' })
    slide(2000, 0)
    const hidden = slide(4000, 0, { name: 'メモ', hidden: true })
    const inner = editor.makeNode('geo', { x: 100, y: 100, parentId: hidden, props: { shape: 'rect', w: 400, h: 300 } })
    editor.createNodes([inner])
    const { ctx, texts, fills } = recordingContext()
    drawNodes(ctx, editor, editor.index.sortByOrder([...editor.index.nodeIds()]), view)
    expect(texts.filter((t) => t.alpha === 1).map((t) => t.text)).toEqual(['1. はじめに', '2'])
    expect(texts.find((t) => t.text === '非表示 · メモ')?.alpha).toBeCloseTo(HIDDEN_SLIDE_OPACITY)
    // 子孫もまとめて薄くする（スライドの白い地と、中の図形の塗り）。表示するスライドの地は薄くしない
    expect(fills.filter((alpha) => alpha === 1)).toHaveLength(2)
    expect(fills.filter((alpha) => alpha < 1).length).toBeGreaterThanOrEqual(2)
    for (const alpha of fills.filter((alpha) => alpha < 1)) expect(alpha).toBeCloseTo(HIDDEN_SLIDE_OPACITY)
    expect(editor.slides.number(a)).toBe(1)
  })
})
