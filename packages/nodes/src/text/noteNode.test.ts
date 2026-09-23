import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { noteHeight, noteType, type NoteProps } from './noteNode.ts'

// Node には Canvas がないので、概算の文字幅で測る（layout.test.ts と同じ）
function note(props: Partial<NoteProps>): NodeRecord<NoteProps> {
  return {
    typeName: 'node',
    id: 'n1',
    type: 'note',
    parentId: 'c1',
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a0',
    opacity: 1,
    locked: false,
    props: { ...noteType.defaultProps(), ...props },
    meta: {},
  }
}

describe('note auto height (MAI-34)', () => {
  it('keeps the stored height when the text fits', () => {
    const node = note({ text: 'short', h: 200 })
    expect(noteType.getBounds(node)).toEqual({ x: 0, y: 0, w: 220, h: 200 })
  })

  it('grows to fit the text when it does not fit', () => {
    const node = note({ text: Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'), h: 200 })
    const h = noteHeight(node.props)
    expect(h).toBeGreaterThan(200)
    // 20 行 × 行の高さ（20 × 1.4）+ 上下の余白（16 × 2）
    expect(h).toBeCloseTo(20 * 28 + 32)
    expect(noteType.getBounds(node).h).toBe(h)
    expect(noteType.hitTest(node, { x: 10, y: h - 1 }, 0, 1)).toBe(true)
    expect(noteType.hitTest(node, { x: 10, y: h + 1 }, 0, 1)).toBe(false)
    expect(noteType.editText!(node).box.h).toBe(h - 32)
  })

  it('wraps long lines at the note width before measuring the height', () => {
    // 半角 1 文字 = 0.55 × 20 = 11 なので、幅 188 の箱には 17 文字が入る。34 文字なら 2 行
    const node = note({ text: 'a'.repeat(34), h: 60 })
    expect(noteHeight(node.props)).toBeCloseTo(2 * 28 + 32)
  })

  it('also fits notes created before, whose stored height is smaller than the text', () => {
    const node = note({ text: 'a\nb\nc\nd\ne', h: 60 })
    expect(noteHeight(node.props)).toBeCloseTo(5 * 28 + 32)
  })
})
