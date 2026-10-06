import { describe, expect, it } from 'vitest'
import { slideOrder, type SlideOrderInput } from './slideOrder.ts'

// スライドの順番と番号。16:9（1920×1080）と 4:3（1440×1080）のスライドで確かめる

const WIDE = { w: 1920, h: 1080 }
const STANDARD = { w: 1440, h: 1080 }
const GAP = 200

function slide(id: string, x: number, y: number, size: { w: number; h: number } = WIDE, hidden = false): SlideOrderInput {
  return { id, box: { x, y, ...size }, hidden }
}

// 入力の並びを変えても同じ結果になることを確かめる（逆順と、ずらした順）
function expectStable(slides: SlideOrderInput[], order: string[]): void {
  expect(slideOrder(slides).order).toEqual(order)
  expect(slideOrder([...slides].reverse()).order).toEqual(order)
  const shifted = [...slides.slice(1), ...slides.slice(0, 1)]
  expect(slideOrder(shifted).order).toEqual(order)
}

describe('slideOrder', () => {
  it('reads a clean grid row by row', () => {
    // 横 3 枚 × 2 行。id はわざと位置と関係ない名前にする
    const ids = ['f', 'b', 'e', 'a', 'd', 'c']
    const slides = ids.map((id, i) => slide(id, (i % 3) * (WIDE.w + GAP), Math.floor(i / 3) * (WIDE.h + GAP)))
    const result = slideOrder(slides)
    expect(result.order).toEqual(ids)
    expect([...result.numbers]).toEqual(ids.map((id, i) => [id, i + 1]))
    expectStable(slides, ids)
  })

  it('keeps slightly staggered slides in one row without chaining downwards', () => {
    // 1 枚ごとに 400 ずつ下がる。基準（a）との重なりは b が 680、c が 280（高さの半分 540 未満）
    const slides = [
      slide('a', 0, 0),
      slide('b', WIDE.w + GAP, 400),
      slide('c', 2 * (WIDE.w + GAP), 800),
      slide('d', 3 * (WIDE.w + GAP), 1200),
    ]
    // c は a と同じ行にならず、次の行（基準 c）で d と並ぶ
    expectStable(slides, ['a', 'b', 'c', 'd'])
    // 左右を入れ替えても、行は上から決まる
    const swapped = [slide('a', 3 * (WIDE.w + GAP), 0), slide('b', 0, 400), slide('c', WIDE.w + GAP, 800)]
    expectStable(swapped, ['b', 'a', 'c'])
  })

  it('treats an overlap of exactly half the smaller height as the same row', () => {
    expectStable([slide('a', 0, 0), slide('b', -WIDE.w - GAP, WIDE.h / 2)], ['b', 'a'])
    expectStable([slide('a', 0, 0), slide('b', -WIDE.w - GAP, WIDE.h / 2 + 1)], ['a', 'b'])
  })

  it('handles a tall slide spanning two rows', () => {
    // 右に 2 行（a・b）、左に 2 行分の高さの大きいスライド t（少し下から始まる）
    const tall = { w: 3840, h: 2160 + GAP }
    const slides = [slide('t', -tall.w - GAP, 100, tall), slide('a', 0, 0), slide('b', 0, WIDE.h + GAP)]
    // 基準 a と t の重なり（980）は小さい方の高さ（1080）の半分以上なので同じ行。b は次の行
    expectStable(slides, ['t', 'a', 'b'])
    // t が最上段から始まれば t が基準になり、t と半分以上重なる b も同じ行に入る（x が同じなら上から）
    const fromTop = [slide('t', -tall.w - GAP, 0, tall), slide('a', 0, 0), slide('b', 0, WIDE.h + GAP)]
    expectStable(fromTop, ['t', 'a', 'b'])
    // t と b の重なりが半分に届かなければ、b は次の行
    const short = [slide('t', -tall.w - GAP, 0, { w: 3840, h: 1600 }), slide('a', 0, 0), slide('b', 0, WIDE.h + GAP)]
    expectStable(short, ['t', 'a', 'b'])
    const shortRight = [slide('t', WIDE.w + GAP, 0, { w: 3840, h: 1600 }), slide('a', 0, 0), slide('b', 0, WIDE.h + GAP)]
    expectStable(shortRight, ['a', 't', 'b'])
  })

  it('mixes 4:3 and 16:9 slides', () => {
    const slides = [
      slide('a', 0, 0, WIDE),
      slide('b', WIDE.w + GAP, 0, STANDARD),
      slide('c', 0, WIDE.h + GAP, STANDARD),
      slide('d', STANDARD.w + GAP, WIDE.h + GAP, WIDE),
    ]
    expectStable(slides, ['a', 'b', 'c', 'd'])
  })

  it('leaves hidden slides out of the numbering and the row split', () => {
    const slides = [
      slide('a', 0, 0),
      slide('h', WIDE.w + GAP, 0, WIDE, true),
      slide('b', 2 * (WIDE.w + GAP), 0),
      slide('c', 0, WIDE.h + GAP),
    ]
    const result = slideOrder(slides)
    expect(result.order).toEqual(['a', 'b', 'c'])
    expect(result.numbers.get('b')).toBe(2)
    expect(result.numbers.has('h')).toBe(false)
    // 非表示のスライドが行の基準になって、ほかのスライドの行分けを変えることはない。
    // h を基準にすると a・b は同じ行になるが、h を除けば a と b は別の行
    const between = [slide('a', 0, 0), slide('h', 0, 500, WIDE, true), slide('b', -WIDE.w - GAP, 1000)]
    expectStable(between, ['a', 'b'])
  })

  it('breaks ties by id regardless of input order', () => {
    const slides = [slide('c', 0, 0), slide('a', 0, 0), slide('b', 0, 0)]
    expectStable(slides, ['a', 'b', 'c'])
  })

  it('returns nothing for no slides', () => {
    const result = slideOrder([])
    expect(result.order).toEqual([])
    expect(result.numbers.size).toBe(0)
  })
})
