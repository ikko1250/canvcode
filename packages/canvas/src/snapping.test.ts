import { describe, expect, it } from 'vitest'
import type { Box } from '@canvcode/core'
import { Editor } from './editor.ts'
import { boxDistance, nearestBoxes, sameGuides, snapResize, snapTranslation } from './snapping.ts'
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

describe('snapResize（MAI-58）', () => {
  const free = { keepAspect: false, fromCenter: false, minW: 1, minH: 1 }

  it('辺のハンドル：動かしている右の辺だけが、相手の左の辺に吸い付く', () => {
    // 右の辺 296 → 相手の左の辺 300
    const result = snapResize(box(0, 0, 296, 100), 'e', [box(300, 200)], 8, free)
    expect(result.box).toEqual(box(0, 0, 300, 100))
    expect(result.guides).toEqual([{ axis: 'x', position: 300, from: 0, to: 300 }])
  })

  it('辺のハンドル：その辺の軸でしか探さない', () => {
    // 下の辺 97 は相手の上の辺 100 に近いが、e のハンドルなので吸い付かない
    const result = snapResize(box(0, 0, 250, 97), 'e', [box(400, 100)], 8, free)
    expect(result).toEqual({ box: box(0, 0, 250, 97), guides: [] })
  })

  it('動かない辺と中心は吸い付かせない', () => {
    // 左の辺 3 と中心 128 は相手の辺に近いが、動かしているのは右の辺（253）だけ
    const result = snapResize(box(3, 0, 250, 100), 'e', [box(0, 500), box(128, 500, 0, 0)], 8, free)
    expect(result).toEqual({ box: box(3, 0, 250, 100), guides: [] })
  })

  it('左の辺のハンドルでは、右の辺を固定して左の辺を動かす', () => {
    // 左の辺 -4 → 相手の右の辺 0
    const result = snapResize(box(-4, 300, 104, 100), 'w', [box(-100, 0)], 8, free)
    expect(result.box).toEqual(box(0, 300, 100, 100))
    expect(result.guides).toEqual([{ axis: 'x', position: 0, from: 0, to: 400 }])
  })

  it('角のハンドル：両方の軸で、動かしている辺がそれぞれ吸い付く', () => {
    // 右の辺 205 → 200（左の辺）、下の辺 347 → 350（中心）
    const result = snapResize(box(0, 0, 205, 347), 'se', [box(200, 300)], 8, free)
    expect(result.box).toEqual(box(0, 0, 200, 350))
    expect(result.guides.map((g) => [g.axis, g.position])).toEqual([
      ['x', 200],
      ['y', 350],
    ])
  })

  it('しきい値の外なら何もしない', () => {
    const result = snapResize(box(0, 0, 291, 100), 'e', [box(300, 200)], 8, free)
    expect(result).toEqual({ box: box(0, 0, 291, 100), guides: [] })
  })

  it('Shift（縦横比を保つ）：ずれの小さい方の軸だけが吸い付き、もう一方は縦横比から決める', () => {
    // 右の辺 196 → 200（ずれ 4）、下の辺 98 → 100（ずれ 2）。y に吸い付き、幅は 200 × 100 / 98
    const result = snapResize(box(0, 0, 196, 98), 'se', [box(200, 100)], 8, { ...free, keepAspect: true })
    expect(result.box.h).toBe(100)
    expect(result.box.w).toBeCloseTo(200)
    expect(result.box).toMatchObject({ x: 0, y: 0 })
    expect(result.guides.map((g) => g.axis)).toEqual(['y'])
  })

  it('Shift で辺のハンドルなら、その辺の軸で吸い付き、もう一方の軸は中心を保つ', () => {
    // 右の辺 196 → 200。高さも 100 → 100 × 200 / 196 に、中心（y=50）を保って伸ばす
    const result = snapResize(box(0, 0, 196, 100), 'e', [box(200, 500)], 8, { ...free, keepAspect: true })
    expect(result.box.w).toBe(200)
    expect(result.box.h).toBeCloseTo((100 * 200) / 196)
    expect(result.box.y + result.box.h / 2).toBeCloseTo(50)
    expect(result.guides.map((g) => g.axis)).toEqual(['x'])
  })

  it('Alt（中心から）：吸い付いた辺のずれを、反対の辺にも逆向きに当てる', () => {
    // 右の辺 297 → 300（ずれ +3）。左の辺は 3 → 0 に動き、中心 150 はそのまま
    const result = snapResize(box(3, 0, 294, 100), 'e', [box(300, 500)], 8, { ...free, fromCenter: true })
    expect(result.box).toEqual(box(0, 0, 300, 100))
  })

  it('最小サイズを下回るなら、その軸は吸い付かせない', () => {
    // 右の辺 16 → 相手の右の辺 10 だと幅が 10 になり、最小の 12 を下回る。y は吸い付く
    const result = snapResize(box(0, 0, 16, 96), 'se', [box(-90, 0, 100, 100)], 8, { ...free, minW: 12, minH: 12 })
    expect(result.box).toEqual(box(0, 0, 16, 100))
    expect(result.guides.map((g) => g.axis)).toEqual(['y'])
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

describe('SelectTool のリサイズ（MAI-58）', () => {
  function setup() {
    const editor = new Editor({ canvasId: 'canvas:1' })
    const rect = (x: number, y: number, w = 100, h = 100, rotation = 0) => {
      const node = editor.makeNode('geo', { x, y, props: { shape: 'rect', w, h } })
      editor.createNodes([{ ...node, rotation }])
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

  it('右の辺のハンドルで、右の辺が隣のノードの左の辺に揃い、離すとガイドが消える', () => {
    const { editor, rect, tool, pointer } = setup()
    const a = rect(0, 0)
    rect(300, 200)
    editor.setSelection([a])
    tool.onPointerDown(pointer(100, 50))
    tool.onPointerMove(pointer(296, 50))
    expect(editor.getNode(a)).toMatchObject({ x: 0, y: 0, props: { w: 300, h: 100 } })
    expect(editor.session.get().snapGuides).toEqual([{ axis: 'x', position: 300, from: 0, to: 300 }])
    tool.onPointerUp(pointer(296, 50))
    expect(editor.getNode(a)).toMatchObject({ props: { w: 300, h: 100 } })
    expect(editor.session.get().snapGuides).toEqual([])
  })

  it('Ctrl（⌘）を押している間は揃わない', () => {
    const { editor, rect, tool, pointer } = setup()
    const a = rect(0, 0)
    rect(300, 200)
    editor.setSelection([a])
    tool.onPointerDown(pointer(100, 50))
    tool.onPointerMove(pointer(296, 50, { ctrlKey: true }))
    expect(editor.getNode(a)).toMatchObject({ props: { w: 296, h: 100 } })
    expect(editor.session.get().snapGuides).toEqual([])
    tool.onPointerUp(pointer(296, 50))
  })

  it('取り消し（Esc）でもガイドが消える', () => {
    const { editor, rect, tool, pointer } = setup()
    const a = rect(0, 0)
    rect(300, 200)
    editor.setSelection([a])
    tool.onPointerDown(pointer(100, 50))
    tool.onPointerMove(pointer(296, 50))
    expect(editor.session.get().snapGuides).toHaveLength(1)
    expect(tool.cancel()).toBe(true)
    expect(editor.session.get().snapGuides).toEqual([])
    expect(editor.getNode(a)).toMatchObject({ props: { w: 100, h: 100 } })
  })

  it('回したノードでは吸い付かない', () => {
    const { editor, rect, tool, pointer } = setup()
    // 90° 回したノード。ローカルの x はワールドの +y の向きで、右の辺のハンドルはワールドの (-50, 100)
    const a = rect(0, 0, 100, 100, Math.PI / 2)
    rect(-200, 300)
    editor.setSelection([a])
    tool.onPointerDown(pointer(-50, 100))
    // 右の辺は y=296 で、吸い付けば相手の上の辺 300 に揃うはず
    tool.onPointerMove(pointer(-50, 296))
    const node = editor.getNode(a)!
    expect((node.props as { w: number }).w).toBeCloseTo(296)
    expect(editor.session.get().snapGuides).toEqual([])
    tool.onPointerUp(pointer(-50, 296))
  })

  it('複数選択でも、動かしている辺が吸い付く（選んだノードどうしには吸い付かない）', () => {
    const { editor, rect, tool, pointer } = setup()
    const a = rect(0, 0)
    const b = rect(150, 0)
    rect(500, 300)
    editor.setSelection([a, b])
    // 枠は 0〜250。右の辺を 497 まで → 相手の左の辺 500 に揃い、枠の幅は 500（2 倍）
    tool.onPointerDown(pointer(250, 50))
    tool.onPointerMove(pointer(497, 50))
    expect(editor.getNode(b)).toMatchObject({ x: 300, props: { w: 200 } })
    expect(editor.session.get().snapGuides).toEqual([{ axis: 'x', position: 500, from: 0, to: 400 }])
    tool.onPointerUp(pointer(497, 50))
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
