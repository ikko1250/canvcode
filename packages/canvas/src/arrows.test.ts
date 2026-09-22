import { describe, expect, it } from 'vitest'
import type { NodeRecord, Vec } from '@canvcode/core'
import { arcGeometry, arcPoint, clippedArrowShape, type ArrowProps } from '@canvcode/nodes'
import { makeBinding } from './bindings.ts'
import { copySelection, insertPayload } from './clipboard.ts'
import { Editor } from './editor.ts'

// 矢印とつながり（MAI-28）

function setup() {
  const editor = new Editor({ canvasId: 'canvas:1' })
  const shape = (x: number, y: number, shape: 'rect' | 'ellipse' = 'rect', parentId?: string) => {
    const node = editor.makeNode('geo', { x, y, parentId, props: { shape, w: 100, h: 100 } })
    editor.createNodes([node])
    return node
  }
  // start と end をつないだ矢印を作る。端は、それぞれのノードの中心（isPrecise なら anchor）
  const connect = (from: string | null, to: string | null, options: { precise?: Vec; bend?: number } = {}) => {
    const arrow = editor.makeNode('arrow', { x: 0, y: 0, props: { start: { x: 0, y: 0 }, end: { x: 500, y: 0 }, bend: options.bend ?? 0 } })
    editor.transact('arrow', (tx) => {
      tx.put(arrow)
      for (const [terminal, target] of [['start', from], ['end', to]] as const) {
        if (!target) continue
        tx.put(
          makeBinding(arrow.id, target, {
            terminal,
            normalizedAnchor: options.precise ?? { x: 0.5, y: 0.5 },
            isPrecise: options.precise !== undefined,
          }),
        )
      }
    })
    return arrow.id
  }
  const arrow = (id: string) => editor.getNode(id) as NodeRecord<ArrowProps>
  // 見えている端（ワールド座標。矢印は Canvas 直下の原点にあるので、ローカル座標と同じ）
  const ends = (id: string) => {
    const { props } = arrow(id)
    const g = arcGeometry(props.start, props.end, props.bend)
    return [arcPoint(g, props.clip[0]), arcPoint(g, props.clip[1])]
  }
  return { editor, shape, connect, arrow, ends }
}

function closeTo(actual: Vec, expected: Vec, digits = 6) {
  expect(actual.x).toBeCloseTo(expected.x, digits)
  expect(actual.y).toBeCloseTo(expected.y, digits)
}

describe('arc geometry', () => {
  it('passes through the bend point at the middle, and is a line without bend', () => {
    const line = arcGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 0)
    expect(line.kind).toBe('line')
    closeTo(arcPoint(line, 0.25), { x: 25, y: 0 })
    const arc = arcGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 30)
    expect(arc.kind).toBe('arc')
    // 画面の座標（y が下向き）で、bend が正なら進む向きの右側（ここでは +y の側）に膨らむ
    closeTo(arcPoint(arc, 0.5), { x: 50, y: 30 })
    closeTo(arcPoint(arc, 0), { x: 0, y: 0 })
    closeTo(arcPoint(arc, 1), { x: 100, y: 0 })
  })

  it('turns the clipped part of an arc into an arc of its own', () => {
    const props = { start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, bend: 30, clip: [0.2, 0.8] } as ArrowProps
    const g = arcGeometry(props.start, props.end, props.bend)
    const shape = clippedArrowShape(props)
    const h = arcGeometry(shape.start, shape.end, shape.bend)
    closeTo(arcPoint(h, 0), arcPoint(g, 0.2))
    closeTo(arcPoint(h, 1), arcPoint(g, 0.8))
    closeTo(arcPoint(h, 0.5), arcPoint(g, 0.5))
  })
})

