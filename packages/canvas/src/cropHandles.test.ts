import { describe, expect, it } from 'vitest'
import type { NodeRecord, Vec } from '@canvcode/core'
import { imagePaint, solidPaint, type GeoProps, type ImagePaint, type ImageProps } from '@canvcode/nodes'
import { Editor } from './editor.ts'
import {
  cropEditingTarget,
  cropFromRects,
  cropHandles,
  fullImageRect,
  hitCropHandle,
  panImage,
  resizeWindow,
  scaleImage,
  startCropEditing,
} from './cropHandles.ts'
import { SelectTool, selectionHandles, type ToolContext, type ToolPointer } from './tools.ts'

// 画像のトリミング（切り抜きモード）

function setup(node: (editor: Editor) => NodeRecord) {
  const editor = new Editor({ canvasId: 'canvas:1' })
  const created = node(editor)
  editor.createNodes([created])
  editor.setSelection([created.id])
  const ctx: ToolContext = {
    editor,
    setTool: () => {},
    lift: () => {},
    drop: () => {},
    setCursor: () => {},
    startEditing: () => false,
    openPortal: () => {},
    editDocument: () => false,
    startCrop: (id) => startCropEditing(editor, id, { get: () => ({ width: 400, height: 400 }) }),
    createDocumentAt: () => {},
    quoteRegion: () => {},
    openCitations: () => {},
    moveToCanvas: () => {},
  }
  // カメラは原点・倍率 1 なので、画面の座標とワールド座標は同じ
  const pointer = (p: Vec): ToolPointer => ({ screen: p, world: p, button: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false })
  const tool = new SelectTool(ctx)
  const drag = (from: Vec, to: Vec) => {
    tool.onPointerDown(pointer(from))
    tool.onPointerMove(pointer(to))
    tool.onPointerUp(pointer(to))
  }
  return { editor, id: created.id, tool, pointer, drag, get: () => editor.getNode(created.id)! }
}

const imageNode = (rotation = 0) => (editor: Editor) =>
  ({ ...editor.makeNode('image', { x: 100, y: 100, props: { assetId: 'asset:a', w: 200, h: 100, crop: null } }), rotation })

const filledRect = (fill: GeoProps['fill']) => (editor: Editor) =>
  editor.makeNode('geo', { x: 0, y: 0, props: { shape: 'rect', w: 200, h: 100, fill } })

function closeTo<T extends object>(actual: T, expected: Partial<T>, digits = 4) {
  for (const key of Object.keys(expected) as (keyof T)[]) expect(actual[key]).toBeCloseTo(expected[key] as number, digits)
}

describe('crop rect math', () => {
  it('round-trips between the crop and the full image rect', () => {
    const box = { x: 0, y: 0, w: 100, h: 50 }
    const crop = { x: 0.25, y: 0.1, w: 0.5, h: 0.4 }
    const full = fullImageRect(box, crop)
    closeTo(full, { x: -50, y: -12.5, w: 200, h: 125 })
    closeTo(cropFromRects(box, full), crop)
  })

  it('stops panning where the image would stop covering the window', () => {
    const window = { x: 0, y: 0, w: 100, h: 100 }
    const full = { x: -50, y: -50, w: 200, h: 200 }
    closeTo(panImage(window, full, { x: 30, y: -10 }), { x: -20, y: -60 })
    closeTo(panImage(window, full, { x: 500, y: -500 }), { x: 0, y: -100 })
  })

  it('scales the image about the opposite corner, keeping the aspect and covering the window', () => {
    const window = { x: 0, y: 0, w: 100, h: 50 }
    const full = { x: 0, y: 0, w: 100, h: 50 }
    closeTo(scaleImage(window, full, 'se', { x: 200, y: 60 }), { x: 0, y: 0, w: 200, h: 100 })
    // 小さくしすぎても、窓を覆う大きさで止まる
    closeTo(scaleImage(window, full, 'se', { x: 10, y: 10 }), { x: 0, y: 0, w: 100, h: 50 })
    closeTo(scaleImage(window, full, 'nw', { x: -100, y: 0 }), { x: -100, y: -50, w: 200, h: 100 })
  })

  it('keeps the window inside the image and above the minimum size', () => {
    const window = { x: 0, y: 0, w: 100, h: 100 }
    const full = { x: -20, y: 0, w: 140, h: 100 }
    closeTo(resizeWindow(window, full, 'w', { x: -100, y: 0 }, { w: 8, h: 8 }), { x: -20, w: 120 })
    closeTo(resizeWindow(window, full, 'e', { x: -50, y: 0 }, { w: 8, h: 8 }), { x: 0, w: 8 })
    closeTo(resizeWindow(window, full, 'se', { x: 60, y: 40 }, { w: 8, h: 8 }), { w: 60, h: 40 })
  })
})

