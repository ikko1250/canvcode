import { describe, expect, it } from 'vitest'
import type { SlideProps } from '@canvcode/nodes'
import { Editor } from './editor.ts'
import { slideTopLeft, toggledSlideRatio, toggledSlidesHidden } from './slideEdit.ts'

// スライド（スライド v2）を置く・比率を切り替える・非表示にする（パイメニューから使う）

describe('slideEdit', () => {
  it('centers a slide on the point', () => {
    expect(slideTopLeft({ x: 1000, y: 600 }, '16:9')).toEqual({ x: 40, y: 60 })
    expect(slideTopLeft({ x: 1000, y: 600 }, '4:3')).toEqual({ x: 280, y: 60 })
  })

  it('toggles the ratio between 16:9 and 4:3', () => {
    expect(toggledSlideRatio('16:9')).toBe('4:3')
    expect(toggledSlideRatio('4:3')).toBe('16:9')
    // 知らない値は 16:9 として扱う
    expect(toggledSlideRatio('1:1' as SlideProps['ratio'])).toBe('4:3')
  })

  it('hides all if any is shown, and shows all only when all are hidden', () => {
    expect(toggledSlidesHidden([{ hidden: false }])).toBe(true)
    expect(toggledSlidesHidden([{ hidden: true }])).toBe(false)
    expect(toggledSlidesHidden([{ hidden: true }, { hidden: false }])).toBe(true)
    expect(toggledSlidesHidden([{ hidden: true }, { hidden: true }])).toBe(false)
  })
})

describe('editor slides', () => {
  const slide = (editor: Editor, id: string) => editor.getNode(id)!.props as SlideProps

  it('creates a slide centered on the point directly under the canvas, selects it, and undoes in one step', () => {
    const editor = new Editor({ canvasId: 'canvas:1' })
    const frame = editor.makeNode('frame', { x: 0, y: 0, props: { w: 4000, h: 4000, name: 'F' } })
    editor.createNodes([frame])
    editor.setSelection([frame.id])
    const id = editor.createSlide({ x: 1000, y: 600 }, '4:3')
    const node = editor.getNode(id)!
    // フレームの上でも、フレームの中には入れない
    expect(node).toMatchObject({ type: 'slide', parentId: 'canvas:1', x: 280, y: 60 })
    expect(node.props).toEqual({ ratio: '4:3', name: '', hidden: false })
    expect([...editor.session.get().selectedIds]).toEqual([id])

    editor.undo()
    expect(editor.getNode(id)).toBeUndefined()
    expect([...editor.session.get().selectedIds]).toEqual([frame.id])
  })

  it('toggles the ratio of each selected slide, keeping the top-left, and undoes in one step', () => {
    const editor = new Editor({ canvasId: 'canvas:1' })
    const a = editor.createSlide({ x: 0, y: 0 }, '16:9')
    const b = editor.createSlide({ x: 3000, y: 0 }, '4:3')
    const rect = editor.makeNode('geo', { x: 0, y: 0, props: { shape: 'rect', w: 50, h: 50 } })
    editor.createNodes([rect])
    editor.setSelection([a, b, rect.id])
    const before = { a: editor.getNode(a)!, b: editor.getNode(b)! }
    editor.toggleSlideRatio()
    expect(slide(editor, a).ratio).toBe('4:3')
    expect(slide(editor, b).ratio).toBe('16:9')
    expect(editor.getNode(a)).toMatchObject({ x: before.a.x, y: before.a.y })
    expect(editor.getNode(b)).toMatchObject({ x: before.b.x, y: before.b.y })

    editor.undo()
    expect(slide(editor, a).ratio).toBe('16:9')
    expect(slide(editor, b).ratio).toBe('4:3')
  })

  it('hides the selected slides when any is shown, shows them when all are hidden, and undoes in one step', () => {
    const editor = new Editor({ canvasId: 'canvas:1' })
    const a = editor.createSlide({ x: 0, y: 0 }, '16:9')
    const b = editor.createSlide({ x: 3000, y: 0 }, '16:9')
    editor.setSelection([a])
    editor.toggleSlidesHidden()
    expect(slide(editor, a).hidden).toBe(true)

    // 1 つでも表示中なら、全部を非表示に
    editor.setSelection([a, b])
    editor.toggleSlidesHidden()
    expect([slide(editor, a).hidden, slide(editor, b).hidden]).toEqual([true, true])
    // 全部が非表示なら、全部を表示に
    editor.toggleSlidesHidden()
    expect([slide(editor, a).hidden, slide(editor, b).hidden]).toEqual([false, false])

    editor.undo()
    expect([slide(editor, a).hidden, slide(editor, b).hidden]).toEqual([true, true])
    editor.undo()
    expect([slide(editor, a).hidden, slide(editor, b).hidden]).toEqual([true, false])
  })

  it('does nothing without selected slides', () => {
    const editor = new Editor({ canvasId: 'canvas:1' })
    const a = editor.createSlide({ x: 0, y: 0 }, '16:9')
    editor.setSelection([])
    editor.toggleSlideRatio()
    editor.toggleSlidesHidden()
    expect(slide(editor, a)).toEqual({ ratio: '16:9', name: '', hidden: false })
    // 履歴にも積まない（Undo すると、置いたことが戻る）
    editor.undo()
    expect(editor.getNode(a)).toBeUndefined()
  })
})
