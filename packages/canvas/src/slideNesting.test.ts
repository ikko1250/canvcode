import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import type { SlideProps } from '@canvcode/nodes'
import { Editor } from './editor.ts'
import { editNodes } from './propertyEdit.ts'
import { SelectTool, selectionHandles, type ToolContext, type ToolPointer } from './tools.ts'

// エディターでのスライド（スライド v2）。frame と同じく子を持って枠で切り抜き、リサイズ・回転はできない

function setup() {
  const editor = new Editor({ canvasId: 'canvas:1' })
  const slide = editor.makeNode('slide', { x: 0, y: 0, props: { ratio: '16:9', name: 'S1', hidden: false } })
  editor.createNodes([slide])
  const rect = (x: number, y: number, w = 100, h = 100, parentId?: string) => {
    const node = editor.makeNode('geo', { x, y, parentId, props: { shape: 'rect', w, h } })
    editor.createNodes([node])
    return node.id
  }
  // 編集に入ったテキストと、それを作っている途中の変更
  const editing: { id: string; tx?: { get(id: string): unknown } }[] = []
  const ctx: ToolContext = {
    editor,
    setTool: () => {},
    lift: () => {},
    drop: () => {},
    setCursor: () => {},
    startEditing: (id, options) => {
      editing.push({ id, tx: options?.tx })
      return true
    },
    openPortal: () => {},
    editDocument: () => false,
    createDocumentAt: () => {},
    quoteRegion: () => {},
    openCitations: () => {},
    moveToCanvas: () => {},
    viewportBox: () => ({ x: -1000, y: -1000, w: 5000, h: 3000 }),
  }
  const pointer = (px: number, py: number, ctrlKey = false): ToolPointer => ({
    screen: { x: px, y: py },
    world: { x: px, y: py },
    button: 0,
    shiftKey: false,
    altKey: false,
    ctrlKey,
    metaKey: false,
  })
  // ドラッグして離す。ctrlKey なら Ctrl を押しながら
  const drag = (from: { x: number; y: number }, to: { x: number; y: number }, ctrlKey = false) => {
    const tool = new SelectTool(ctx)
    tool.onPointerDown(pointer(from.x, from.y, ctrlKey))
    tool.onPointerMove(pointer(to.x, to.y, ctrlKey))
    tool.onPointerUp(pointer(to.x, to.y, ctrlKey))
  }
  const doubleClick = (x: number, y: number) => new SelectTool(ctx).onDoubleClick(pointer(x, y))
  const worldOf = (id: string) => {
    const e = editor.index.get(id)!
    return { x: e.worldBounds.x, y: e.worldBounds.y, w: e.worldBounds.w, h: e.worldBounds.h }
  }
  return { editor, slide, rect, drag, doubleClick, editing, worldOf }
}

const withRatio = (ratio: SlideProps['ratio']) => (node: NodeRecord) => ({ ...node, props: { ...node.props, ratio } })

