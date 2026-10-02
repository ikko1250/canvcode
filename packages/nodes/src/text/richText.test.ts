import { describe, expect, it } from 'vitest'
import {
  applyRunFormat,
  clearRunFormat,
  formatAt,
  formatsInRange,
  migratePlainTextProps,
  normalizeRichText,
  paragraphsOf,
  plainTextOf,
  replaceRange,
  richTextFromPlain,
  richTextLength,
  sliceRichText,
  type TextParagraph,
} from './richText.ts'
import { upgradeNode } from '../defineNodeType.ts'
import { textType } from './textNode.ts'
import { noteType } from './noteNode.ts'

// 範囲ごとに書式を持てるテキスト（MAI-74）

const red = { color: '#ff0000' }
const big = { fontSize: 32 }
// 'ab'（赤）'cd' / 'ef'（大）
const sample: TextParagraph[] = [{ runs: [{ text: 'ab', format: red }, { text: 'cd' }] }, { runs: [{ text: 'ef', format: big }] }]

describe('rich text model', () => {
  it('converts from and to plain text', () => {
    expect(richTextFromPlain('a\r\nb')).toEqual([{ runs: [{ text: 'a' }] }, { runs: [{ text: 'b' }] }])
    expect(plainTextOf(sample)).toBe('abcd\nef')
    expect(richTextLength(sample)).toBe(7)
  })

  it('normalizes: merges equal runs, drops empty runs and values equal to the default', () => {
    expect(
      normalizeRichText(
        [{ runs: [{ text: 'a', format: red }, { text: '' }, { text: 'b', format: { color: '#ff0000' } }, { text: 'c', format: { color: '#000000' } }] }],
        { color: '#000000' },
      ),
    ).toEqual([{ runs: [{ text: 'ab', format: red }, { text: 'c' }] }])
    // 空の段落は、書式を持つ空の run を 1 つ
    expect(normalizeRichText([{ runs: [{ text: '', format: red }, { text: '' }] }])).toEqual([{ runs: [{ text: '', format: red }] }])
    expect(normalizeRichText([])).toEqual([{ runs: [{ text: '' }] }])
  })

  it('applies a format to a range across runs and paragraphs', () => {
    expect(applyRunFormat(sample, 1, 6, { fontSize: 20 })).toEqual([
      { runs: [{ text: 'a', format: red }, { text: 'b', format: { color: '#ff0000', fontSize: 20 } }, { text: 'cd', format: { fontSize: 20 } }] },
      { runs: [{ text: 'e', format: { fontSize: 20 } }, { text: 'f', format: big }] },
    ])
    // undefined は既定に戻す
    expect(applyRunFormat(sample, 0, 2, { color: undefined })[0].runs).toEqual([{ text: 'abcd' }])
    // 範囲の中の空の段落にも当てる（そこで打つ文字の書式）
    expect(applyRunFormat(richTextFromPlain('a\n\nb'), 0, 4, red)).toEqual([
      { runs: [{ text: 'a', format: red }] },
      { runs: [{ text: '', format: red }] },
      { runs: [{ text: 'b', format: red }] },
    ])
  })

  it('reads the formats in a range and at the caret', () => {
    expect(formatsInRange(sample, 1, 3)).toEqual([red, undefined])
    expect(formatsInRange(sample, 4, 6)).toEqual([big])
    expect(formatsInRange(sample, 2, 2)).toEqual([red])
    // 直前の文字の書式。段落の頭は、その段落の最初の run
    expect(formatAt(sample, 3)).toBeUndefined()
    expect(formatAt(sample, 5)).toEqual(big)
    expect(formatAt(sample, 0)).toEqual(red)
  })

  it('replaces a range, joining and splitting paragraphs', () => {
    // 段落をまたいで消す
    expect(replaceRange(sample, 1, 6, [])).toEqual([{ runs: [{ text: 'a', format: red }, { text: 'f', format: big }] }])
    // 段落を分ける：新しい段落は、分けた位置の書式で始まる
    expect(replaceRange(sample, 2, 2, [{ runs: [] }, { runs: [] }])).toEqual([
      { runs: [{ text: 'ab', format: red }] },
      { runs: [{ text: 'cd' }] },
      { runs: [{ text: 'ef', format: big }] },
    ])
    expect(replaceRange([{ runs: [{ text: 'x', format: red }] }], 1, 1, [{ runs: [] }, { runs: [] }])).toEqual([
      { runs: [{ text: 'x', format: red }] },
      { runs: [{ text: '', format: red }] },
    ])
    // 書式付きの文字を入れる
    expect(replaceRange(sample, 4, 4, [{ runs: [{ text: '1', format: big } ] }, { runs: [{ text: '2' }] }])).toEqual([
      { runs: [{ text: 'ab', format: red }, { text: 'cd' }, { text: '1', format: big }] },
      { runs: [{ text: '2' }] },
      { runs: [{ text: 'ef', format: big }] },
    ])
    // すべて消すと、先頭の文字の書式の空の段落
    expect(replaceRange(sample, 0, 7, [])).toEqual([{ runs: [{ text: '', format: red }] }])
  })

  it('keeps paragraph attributes when splitting and slicing', () => {
    const list = [{ runs: [{ text: 'ab' }], list: 'bullet' }] as unknown as TextParagraph[]
    const split = replaceRange(list, 1, 1, [list[0], list[0]].map((p) => ({ ...p, runs: [] })))
    expect(split).toEqual([
      { runs: [{ text: 'a' }], list: 'bullet' },
      { runs: [{ text: 'b' }], list: 'bullet' },
    ])
    expect(sliceRichText(split, 0, 3)).toEqual(split)
  })

  it('slices a range with its formats', () => {
    expect(sliceRichText(sample, 1, 6)).toEqual([{ runs: [{ text: 'b', format: red }, { text: 'cd' }] }, { runs: [{ text: 'e', format: big }] }])
    expect(sliceRichText(sample, 3, 3)).toEqual([{ runs: [{ text: '' }] }])
  })

  it('clears one format from all runs', () => {
    expect(clearRunFormat(applyRunFormat(sample, 0, 7, red), 'color')).toEqual([{ runs: [{ text: 'abcd' }] }, { runs: [{ text: 'ef', format: big }] }])
  })
})

