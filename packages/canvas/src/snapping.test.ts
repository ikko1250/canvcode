import { describe, expect, it } from 'vitest'
import type { Box } from '@canvcode/core'
import { Editor } from './editor.ts'
import { boxDistance, nearestBoxes, sameGuides, snapTranslation } from './snapping.ts'
import { SelectTool, type ToolContext, type ToolPointer } from './tools.ts'

// 移動中の吸い付き（MAI-53）

const box = (x: number, y: number, w = 100, h = 100): Box => ({ x, y, w, h })

describe('snapTranslation', () => {
  it('しきい値の外なら何もしない', () => {
    const result = snapTranslation(box(0, 0), [box(120, 120)], 8)
    expect(result).toEqual({ dx: 0, dy: 0, guides: [] })
  })

  it('候補がなければ何もしない', () => {
    expect(snapTranslation(box(0, 0), [], 8)).toEqual({ dx: 0, dy: 0, guides: [] })
  })

  // x 軸：動かす箱（幅 60。線は x, x+30, x+60）の左・中央・右 × 相手（x=300、幅 100。線は 300, 350, 400）の左・中央・右
  it.each([
    // [動かす箱の x, 期待する dx, 説明]
    [243, -3, '右 → 左'],
    [305, -5, '左 → 左'],
    [287, 3, '右 → 中央'],
    [273, -3, '中央 → 左'],
    [397, 3, '左 → 右'],
    [325, -5, '中央 → 中央'],
    [343, -3, '右 → 右'],
    [353, -3, '左 → 中央'],
    [367, 3, '中央 → 右'],
  ])('x：%s（dx=%s、%s）', (x, dx) => {
    const result = snapTranslation(box(x, 1000, 60), [box(300, 0)], 8)
    expect(result.dx).toBe(dx)
    expect(result.dy).toBe(0)
    expect(result.guides).toHaveLength(1)
    expect(result.guides[0].axis).toBe('x')
  })

  // y 軸：動かす箱（高さ 60）の上・中央・下 × 相手（y=300、高さ 100）
  it.each([
    [243, -3, '下 → 上'],
    [305, -5, '上 → 上'],
    [325, -5, '中央 → 中央'],
    [397, 3, '上 → 下'],
    [343, -3, '下 → 下'],
  ])('y：%s（dy=%s、%s）', (y, dy) => {
    const result = snapTranslation(box(1000, y, 100, 60), [box(0, 300)], 8)
    expect(result.dy).toBe(dy)
    expect(result.dx).toBe(0)
    expect(result.guides).toHaveLength(1)
    expect(result.guides[0].axis).toBe('y')
  })

  it('ちょうどしきい値の距離は吸い付く', () => {
    expect(snapTranslation(box(108, 1000), [box(0, 0)], 8).dx).toBe(-8)
    expect(snapTranslation(box(109, 1000), [box(0, 0)], 8).dx).toBe(0)
  })

  it('両方の軸で同時に吸い付く', () => {
    const result = snapTranslation(box(103, 97), [box(0, 0)], 8)
    expect(result.dx).toBe(-3)
    expect(result.dy).toBe(3)
    expect(result.guides.map((g) => g.axis)).toEqual(['x', 'y'])
  })

  it('複数の候補ではいちばん近い線を選ぶ', () => {
    // 左端 5 に対して、相手 A の右端は 0（距離 5）、相手 B の左端は 3（距離 2）
    const result = snapTranslation(box(5, 1000), [box(-100, 0), box(3, 0)], 8)
    expect(result.dx).toBe(-2)
    expect(result.guides[0].position).toBe(3)
  })

  it('同じ距離なら先の候補を使う', () => {
    // 左端 5：A の左端 2（距離 3）と B の左端 8（距離 3）
    const result = snapTranslation(box(5, 1000), [box(2, 0), box(8, 500)], 8)
    expect(result.dx).toBe(-3)
    expect(result.guides[0]).toMatchObject({ position: 2, from: 0, to: 1100 })
  })

  it('ガイドは補正したあとの箱と相手の箱をまとめた範囲', () => {
    // 右端 203 → 相手の左端 200 に吸い付く。縦線は x=200、y は 0〜1100
    const result = snapTranslation(box(103, 1000, 100, 100), [box(200, 0, 50, 100)], 8)
    expect(result.guides).toEqual([{ axis: 'x', position: 200, from: 0, to: 1100 }])
    // 上端 -3 → 相手の上端 0。横線は y=0、x は 0〜600
    const result2 = snapTranslation(box(500, -3, 100, 100), [box(0, 0, 100, 100)], 8)
    expect(result2.guides).toEqual([{ axis: 'y', position: 0, from: 0, to: 600 }])
  })

  it('ガイドの範囲は、もう一方の軸の補正も反映する', () => {
    // x は右端 → 左端（dx=-3）、y は上端 → 上端（dy=+2）
    const result = snapTranslation(box(103, -2), [box(200, 0)], 8)
    expect(result).toEqual({
      dx: -3,
      dy: 2,
      guides: [
        { axis: 'x', position: 200, from: 0, to: 100 },
        { axis: 'y', position: 0, from: 100, to: 300 },
      ],
    })
  })

  it('中央に吸い付いたときはガイドの位置も中央', () => {
    const result = snapTranslation(box(52, 1000), [box(0, 0)], 8)
    expect(result.dx).toBe(-2)
    expect(result.guides[0].position).toBe(50)
  })
})

