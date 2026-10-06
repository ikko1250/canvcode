import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { HIDDEN_SLIDE_OPACITY, richTextFromPlain, type SlideLayoutProps } from '@canvcode/nodes'
import { copySelection, duplicateSelection, insertPayload } from './clipboard.ts'
import { Editor } from './editor.ts'
import { drawNodes, type Viewport } from './renderer.ts'
import { slideImageRegion } from './slideImage.ts'
import { SelectTool, type ToolContext, type ToolPointer } from './tools.ts'

// スライドの中身を並べる入れ物（slide-layout、スライド v2）。自分は選べず、落とす先にもならない。
// 中の子はスライドの直下の子と同じように選べて、スライドの切り抜き・非表示・PDF の対象がそのまま効く。
// slots を入れると子は表（1 行）の幾何に並べ直される（もう無い本文の行は除く）：
// タイトル (150, 368)・パネル (150, 436, 1660×276)・行の見出し (220, 500)・本文 (635, 500)

function setup() {
  const editor = new Editor({ canvasId: 'canvas:1' })
  const slide = editor.makeNode('slide', { x: 0, y: 0, props: { ratio: '16:9', name: 'S1', hidden: false } })
  editor.createNodes([slide])
  const layout = editor.makeNode('slide-layout', { x: 0, y: 0, parentId: slide.id, props: { layout: 'table', w: 1920, h: 1080, slots: { rows: [] } } })
  editor.createNodes([layout])
  const add = (type: string, x: number, y: number, props: object, parentId = layout.id) => {
    const node = editor.makeNode(type, { x, y, parentId, props })
    editor.createNodes([node])
    return node.id
  }
  const rect = (x: number, y: number, parentId?: string, w = 100, h = 100) => add('geo', x, y, { shape: 'rect', w, h }, parentId)
  const text = (x: number, y: number, value: string) => add('text', x, y, { paragraphs: richTextFromPlain(value), fontSize: 40, autoWidth: false, w: 400 })
  const title = text(100, 60, '題名')
  const panel = rect(100, 300, layout.id, 1700, 600)
  const label = text(140, 340, '見出し')
  const body = text(600, 340, '本文')
  const slots: SlideLayoutProps['slots'] = { title, panel, rows: [{ label, body }, { body: 'node:gone' }] }
  put(editor, { ...editor.getNode(layout.id)!, props: { ...layout.props, slots } })

  const editing: string[] = []
  const ctx: ToolContext = {
    editor,
    setTool: () => {},
    lift: () => {},
    drop: () => {},
    setCursor: () => {},
    startEditing: (id) => {
      editing.push(id)
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
  const pointer = (px: number, py: number, shiftKey = false): ToolPointer => ({
    screen: { x: px, y: py },
    world: { x: px, y: py },
    button: 0,
    shiftKey,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
  })
  const drag = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const tool = new SelectTool(ctx)
    tool.onPointerDown(pointer(from.x, from.y))
    tool.onPointerMove(pointer(to.x, to.y))
    tool.onPointerUp(pointer(to.x, to.y))
  }
  const click = (x: number, y: number) => {
    const tool = new SelectTool(ctx)
    tool.onPointerDown(pointer(x, y))
    tool.onPointerUp(pointer(x, y))
  }
  const doubleClick = (x: number, y: number) => new SelectTool(ctx).onDoubleClick(pointer(x, y))
  const slotsOf = (id = layout.id) => (editor.getNode(id)!.props as SlideLayoutProps).slots
  return { editor, slide, layout, rect, title, panel, label, body, drag, click, doubleClick, editing, slotsOf }
}

const put = (editor: Editor, node: NodeRecord) => editor.transact('edit', (tx) => tx.put(node))

const selected = (editor: Editor) => [...editor.session.get().selectedIds]

describe('slide-layout in the editor', () => {
  it('never hits nor selects itself, and lets its children be clicked and edited directly', () => {
    const { editor, layout, title, panel, click, doubleClick, editing } = setup()
    expect(editor.isContainer(editor.getNode(layout.id)!, 'layout')).toBe(true)
    expect(editor.hitTest({ x: 200, y: 380 }, 1)?.id).toBe(title)
    expect(editor.hitTest({ x: 1000, y: 1000 }, 1)).toBeNull()
    click(200, 380)
    expect(selected(editor)).toEqual([title])
    click(1000, 690)
    expect(selected(editor)).toEqual([panel])
    // ダブルクリックで、そのまま文字の編集に入る（group のように中に入る段階がない）
    doubleClick(200, 380)
    expect(editing).toEqual([title])
    expect(editor.session.get().focusedGroupId).toBeNull()
    // 範囲選択でも、slide-layout そのものは選ばない
    expect(editor.nodesInBrush({ x: -10, y: -10, w: 2000, h: 1200 })).not.toContain(layout.id)
    expect(editor.nodesInBrush({ x: 140, y: 360, w: 50, h: 50 })).toEqual([title])
  })

  it('is not a drop target: a node dropped onto the slide goes into the slide', () => {
    const { editor, slide, rect, drag } = setup()
    const a = rect(2500, 100, 'canvas:1')
    expect(editor.getNode(a)!.parentId).toBe('canvas:1')
    drag({ x: 2550, y: 150 }, { x: 1050, y: 150 })
    expect(editor.getNode(a)!.parentId).toBe(slide.id)
    expect(editor.frameAt({ x: 1000, y: 150 })).toBe(slide.id)
  })

  it('keeps a child moved within the slide in place, and releases it from the slots when dragged out', () => {
    const { editor, slide, layout, title, body, label, panel, drag, slotsOf } = setup()
    // 同じスライドの中で動かしただけなら、slide-layout に残り、並べ直しで元の位置に戻る
    drag({ x: 200, y: 380 }, { x: 300, y: 420 })
    expect(editor.getNode(title)).toMatchObject({ parentId: layout.id, x: 150, y: 368 })
    expect(slotsOf().title).toBe(title)
    // 外へ出すと Canvas の子になり、slots からも外れる。ワールドでの位置はそのまま
    drag({ x: 200, y: 380 }, { x: 2200, y: 420 })
    expect(editor.getNode(title)!.parentId).toBe('canvas:1')
    expect(editor.index.get(title)!.worldBounds.x).toBe(2150)
    expect(editor.index.get(title)!.worldBounds.y).toBeCloseTo(408, -1)
    expect(slotsOf()).toEqual({ panel, rows: [{ label, body }] })
    // 1 回の Undo で、親と slots が戻る
    editor.undo()
    expect(editor.getNode(title)!.parentId).toBe(layout.id)
    expect(slotsOf().title).toBe(title)
    // 別のスライドに落とすと、そのスライドの子になる
    const other = editor.makeNode('slide', { x: 3000, y: 0, props: { ratio: '16:9', name: 'S2', hidden: false } })
    editor.createNodes([other])
    drag({ x: 650, y: 520 }, { x: 3650, y: 520 })
    expect(editor.getNode(body)!.parentId).toBe(other.id)
    // 本文が出ていった行は slots から除き、その行の見出しも消す
    expect(slotsOf().rows).toEqual([])
    expect(editor.getNode(label)).toBeUndefined()
    expect(editor.getNode(slide.id)).toBeDefined()
  })

  it('applies the clipping, the fade of a hidden slide and the PDF target of the slide to its descendants', () => {
    const { editor, slide, layout, title, rect } = setup()
    // スライドの外にはみ出した部分には当たらない
    const wide = rect(1850, 500, layout.id, 200, 100)
    expect(editor.hitTest({ x: 1900, y: 550 }, 1)?.id).toBe(wide)
    expect(editor.hitTest({ x: 1950, y: 550 }, 1)).toBeNull()
    // PDF に描くノード
    expect(slideImageRegion(editor, slide.id)!.only.has(title)).toBe(true)
    expect(slideImageRegion(editor, slide.id)!.only.has(wide)).toBe(true)
    // 非表示のスライドでは、slide-layout の中の子も薄く描く。スライドの枠で切り抜く
    put(editor, { ...editor.getNode(slide.id)!, props: { ...editor.getNode(slide.id)!.props, hidden: true } })
    const view: Viewport = { camera: { x: -100, y: -100, zoom: 0.1 }, width: 2000, height: 1000, dpr: 1 }
    const { ctx, fills, clips } = recordingContext()
    drawNodes(ctx, editor, [wide], view)
    expect(fills.length).toBeGreaterThan(0)
    for (const alpha of fills) expect(alpha).toBeCloseTo(HIDDEN_SLIDE_OPACITY)
    expect(clips()).toBe(1)
  })

  it('duplicates, copies and pastes with its children, pointing the slots to the new ids', () => {
    const { editor, slide, layout, title, panel, label, body } = setup()
    editor.setSelection([slide.id])
    const [copy] = duplicateSelection(editor, { x: 50, y: 50 })
    const [newLayout] = editor.index.childrenOf(copy)
    expect(editor.getNode(newLayout)!.type).toBe('slide-layout')
    const children = editor.index.childrenOf(newLayout)
    expect(children).toHaveLength(4)
    const slots = (editor.getNode(newLayout)!.props as SlideLayoutProps).slots
    // 新しい子を指し、元の子は指さない（もう無い本文の行は、slots を入れたときの並べ直しで除いてある）
    expect(slots.title && editor.getNode(slots.title)!.parentId).toBe(newLayout)
    expect([slots.title, slots.panel, slots.rows[0].label, slots.rows[0].body].sort()).toEqual([...children].sort())
    expect([title, panel, label, body]).not.toContain(slots.title)
    expect(slots.rows).toHaveLength(1)
    // 元はそのまま
    expect((editor.getNode(layout.id)!.props as SlideLayoutProps).slots.title).toBe(title)

    // コピーして貼り付けても同じ
    editor.setSelection([slide.id])
    const payload = copySelection(editor)!
    const [pasted] = insertPayload(editor, payload, { center: { x: 5000, y: 5000 } })
    const [pastedLayout] = editor.index.childrenOf(pasted)
    const pastedSlots = (editor.getNode(pastedLayout)!.props as SlideLayoutProps).slots
    expect(editor.getNode(pastedSlots.panel!)!.parentId).toBe(pastedLayout)
  })

  it('duplicates a child onto the slide, not into the slide-layout', () => {
    const { editor, slide, layout, title, slotsOf } = setup()
    editor.setSelection([title])
    const [copy] = duplicateSelection(editor, { x: 10, y: 10 })
    expect(editor.getNode(copy)).toMatchObject({ parentId: slide.id, x: 160, y: 378 })
    expect(editor.index.childrenOf(layout.id)).not.toContain(copy)
    expect(slotsOf().title).toBe(title)
  })

  it('deletes and undoes together with the slide', () => {
    const { editor, slide, layout, title, slotsOf } = setup()
    editor.deleteNodes([slide.id])
    expect(editor.getNode(layout.id)).toBeUndefined()
    expect(editor.getNode(title)).toBeUndefined()
    editor.undo()
    expect(editor.getNode(layout.id)!.parentId).toBe(slide.id)
    expect(editor.getNode(title)!.parentId).toBe(layout.id)
    expect(slotsOf().title).toBe(title)
    // 子だけを消しても、slots に残った id で壊れない
    editor.deleteNodes([title])
    expect(slotsOf().title).toBe(title)
    expect(editor.index.get(layout.id)!.localBounds).toEqual({ x: 0, y: 0, w: 1920, h: 1080 })
  })

  it('follows the ratio of the slide', () => {
    const { editor, slide, layout } = setup()
    editor.setSelection([slide.id])
    editor.toggleSlideRatio()
    expect(editor.getNode(layout.id)!.props).toMatchObject({ w: 1440, h: 1080 })
    expect(editor.index.get(layout.id)!.worldBounds).toEqual({ x: 0, y: 0, w: 1440, h: 1080 })
    editor.toggleSlideRatio()
    expect(editor.getNode(layout.id)!.props).toMatchObject({ w: 1920, h: 1080 })
    editor.undo()
    expect(editor.getNode(layout.id)!.props).toMatchObject({ w: 1440, h: 1080 })
  })

  it('lets its children be reordered like the children of a slide', () => {
    const { editor, layout, title, panel, label, body } = setup()
    editor.setSelection([body])
    expect(editor.reorderTargets()).toEqual([body])
    editor.reorderSelection('back')
    expect(editor.index.childrenOf(layout.id)).toEqual([body, title, panel, label])
  })
})

// 塗ったときの不透明度と、切り抜いた回数を記録する ctx
function recordingContext() {
  const fills: number[] = []
  let clipCount = 0
  const state: Record<string, unknown> = { globalAlpha: 1 }
  const stack: Record<string, unknown>[] = []
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key === 'fillRect' || key === 'fill') return () => fills.push(target.globalAlpha as number)
      if (key === 'clip') return () => clipCount++
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
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fills, clips: () => clipCount }
}