describe('text and note props version 2 (MAI-74)', () => {
  const legacy = (type: string, props: object) => ({
    typeName: 'node' as const,
    id: 'node:a',
    type,
    parentId: 'canvas:a',
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a0',
    opacity: 1,
    locked: false,
    props,
    meta: {},
  })

  it('migrates plain text records to paragraphs', () => {
    const text = upgradeNode(textType, legacy('text', { text: 'a\nb', fontSize: 16, color: '#000', align: 'left', w: 200, autoWidth: true }))
    expect(text.version).toBe(2)
    expect(text.props).toEqual({ paragraphs: richTextFromPlain('a\nb'), fontSize: 16, color: '#000', align: 'left', w: 200, autoWidth: true })
    const note = upgradeNode(noteType, legacy('note', { text: 'memo', w: 220, h: 200, color: '#fff3bf', fontSize: 12 }))
    expect(note.props).toEqual({ paragraphs: richTextFromPlain('memo'), w: 220, h: 200, color: '#fff3bf', fontSize: 12 })
    expect(migratePlainTextProps({ w: 1 })).toEqual({ w: 1, paragraphs: richTextFromPlain('') })
    // 今の版のノードはそのまま
    expect(upgradeNode(textType, text)).toBe(text)
    expect(textType.defaultProps().paragraphs).toEqual(richTextFromPlain(''))
  })

  it('still reads records that missed the migration', () => {
    expect(paragraphsOf({ text: 'x' })).toEqual(richTextFromPlain('x'))
    expect(paragraphsOf({ paragraphs: sample })).toBe(sample)
  })
})
