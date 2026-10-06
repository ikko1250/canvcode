import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { frameType, type FrameProps } from './container.ts'
import { upgradeNode } from './defineNodeType.ts'
import { builtinNodeTypes } from './index.ts'
import { isHiddenSlide, SLIDE_SIZES, slideLabel, slideSize, slideType, type SlideProps } from './slide.ts'

// スライド（スライド v2）

const slide = (patch: Partial<SlideProps> = {}): NodeRecord<SlideProps> => ({
  typeName: 'node',
  id: 'node:s',
  type: 'slide',
  parentId: 'canvas:1',
  x: 100,
  y: 200,
  rotation: 0,
  index: 'a1',
  opacity: 1,
  locked: false,
  props: { ...slideType.defaultProps(), ...patch },
  meta: {},
  version: 1,
})

describe('slide', () => {
  it('has the default props and is registered as a frame-like container', () => {
    expect(slideType.defaultProps()).toEqual({ ratio: '16:9', name: '', hidden: false })
    expect(slideType.version).toBe(1)
    expect(slideType.container).toBe('frame')
    expect(builtinNodeTypes).toContain(slideType)
  })

  it('takes its size from the ratio', () => {
    expect(slideSize('16:9')).toEqual({ w: 1920, h: 1080 })
    expect(slideSize('4:3')).toEqual({ w: 1440, h: 1080 })
    expect(slideType.getBounds(slide())).toEqual({ x: 0, y: 0, w: 1920, h: 1080 })
    expect(slideType.getBounds(slide({ ratio: '4:3' }))).toEqual({ x: 0, y: 0, w: 1440, h: 1080 })
    // 壊れた値は 16:9 として扱う
    expect(slideSize('3:2' as never)).toEqual(SLIDE_SIZES['16:9'])
  })

  it('cannot be resized', () => {
    expect(slideType.resize).toBeUndefined()
  })

  it('hits only the name and the border, like a frame', () => {
    const node = slide({ ratio: '4:3', name: 'はじめに' })
    const hit = (x: number, y: number, zoom = 1) => slideType.hitTest(node, { x, y }, 4, zoom)
    // 枠の線の近く
    expect(hit(0, 500)).toBe(true)
    expect(hit(1440, 500)).toBe(true)
    expect(hit(1443, 1083)).toBe(true)
    // 4:3 の右の線より外（16:9 なら中）
    expect(hit(1600, 500)).toBe(false)
    // 枠の中の空いている所・外
    expect(hit(700, 500)).toBe(false)
    expect(hit(-20, 500)).toBe(false)
    // 名前の部分（枠の左上の上）。倍率を下げると、ワールド単位では広くなる
    expect(hit(10, -10)).toBe(true)
    expect(hit(10, -100)).toBe(false)
    expect(hit(10, -100, 0.1)).toBe(true)
    // frame と同じ判定になる
    const frame: NodeRecord<FrameProps> = { ...node, type: 'frame', props: { w: 1440, h: 1080, name: 'はじめに' } }
    for (const [x, y] of [[0, 500], [700, 500], [10, -10], [60, -10], [1445, 0]]) {
      expect(hit(x, y)).toBe(frameType.hitTest(frame, { x, y }, 4, 1))
    }
  })

  it('makes the label from the number, the name and whether it is hidden', () => {
    expect(slideLabel('はじめに', 3, false)).toBe('3. はじめに')
    expect(slideLabel('', 3, false)).toBe('3')
    expect(slideLabel('メモ', null, true)).toBe('非表示 · メモ')
    expect(slideLabel('', null, true)).toBe('非表示')
    // 番号が引けなければ名前だけ（空なら何も描かない）
    expect(slideLabel('はじめに', null, false)).toBe('はじめに')
    expect(slideLabel('', null, false)).toBe('')
    expect(isHiddenSlide(slide({ hidden: true }))).toBe(true)
    expect(isHiddenSlide(slide())).toBe(false)
  })

  it('appends the overflow warning to the label', () => {
    expect(slideLabel('はじめに', 3, false, true)).toBe('3. はじめに ⚠ あふれ')
    expect(slideLabel('', 3, false, true)).toBe('3 ⚠ あふれ')
    expect(slideLabel('メモ', null, true, true)).toBe('非表示 · メモ ⚠ あふれ')
    expect(slideLabel('', null, false, true)).toBe('⚠ あふれ')
    expect(slideLabel('はじめに', 3, false, false)).toBe('3. はじめに')
  })

  it('fits the name hit area to the label', () => {
    const node = slide({ name: 'あ' })
    const slides = { number: (id: string) => (id === node.id ? 12 : null) }
    // 「12. あ」は 5 文字分（12 × 5 + 8 = 68）。名前だけなら 1 文字分（20）
    const hit = (x: number, info?: { slides: typeof slides }) => slideType.hitTest(node, { x, y: -5 }, 0, 1, info)
    expect(hit(15)).toBe(true)
    expect(hit(30)).toBe(false)
    expect(hit(30, { slides })).toBe(true)
    expect(hit(67, { slides })).toBe(true)
    expect(hit(70, { slides })).toBe(false)
    // 非表示なら「非表示 · あ」（7 文字分。12 × 7 + 8 = 92）
    const hidden = slide({ name: 'あ', hidden: true })
    expect(slideType.hitTest(hidden, { x: 90, y: -5 }, 0, 1)).toBe(true)
    expect(slideType.hitTest(hidden, { x: 95, y: -5 }, 0, 1)).toBe(false)
    // あふれの警告を付けると「12. あ ⚠ あふれ」（11 文字分。12 × 11 + 8 = 140）
    const warned = { number: slides.number, overflows: (id: string) => id === node.id }
    expect(hit(139, { slides: warned })).toBe(true)
    expect(hit(142, { slides: warned })).toBe(false)
  })

  it('draws the numbered label, or only the name without a resolver', () => {
    const drawn: string[] = []
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (target, key) => (key === 'fillText' ? (text: string) => drawn.push(text) : key in target ? target[key as string] : () => {}),
      set: (target, key, value) => {
        target[key as string] = value
        return true
      },
    }) as unknown as CanvasRenderingContext2D
    const node = slide({ name: 'はじめに' })
    slideType.render(ctx, node, { zoom: 1, devicePixelRatio: 1, detail: 'full', slides: { number: () => 2 } })
    slideType.render(ctx, node, { zoom: 1, devicePixelRatio: 1, detail: 'full' })
    slideType.render(ctx, slide({ name: 'はじめに', hidden: true }), { zoom: 1, devicePixelRatio: 1, detail: 'full', slides: { number: () => null } })
    expect(drawn).toEqual(['2. はじめに', 'はじめに', '非表示 · はじめに'])
  })

  it('draws the overflow warning in red on screen, and nothing of it for print', () => {
    const drawn: { text: string; color: unknown }[] = []
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (target, key) =>
        key === 'fillText' ? (text: string) => drawn.push({ text, color: target.fillStyle }) : key in target ? target[key as string] : () => {},
      set: (target, key, value) => {
        target[key as string] = value
        return true
      },
    }) as unknown as CanvasRenderingContext2D
    const slides = { number: () => 3, overflows: () => true }
    slideType.render(ctx, slide({ name: 'はじめに' }), { zoom: 1, devicePixelRatio: 1, detail: 'full', slides })
    slideType.render(ctx, slide({ name: 'はじめに' }), { zoom: 1, devicePixelRatio: 1, detail: 'full', slides: { number: () => 3, overflows: () => false } })
    slideType.render(ctx, slide({ name: 'はじめに' }), { zoom: 1, devicePixelRatio: 1, detail: 'full', slides, print: true })
    expect(drawn).toEqual([
      { text: '3. はじめに ⚠ あふれ', color: '#e03131' },
      { text: '3. はじめに', color: '#656d76' },
    ])
  })

  it('draws only the white ground for print', () => {
    const calls: string[] = []
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (target, key) => (typeof key === 'string' && /^(fill|stroke)/.test(key) && !key.endsWith('Style') ? () => calls.push(key) : key in target ? target[key as string] : () => {}),
      set: (target, key, value) => {
        target[key as string] = value
        return true
      },
    }) as unknown as CanvasRenderingContext2D
    slideType.render(ctx, slide({ name: 'はじめに' }), { zoom: 1, devicePixelRatio: 1, detail: 'full', slides: { number: () => 2 }, print: true })
    expect(calls).toEqual(['fillRect'])
  })

  it('survives saving and loading', () => {
    const node = slide({ ratio: '4:3', name: 'まとめ', hidden: true })
    const loaded = JSON.parse(JSON.stringify(node)) as NodeRecord<SlideProps>
    expect(upgradeNode(slideType, loaded)).toEqual(node)
    expect(slideType.getBounds(loaded)).toEqual({ x: 0, y: 0, w: 1440, h: 1080 })
  })
})