describe('slides in the editor', () => {
  it('takes a node dropped onto it as a child, and lets it go when dragged out', () => {
    const { editor, slide, rect, drag, worldOf } = setup()
    const a = rect(2500, 100)
    // 中心がスライドの中に入るように落とす
    drag({ x: 2550, y: 150 }, { x: 1050, y: 550 })
    expect(editor.getNode(a)!.parentId).toBe(slide.id)
    expect(worldOf(a)).toEqual({ x: 1000, y: 500, w: 100, h: 100 })
    // スライドを動かすと、子も一緒に動く
    editor.moveNodes([slide.id], 100, 0)
    expect(worldOf(a)).toEqual({ x: 1100, y: 500, w: 100, h: 100 })
    // 外へ出すと Canvas に戻る。ワールドでの位置はそのまま
    drag({ x: 1150, y: 550 }, { x: 2650, y: 550 })
    expect(editor.getNode(a)!.parentId).toBe('canvas:1')
    expect(worldOf(a)).toEqual({ x: 2600, y: 500, w: 100, h: 100 })
  })

  it('keeps its children when it is moved together with them', () => {
    const { editor, slide, rect, drag, worldOf } = setup()
    const a = rect(100, 100, 100, 100, slide.id)
    // 外から範囲選択でスライドを丸ごと囲むと、スライドと中の子が選ばれる
    drag({ x: -100, y: -100 }, { x: 2100, y: 1200 })
    expect(new Set(editor.session.get().selectedIds)).toEqual(new Set([slide.id, a]))
    // そのまま（子をつかんで）動かしても、子はスライドから外れず、スライドと同じだけ動く
    drag({ x: 150, y: 150 }, { x: 250, y: 200 })
    expect(editor.getNode(a)!.parentId).toBe(slide.id)
    expect(worldOf(slide.id)).toMatchObject({ x: 100, y: 50 })
    expect(worldOf(a)).toMatchObject({ x: 200, y: 150 })
  })

  it('is grabbed anywhere inside, and Ctrl+drag inside selects its children with a brush', () => {
    const { editor, slide, rect, drag, doubleClick, editing, worldOf } = setup()
    const a = rect(100, 100, 100, 100, slide.id)
    // 子のない所をつかんで動かす。子も一緒に動く
    drag({ x: 1000, y: 500 }, { x: 1100, y: 550 })
    expect([...editor.session.get().selectedIds]).toEqual([slide.id])
    expect(worldOf(slide.id)).toMatchObject({ x: 100, y: 50 })
    expect(worldOf(a)).toMatchObject({ x: 200, y: 150 })
    // 子の上なら子をつかむ
    drag({ x: 250, y: 200 }, { x: 260, y: 200 })
    expect([...editor.session.get().selectedIds]).toEqual([a])
    // Ctrl+ドラッグなら範囲選択で、スライドは動かない
    drag({ x: 150, y: 100 }, { x: 400, y: 400 }, true)
    expect([...editor.session.get().selectedIds]).toEqual([a])
    expect(worldOf(slide.id)).toMatchObject({ x: 100, y: 50 })
    // 中の空いている所のダブルクリックは、スライドの中にテキストを作る
    doubleClick(1000, 600)
    expect(editing).toHaveLength(1)
    expect(editing[0].tx?.get(editing[0].id)).toMatchObject({ type: 'text', parentId: slide.id })
  })

  it('clips its children to its box, which follows the ratio', () => {
    const { editor, slide, rect } = setup()
    expect(editor.index.get(slide.id)!.localBounds).toEqual({ x: 0, y: 0, w: 1920, h: 1080 })
    // 4:3（幅 1440）にすると外にはみ出す子
    const a = rect(1400, 100, 200, 100, slide.id)
    expect(editor.hitTest({ x: 1500, y: 150 }, 1)?.id).toBe(a)
    // スライドの外にはみ出した部分には当たらない
    expect(editor.hitTest({ x: 1950, y: 150 }, 1)).toBeNull()
    editNodes(editor, [slide.id], withRatio('4:3'), 'ratio')
    expect(editor.index.get(slide.id)!.localBounds).toEqual({ x: 0, y: 0, w: 1440, h: 1080 })
    expect(editor.hitTest({ x: 1420, y: 150 }, 1)?.id).toBe(a)
    expect(editor.hitTest({ x: 1500, y: 150 }, 1)).toBeNull()
  })

  it('keeps its top-left when the ratio changes', () => {
    const { editor, slide, worldOf } = setup()
    editor.moveNodes([slide.id], 300, 200)
    editNodes(editor, [slide.id], withRatio('4:3'), 'ratio')
    expect(editor.getNode(slide.id)).toMatchObject({ x: 300, y: 200 })
    expect(worldOf(slide.id)).toEqual({ x: 300, y: 200, w: 1440, h: 1080 })
    editNodes(editor, [slide.id], withRatio('16:9'), 'ratio')
    expect(worldOf(slide.id)).toEqual({ x: 300, y: 200, w: 1920, h: 1080 })
  })

  it('shows neither resize nor rotate handles', () => {
    const { editor, slide, rect } = setup()
    editor.setSelection([slide.id])
    const selection = editor.transformSelection()!
    expect(selection.canResize).toBe(false)
    expect(selection.canRotate).toBe(false)
    const shown = selectionHandles(editor)!
    expect(shown.handles.handles).toEqual([])
    expect(shown.handles.rotate).toBeNull()
    // ほかのノードと一緒に選んでも、回転はできない
    editor.setSelection([slide.id, rect(2500, 0)])
    expect(editor.transformSelection()!.canRotate).toBe(false)
    expect(selectionHandles(editor)!.handles.rotate).toBeNull()
  })
})