describe('crop editing', () => {
  it('enters on double click on an image, hides the resize handles, and leaves on a click outside the image', () => {
    const { editor, tool, pointer } = setup(imageNode())
    tool.onDoubleClick(pointer({ x: 150, y: 150 }))
    expect(cropEditingTarget(editor)).not.toBeNull()
    expect(selectionHandles(editor)).toBeNull()
    tool.onPointerDown(pointer({ x: 600, y: 600 }))
    tool.onPointerUp(pointer({ x: 600, y: 600 }))
    expect(editor.session.get().cropEditing).toBeNull()
    expect(selectionHandles(editor)).toBeNull() // 何もない所を押したので、選択も外れる
  })

  it('crops an image node by dragging a window handle, in one undo step', () => {
    const { editor, id, tool, pointer, drag, get } = setup(imageNode())
    tool.onDoubleClick(pointer({ x: 150, y: 150 }))
    // 右辺を左へ 100 動かす：窓の幅が半分、画像の左半分が見える
    drag({ x: 300, y: 150 }, { x: 200, y: 150 })
    const node = get() as NodeRecord<ImageProps>
    expect(node.props.w).toBeCloseTo(100)
    expect(node.props.h).toBeCloseTo(100)
    closeTo(node.props.crop!, { x: 0, y: 0, w: 0.5, h: 1 })
    // 左辺を右へ 50：原点も動く
    drag({ x: 100, y: 150 }, { x: 150, y: 150 })
    const moved = get() as NodeRecord<ImageProps>
    expect(moved.x).toBeCloseTo(150)
    closeTo(moved.props.crop!, { x: 0.25, w: 0.25 })
    // 画像を動かす（窓は動かない）
    drag({ x: 175, y: 150 }, { x: 125, y: 150 })
    const panned = get() as NodeRecord<ImageProps>
    expect(panned.x).toBeCloseTo(150)
    closeTo(panned.props.crop!, { x: 0.5, w: 0.25 })
    editor.undo()
    closeTo((get() as NodeRecord<ImageProps>).props.crop!, { x: 0.25, w: 0.25 })
    expect(editor.getNode(id)).toBeDefined()
  })

  it('moves the origin along the rotation of the node', () => {
    const { editor, tool, pointer, drag, get } = setup(imageNode(Math.PI / 2))
    // 90° 回っている：ローカルの (0..200, 0..100) は、ワールドの x: 0..100、y: 100..300
    tool.onDoubleClick(pointer({ x: 50, y: 200 }))
    expect(cropEditingTarget(editor)).not.toBeNull()
    // ローカルの左辺（ワールドの y = 100）を、ローカルで 50 だけ右（ワールドで下へ 50）
    drag({ x: 50, y: 100 }, { x: 50, y: 150 })
    const node = get()
    expect(node.x).toBeCloseTo(100)
    expect(node.y).toBeCloseTo(150)
    expect((node.props as ImageProps).w).toBeCloseTo(150)
  })

  it('pans the image fill of a shape without changing the shape, switching it to crop mode', () => {
    // 400×400 の画像を 200×100 の枠に塗りつぶし：見えているのは縦の真ん中の半分
    const { editor, tool, pointer, drag, get } = setup(filledRect(imagePaint('asset:a')))
    tool.onDoubleClick(pointer({ x: 100, y: 50 }))
    const handles = cropHandles(editor)!
    expect(handles.window.handles).toHaveLength(0)
    closeTo(handles.full, { x: 0, y: -50, w: 200, h: 200 })
    drag({ x: 100, y: 50 }, { x: 100, y: 80 })
    const node = get() as NodeRecord<GeoProps>
    expect(node.props.w).toBe(200)
    const fill = node.props.fill as ImagePaint
    expect(fill.scaleMode).toBe('crop')
    closeTo(fill.crop, { x: 0, y: 0.1, w: 1, h: 0.5 })
  })

  it('does not enter for a shape without an image fill', () => {
    const { editor, id } = setup(filledRect(solidPaint('#ff0000')))
    expect(startCropEditing(editor, id)).toBe(false)
    expect(hitCropHandle(editor, { x: 10, y: 10 }, { x: 10, y: 10 })).toBeNull()
  })
})