describe('bindings', () => {
  it('points at the centres and stops at the edges of the connected nodes', () => {
    const { shape, connect, arrow, ends } = setup()
    const a = shape(0, 0)
    const b = shape(300, 0)
    const id = connect(a.id, b.id)
    closeTo(arrow(id).props.start, { x: 50, y: 50 })
    closeTo(arrow(id).props.end, { x: 350, y: 50 })
    const [s, e] = ends(id)
    closeTo(s, { x: 100, y: 50 }, 2)
    closeTo(e, { x: 300, y: 50 }, 2)
  })

  it('stops at the edge of an ellipse, not its box', () => {
    const { shape, connect, ends } = setup()
    const a = shape(0, 0)
    const b = shape(300, 300, 'ellipse')
    const id = connect(a.id, b.id)
    // 中心 (350, 350)、半径 50 の円の縁（多角形で近似しているので、少しずれる）
    const [, e] = ends(id)
    expect(Math.hypot(e.x - 350, e.y - 350)).toBeCloseTo(50, 0)
  })

  it('points at the anchor when precise', () => {
    const { shape, connect, arrow } = setup()
    const a = shape(0, 0)
    const b = shape(300, 0)
    const id = connect(a.id, b.id, { precise: { x: 0, y: 0 } })
    closeTo(arrow(id).props.end, { x: 300, y: 0 })
  })

  it('follows a moved node in the same undo step', () => {
    const { editor, shape, connect, ends } = setup()
    const a = shape(0, 0)
    const b = shape(300, 0)
    const id = connect(a.id, b.id)
    editor.moveNodes([b.id], 0, 200)
    // (50, 50) から中心 (350, 250) に向かう線は、箱の左の縁 x = 300 で止まる
    closeTo(ends(id)[1], { x: 300, y: 50 + (250 / 300) * 200 }, 2)
    editor.undo()
    closeTo(ends(id)[1], { x: 300, y: 50 }, 2)
  })

  it('follows a node inside a group when the group moves', () => {
    const { editor, shape, connect, ends } = setup()
    const a = shape(0, 0)
    const b = shape(300, 0)
    const c = shape(300, 200)
    editor.setSelection([b.id, c.id])
    const groupId = editor.groupSelected()!
    const id = connect(a.id, b.id)
    editor.moveNodes([groupId], 100, 0)
    closeTo(ends(id)[1], { x: 400, y: 50 }, 2)
  })

  it('keeps the arrow where it was when the connected node is deleted, and undo reconnects it', () => {
    const { editor, shape, connect, ends } = setup()
    const a = shape(0, 0)
    const b = shape(300, 0)
    const id = connect(a.id, b.id)
    const before = ends(id)
    editor.deleteNodes([b.id])
    expect(editor.bindingsOfArrow(id).map((x) => x.props.terminal)).toEqual(['start'])
    closeTo(ends(id)[1], before[1], 6)
    editor.undo()
    expect(editor.bindingsOfArrow(id)).toHaveLength(2)
  })

  it('deletes the bindings with the arrow', () => {
    const { editor, shape, connect } = setup()
    const id = connect(shape(0, 0).id, shape(300, 0).id)
    editor.deleteNodes([id])
    expect([...editor.store.values()].filter((r) => r.typeName === 'binding')).toHaveLength(0)
  })

  it('detaches an arrow moved without its nodes, but keeps it when they move together', () => {
    const { editor, shape, connect } = setup()
    const a = shape(0, 0)
    const b = shape(300, 0)
    const id = connect(a.id, b.id)
    editor.moveNodes([id, a.id, b.id], 10, 10)
    expect(editor.bindingsOfArrow(id)).toHaveLength(2)
    editor.moveNodes([id, a.id], 10, 10)
    expect(editor.bindingsOfArrow(id).map((x) => x.toId)).toEqual([a.id])
  })

  it('keeps the binding index right when a transaction is cancelled', () => {
    const { editor, shape } = setup()
    const a = shape(0, 0)
    const arrow = editor.makeNode('arrow', { x: 0, y: 0 })
    const tx = editor.begin('arrow')
    tx.put(arrow)
    tx.put(makeBinding(arrow.id, a.id, { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false }))
    tx.flush()
    expect(editor.bindingsOfArrow(arrow.id)).toHaveLength(1)
    tx.cancel()
    expect(editor.bindingsOfArrow(arrow.id)).toHaveLength(0)
    expect(editor.bindings.isEmpty).toBe(true)
  })
})

describe('copying arrows', () => {
  it('copies the bindings with the connected nodes, under new ids', () => {
    const { editor, shape, connect } = setup()
    const a = shape(0, 0)
    const b = shape(300, 0)
    const id = connect(a.id, b.id)
    editor.setSelection([a.id, b.id, id])
    const pasted = insertPayload(editor, copySelection(editor)!, { offset: { x: 0, y: 500 } })
    const newArrow = pasted.find((p) => editor.getNode(p)!.type === 'arrow')!
    const targets = editor.bindingsOfArrow(newArrow).map((x) => x.toId)
    expect(targets).toHaveLength(2)
    for (const t of targets) {
      expect(pasted).toContain(t)
      expect(editor.index.get(t)!.worldBounds.y).toBeCloseTo(500, 6)
    }
  })

  it('freezes the ends of an arrow copied without its nodes', () => {
    const { editor, shape, connect, ends } = setup()
    const id = connect(shape(0, 0).id, shape(300, 0).id)
    const before = ends(id)
    editor.setSelection([id])
    const [pasted] = insertPayload(editor, copySelection(editor)!, { offset: { x: 0, y: 0 } })
    expect(editor.bindingsOfArrow(pasted)).toHaveLength(0)
    closeTo(ends(pasted)[0], before[0], 6)
    closeTo(ends(pasted)[1], before[1], 6)
  })
})
