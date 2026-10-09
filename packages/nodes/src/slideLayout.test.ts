import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { builtinNodeTypes } from './index.ts'
import { adjustOf, remapSlots, slideLayoutType, slotIds, slotsOf, type SlideLayoutProps } from './slideLayout.ts'

// スライドの中身を並べる入れ物（slide-layout、スライド v2）

const layout = (props: Partial<SlideLayoutProps> = {}): NodeRecord<SlideLayoutProps> => ({
  typeName: 'node',
  id: 'node:l',
  type: 'slide-layout',
  parentId: 'node:s',
  x: 0,
  y: 0,
  rotation: 0,
  index: 'a1',
  opacity: 1,
  locked: false,
  props: { ...slideLayoutType.defaultProps(), ...props },
  meta: {},
  version: 1,
})

describe('slide-layout', () => {
  it('is a layout container that neither draws, hits, resizes, rotates nor binds', () => {
    expect(builtinNodeTypes).toContain(slideLayoutType)
    expect(slideLayoutType.container).toBe('layout')
    expect(slideLayoutType.resize).toBeUndefined()
    expect(slideLayoutType.canRotate).toBe(false)
    expect(slideLayoutType.canBind).toBe(false)
    const node = layout({ w: 1440, h: 1080 })
    expect(slideLayoutType.getBounds(node)).toEqual({ x: 0, y: 0, w: 1440, h: 1080 })
    expect(slideLayoutType.hitTest(node, { x: 10, y: 10 }, 5, 1)).toBe(false)
    const calls: string[] = []
    const ctx = new Proxy({}, { get: (_, key) => () => calls.push(String(key)) }) as unknown as CanvasRenderingContext2D
    slideLayoutType.render(ctx, node, { zoom: 1, devicePixelRatio: 1, detail: 'full' })
    slideLayoutType.renderRough!(ctx, node, { zoom: 0.1, devicePixelRatio: 1, detail: 'rough' })
    expect(calls).toEqual([])
  })

  it('reads broken slots without throwing', () => {
    expect(slotsOf(undefined)).toEqual({ rows: [] })
    expect(slotsOf({ title: 3, panel: 'node:p', rows: 'x' })).toEqual({ panel: 'node:p', rows: [] })
    expect(slotsOf({ rows: [null, { label: 'node:a', body: 1 }, { body: 'node:b' }] })).toEqual({
      rows: [{ body: '' }, { label: 'node:a', body: '' }, { body: 'node:b' }],
    })
  })

  it('lists, remaps and releases the ids in its slots', () => {
    const slots = { title: 'a', panel: 'p', rows: [{ label: 'l1', body: 'b1' }, { body: 'b2' }] }
    expect(slotIds(slots)).toEqual(['a', 'p', 'l1', 'b1', 'b2'])
    const map = new Map([['a', 'A'], ['p', 'P'], ['l1', 'L1'], ['b1', 'B1']])
    // 写さなかった id は外す（行の本文は空にして、行の並びを保つ）
    expect(remapSlots(slots, (id) => map.get(id))).toEqual({ title: 'A', panel: 'P', rows: [{ label: 'L1', body: 'B1' }, { body: '' }] })
    const node = layout({ layout: 'table', slots })
    expect(slideLayoutType.remapIds!(node, (id) => map.get(id)).slots.title).toBe('A')
    expect(slideLayoutType.releaseChild!(node, 'l1')).toEqual({ ...node.props, slots: { title: 'a', panel: 'p', rows: [{ body: 'b1' }, { body: 'b2' }] } })
    expect(slideLayoutType.releaseChild!(node, 'a').slots.title).toBeUndefined()
  })
})

describe('adjustOf', () => {
  it('reads broken data as the default and drops zeros', () => {
    expect(adjustOf(undefined)).toEqual({})
    expect(adjustOf('x')).toEqual({})
    expect(adjustOf({ table: { dx: 'a', dy: Number.NaN, w: 0 }, figure: null })).toEqual({})
    expect(adjustOf({ table: { dx: 10, dy: -20, w: 800, z: 1 }, figure: { dy: 5 } })).toEqual({ table: { dx: 10, dy: -20, w: 800 }, figure: { dy: 5 } })
  })
})
