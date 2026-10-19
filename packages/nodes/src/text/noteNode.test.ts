import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { NOTE_DEFAULT_FONT_SIZE, NOTE_DEFAULT_LINE_HEIGHT, noteHeight, noteStyle, noteType, type NoteProps } from './noteNode.ts'
import { richTextFromPlain } from './richText.ts'

// Node には Canvas がないので、概算の文字幅で測る（layout.test.ts と同じ）。text はプレーンテキストの文字
function note({ text, ...rest }: Partial<NoteProps> & { text?: string }): NodeRecord<NoteProps> {
  const props: Partial<NoteProps> = text === undefined ? rest : { ...rest, paragraphs: richTextFromPlain(text) }
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
  it('keeps the stored height when the text fits (fixed, and old notes without sizing)', () => {
    const node = note({ text: 'short', h: 200, sizing: 'fixed' })
    expect(noteType.getBounds(node)).toEqual({ x: 0, y: 0, w: 220, h: 200 })
    const { sizing: _, ...legacy } = note({ text: 'short', h: 200 }).props
    expect(noteType.getBounds(node)).toEqual({ x: 0, y: 0, w: 220, h: 200 })
    expect(noteHeight(legacy as NoteProps)).toBe(200)
  })

  it('grows to fit the text when it does not fit', () => {
    const node = note({ text: Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'), h: 200, fontSize: 20 })
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
    const node = note({ text: 'a'.repeat(34), h: 60, fontSize: 20 })
    expect(noteHeight(node.props)).toBeCloseTo(2 * 28 + 32)
  })

  it('also fits notes created before, whose stored height is smaller than the text', () => {
    const node = note({ text: 'a\nb\nc\nd\ne', h: 60, fontSize: 20 })
    expect(noteHeight(node.props)).toBeCloseTo(5 * 28 + 32)
  })
})

describe('note height fitted to the text (sizing auto)', () => {
  it('new notes fit their text', () => {
    expect(noteType.defaultProps().sizing).toBe('auto')
  })

  it('shrinks to the text, ignoring the stored height', () => {
    const node = note({ text: 'a\nb\nc', h: 200, fontSize: 20 })
    expect(noteHeight(node.props)).toBeCloseTo(3 * 28 + 32)
    expect(noteType.getBounds(node).h).toBeCloseTo(3 * 28 + 32)
    expect(noteType.editText!(node).box.h).toBeCloseTo(3 * 28)
  })

  it('grows as the text grows', () => {
    const node = note({ text: Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'), fontSize: 20 })
    expect(noteHeight(node.props)).toBeCloseTo(20 * 28 + 32)
  })

  it('does not get lower than the minimum height', () => {
    expect(noteHeight(note({ text: '' }).props)).toBe(60)
    expect(noteHeight(note({ text: 'one line' }).props)).toBe(60)
  })

  it('stays fitted when only the width changes', () => {
    const node = note({ text: 'a\nb\nc', fontSize: 20 })
    const props = noteType.resize!(node, { w: 300, h: noteHeight(node.props) })
    expect(props.sizing).toBe('auto')
    expect(props.w).toBe(300)
    expect(props.h).toBe(node.props.h)
  })

  it('fixes the height when the height is changed by hand', () => {
    const node = note({ text: 'a\nb\nc', fontSize: 20 })
    const props = noteType.resize!(node, { w: 220, h: 250 })
    expect(props.sizing).toBe('fixed')
    expect(props.h).toBe(250)
    expect(noteHeight(props)).toBe(250)
  })
})

describe('note font size and alignment (MAI-50)', () => {
  it('defaults to a font size of 12 (MAI-62)', () => {
    expect(noteType.defaultProps().fontSize).toBe(NOTE_DEFAULT_FONT_SIZE)
    expect(NOTE_DEFAULT_FONT_SIZE).toBe(12)
  })

  it('defaults to left alignment', () => {
    expect(noteType.defaultProps().align).toBe('left')
    expect(noteStyle(noteType.defaultProps()).align).toBe('left')
  })

  it('treats notes stored before align existed as left-aligned', () => {
    const { align: _align, ...legacy } = noteType.defaultProps()
    expect(noteStyle(legacy as NoteProps).align).toBe('left')
    expect(noteType.editText!(note(legacy as NoteProps)).style.align).toBe('left')
  })

  it('passes the alignment and font size to the editor and grows with the font size', () => {
    const node = note({ text: 'a\nb\nc', align: 'center', fontSize: 40, h: 60 })
    const spec = noteType.editText!(node)
    expect(spec.style.align).toBe('center')
    expect(spec.style.fontSize).toBe(40)
    // 3 行 × 行の高さ（40 × 1.4）+ 上下の余白（16 × 2）
    expect(noteHeight(node.props)).toBeCloseTo(3 * 56 + 32)
  })
})

describe('note line height (MAI-76)', () => {
  it('keeps the old line height for notes without lineHeight', () => {
    expect(noteStyle(noteType.defaultProps()).lineHeight).toBe(NOTE_DEFAULT_LINE_HEIGHT)
    expect(NOTE_DEFAULT_LINE_HEIGHT).toBe(1.4)
  })

  it('grows and shrinks with the line height, as a multiplier or in pixels', () => {
    const node = note({ text: 'a\nb\nc', fontSize: 20, h: 60 })
    expect(noteHeight({ ...node.props, lineHeight: { unit: 'multiplier', value: 2 } })).toBeCloseTo(3 * 40 + 32)
    expect(noteHeight({ ...node.props, lineHeight: { unit: 'px', value: 30 } })).toBeCloseTo(3 * 30 + 32)
    const spec = noteType.editText!({ ...node, props: { ...node.props, lineHeight: { unit: 'px', value: 30 } } })
    expect(spec.style.fixedLineHeight).toBe(30)
    expect(spec.box.h).toBeCloseTo(90)
  })
})
