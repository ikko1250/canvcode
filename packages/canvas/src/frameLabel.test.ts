import { describe, expect, it } from 'vitest'
import { Editor } from './editor.ts'
import { drawNodes, type Viewport } from './renderer.ts'

// フレームの名前は、ほかのノードを描いたあとに描き（隠れない）、当たり判定でも先に見る

function setup() {
  const editor = new Editor({ canvasId: 'canvas:1' })
  const frame = editor.makeNode('frame', { x: 0, y: 0, props: { w: 400, h: 300, name: 'フレーム' } })
  // フレームより手前（あと）にあって、フレームの名前（枠の左上の上）に重なる図形
  const geo = editor.makeNode('geo', { x: -20, y: -60, props: { shape: 'rect', w: 200, h: 80 } })
  editor.createNodes([frame, geo])
  return { editor, frame: frame.id, geo: geo.id }
}

// 描いたもの（塗り・文字）を順に記録する ctx
function recordingContext() {
  const calls: string[] = []
  const stack: Record<string, unknown>[] = []
  const ctx = new Proxy({ globalAlpha: 1 } as Record<string, unknown>, {
    get(target, key) {
      if (key === 'fillText') return (text: string) => calls.push(`text:${text}`)
      if (key === 'fillRect' || key === 'fill') return () => calls.push('fill')
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
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

describe('frame labels', () => {
  const view: Viewport = { camera: { x: -100, y: -100, zoom: 1 }, width: 800, height: 600, dpr: 1 }

  it('draws the label after every node, so a node in front does not cover it', () => {
    const { editor } = setup()
    const { ctx, calls } = recordingContext()
    drawNodes(ctx, editor, editor.index.sortByOrder([...editor.index.nodeIds()]), view)
    expect(calls.at(-1)).toBe('text:フレーム')
    expect(calls.filter((call) => call === 'fill').length).toBeGreaterThanOrEqual(2)
  })

  it('hits the label before a node in front of it', () => {
    const { editor, frame, geo } = setup()
    // 名前の部分（枠の左上の上）
    expect(editor.hitTest({ x: 10, y: -8 }, 0)?.id).toBe(frame)
    // 名前の外は、手前の図形
    expect(editor.hitTest({ x: 150, y: -8 }, 0)?.id).toBe(geo)
    expect(editor.hitTest({ x: 10, y: -40 }, 0)?.id).toBe(geo)
  })

  it('does not hit the label of a locked frame', () => {
    const { editor, geo, frame } = setup()
    editor.transact('lock', (tx) => tx.update(frame, (node) => ({ ...node, locked: true })))
    expect(editor.hitTest({ x: 10, y: -8 }, 0)?.id).toBe(geo)
  })
})