describe('boxDistance / nearestBoxes', () => {
  it('重なっていれば 0、離れていれば辺どうしの距離', () => {
    expect(boxDistance(box(0, 0), box(50, 50))).toBe(0)
    expect(boxDistance(box(0, 0), box(130, 0))).toBe(30)
    expect(boxDistance(box(0, 0), box(0, 140))).toBe(40)
    expect(boxDistance(box(0, 0), box(130, 140))).toBe(50)
  })

  it('近い順に上限まで残す（同じ距離なら元の順）', () => {
    const boxes = [box(500, 0), box(200, 0), box(0, 200), box(200, 200)]
    expect(nearestBoxes(box(0, 0), boxes, 2)).toEqual([box(200, 0), box(0, 200)])
    expect(nearestBoxes(box(0, 0), boxes, 10)).toEqual(boxes)
  })
})

// 選択ツールのドラッグに組み込んだ吸い付き
describe('SelectTool のドラッグ', () => {
  function setup() {
    const editor = new Editor({ canvasId: 'canvas:1' })
    const rect = (x: number, y: number, w = 100, h = 100) => {
      const node = editor.makeNode('geo', { x, y, props: { shape: 'rect', w, h } })
      editor.createNodes([node])
      return node.id
    }
    const ctx: ToolContext = {
      editor,
      setTool: () => {},
      lift: () => {},
      drop: () => {},
      setCursor: () => {},
      startEditing: () => false,
      openPortal: () => {},
      editDocument: () => false,
      createDocumentAt: () => {},
      quoteRegion: () => {},
      openCitations: () => {},
      moveToCanvas: () => {},
      viewportBox: () => ({ x: -1000, y: -1000, w: 3000, h: 3000 }),
    }
    const pointer = (px: number, py: number, mods: Partial<ToolPointer> = {}): ToolPointer => ({
      screen: { x: px, y: py },
      world: { x: px, y: py },
      button: 0,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      ...mods,
    })
    return { editor, rect, tool: new SelectTool(ctx), pointer }
  }

  it('動かしている箱の辺が近くのノードの辺に吸い付き、離すとガイドが消える', () => {
    const { editor, rect, tool, pointer } = setup()
    const a = rect(0, 0)
    rect(300, 200)
    tool.onPointerDown(pointer(50, 50))
    // 生の移動量は 206。右端 306 が相手の左端 300 に吸い付いて、x=200 になる
    tool.onPointerMove(pointer(256, 50))
    expect(editor.getNode(a)).toMatchObject({ x: 200, y: 0 })
    expect(editor.session.get().snapGuides).toEqual([{ axis: 'x', position: 300, from: 0, to: 300 }])
    tool.onPointerUp(pointer(256, 50))
    expect(editor.getNode(a)).toMatchObject({ x: 200, y: 0 })
    expect(editor.session.get().snapGuides).toEqual([])
  })

  it('Ctrl（⌘）を押している間は吸い付かない', () => {
    const { editor, rect, tool, pointer } = setup()
    const a = rect(0, 0)
    rect(300, 200)
    tool.onPointerDown(pointer(50, 50))
    tool.onPointerMove(pointer(256, 50, { ctrlKey: true }))
    expect(editor.getNode(a)).toMatchObject({ x: 206, y: 0 })
    expect(editor.session.get().snapGuides).toEqual([])
    // 離すと吸い付く
    tool.onPointerMove(pointer(256, 50))
    expect(editor.getNode(a)).toMatchObject({ x: 200, y: 0 })
    tool.onPointerUp(pointer(256, 50))
  })

  it('取り消し（Esc）でもガイドが消える', () => {
    const { editor, rect, tool, pointer } = setup()
    const a = rect(0, 0)
    rect(300, 200)
    tool.onPointerDown(pointer(50, 50))
    tool.onPointerMove(pointer(256, 50))
    expect(editor.session.get().snapGuides).toHaveLength(1)
    expect(tool.cancel()).toBe(true)
    expect(editor.session.get().snapGuides).toEqual([])
    expect(editor.getNode(a)).toMatchObject({ x: 0, y: 0 })
  })

  it('動かしているノードどうしには吸い付かない', () => {
    const { editor, rect, tool, pointer } = setup()
    const a = rect(0, 0)
    const b = rect(150, 0)
    editor.setSelection([a, b])
    tool.onPointerDown(pointer(50, 50))
    tool.onPointerMove(pointer(56, 53))
    expect(editor.getNode(a)).toMatchObject({ x: 6, y: 3 })
    expect(editor.getNode(b)).toMatchObject({ x: 156, y: 3 })
    expect(editor.session.get().snapGuides).toEqual([])
    tool.onPointerUp(pointer(56, 53))
  })
})

describe('sameGuides', () => {
  it('同じ内容なら true', () => {
    const a = [{ axis: 'x' as const, position: 1, from: 0, to: 10 }]
    expect(sameGuides(a, [{ ...a[0] }])).toBe(true)
    expect(sameGuides(a, [])).toBe(false)
    expect(sameGuides(a, [{ ...a[0], to: 11 }])).toBe(false)
  })
})
