import { describe, expect, it } from 'vitest'
import {
  applyRunFormat,
  clearRunFormat,
  formatAt,
  formatListNumber,
  formatsInRange,
  indentList,
  listMarkers,
  listNumbers,
  listOf,
  listShortcut,
  listStyleOf,
  listStyleTargets,
  MAX_LIST_LEVEL,
  migratePlainTextProps,
  normalizeRichText,
  paragraphsOf,
  paragraphText,
  plainTextOf,
  replaceRange,
  richTextFromPlain,
  richTextLength,
  setListStyle,
  setListType,
  sliceRichText,
  withList,
  type TextList,
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

// 箇条書き・番号付きリスト（MAI-78）
describe('lists', () => {
  const p = (text: string, list?: TextList): TextParagraph => (list ? { runs: [{ text }], list } : { runs: [{ text }] })
  const ordered = (level = 0, style?: TextList['style']): TextList => (style ? { type: 'ordered', level, style } : { type: 'ordered', level })
  const bullet = (level = 0, style?: TextList['style']): TextList => (style ? { type: 'bullet', level, style } : { type: 'bullet', level })

  it('reads list attributes defensively and cycles the default style per level', () => {
    expect(listOf(p('a'))).toBeUndefined()
    expect(listOf({ runs: [], list: { type: 'x' } as unknown as TextList })).toBeUndefined()
    expect(listOf({ runs: [], list: { type: 'bullet', level: 99, style: 'decimal' } as TextList })).toEqual({ type: 'bullet', level: MAX_LIST_LEVEL })
    expect([0, 1, 2, 3].map((level) => listStyleOf(bullet(level)))).toEqual(['disc', 'circle', 'square', 'disc'])
    expect([0, 1, 2, 3].map((level) => listStyleOf(ordered(level)))).toEqual(['decimal', 'lower-alpha', 'lower-roman', 'decimal'])
    expect(listStyleOf(bullet(1, 'check'))).toBe('check')
  })

  it('formats numbers in every style', () => {
    expect(formatListNumber(3, 'decimal')).toBe('3.')
    expect(formatListNumber(3, 'decimal-paren')).toBe('3)')
    expect(formatListNumber(3, 'paren-decimal')).toBe('(3)')
    expect([1, 26, 27, 28].map((n) => formatListNumber(n, 'lower-alpha'))).toEqual(['a.', 'z.', 'aa.', 'ab.'])
    expect([1, 4, 9, 14, 1994].map((n) => formatListNumber(n, 'lower-roman'))).toEqual(['i.', 'iv.', 'ix.', 'xiv.', 'mcmxciv.'])
    expect([1, 20, 21, 36, 50, 51].map((n) => formatListNumber(n, 'circled'))).toEqual(['①', '⑳', '㉑', '㊱', '㊿', '(51)'])
  })

  it('numbers consecutive paragraphs of the same type and level, restarting where the list breaks', () => {
    const paragraphs = [
      p('one', ordered()),
      p('nested', ordered(1)),
      p('nested 2', ordered(1)),
      p('two', ordered()),
      // 浅い階層が挟まったので、深い階層は数え直す
      p('nested again', ordered(1)),
      p('deep bullet', bullet(2)),
      p('three', ordered()),
      // 同じ階層の箇条書きが挟まると、その階層は数え直す
      p('bullet', bullet()),
      p('one again', ordered()),
      // リストでない段落が挟まると数え直す
      p('plain'),
      p('restart', ordered(0, 'circled')),
      p('next', ordered(0, 'lower-roman')),
    ]
    expect(listNumbers(paragraphs)).toEqual([1, 1, 2, 2, 1, null, 3, null, 1, null, 1, 2])
    expect(listMarkers(paragraphs)).toEqual(['1.', 'a.', 'b.', '2.', 'a.', '▪', '3.', '•', '1.', null, '①', 'ii.'])
  })

  it('keeps list attributes through edits: splitting, joining, slicing', () => {
    const paragraphs = [p('ab', bullet(1)), p('cd')]
    // 段落を分けると、どちらも属性を持つ
    const split = replaceRange(paragraphs, 1, 1, [{ runs: [], list: bullet(1) }, { runs: [], list: bullet(1) }])
    expect(split.map((x) => x.list)).toEqual([bullet(1), bullet(1), undefined])
    // つなぐと前の段落の属性
    expect(replaceRange(paragraphs, 2, 3, [])).toEqual([{ runs: [{ text: 'abcd' }], list: bullet(1) }])
    expect(sliceRichText(paragraphs, 1, 4)).toEqual([{ runs: [{ text: 'b' }], list: bullet(1) }, { runs: [{ text: 'c' }] }])
  })

  it('sets the list type of the paragraphs in a range, or of all paragraphs', () => {
    const paragraphs = [p('a'), p('b', bullet(1, 'check')), p('c', ordered(2))]
    // 'a|b' を選ぶ → a と b
    expect(setListType(paragraphs, { start: 0, end: 3 }, 'ordered').map((x) => x.list)).toEqual([ordered(0), ordered(1), ordered(2)])
    expect(setListType(paragraphs, null, 'bullet').map((x) => x.list)).toEqual([bullet(0), bullet(1, 'check'), bullet(2)])
    expect(setListType(paragraphs, null, 'none').every((x) => !('list' in x))).toBe(true)
    // カーソルだけ（空の範囲）なら、その段落
    expect(setListType(paragraphs, { start: 5, end: 5 }, 'none').map((x) => x.list)).toEqual([undefined, bullet(1, 'check'), undefined])
  })

  it('applies a style to the shallowest level, keeping deeper levels on their defaults', () => {
    const paragraphs = [p('a', bullet(0)), p('b', bullet(1)), p('c', ordered(1)), p('d')]
    const styled = setListStyle(paragraphs, null, 'check')
    expect(styled.map((x) => x.list)).toEqual([bullet(0, 'check'), bullet(1), bullet(1), bullet(0, 'check')])
    expect(listStyleTargets(styled, null).map(paragraphText)).toEqual(['a', 'd'])
    // 深い段落だけを選べば、そこに当てる
    expect(setListStyle(paragraphs, { start: 2, end: 5 }, 'circled').map((x) => x.list)).toEqual([bullet(0), ordered(1, 'circled'), ordered(1, 'circled'), undefined])
  })

  it('indents and outdents list paragraphs, taking the style of the level it moves to', () => {
    const paragraphs = [p('a', bullet(0, 'check')), p('b', bullet(1, 'dash')), p('c', bullet(0, 'check')), p('plain')]
    // c を 1 段下げる → 上の b（階層 1）の形
    expect(indentList(paragraphs, { start: 4, end: 4 }, 1)[2].list).toEqual(bullet(1, 'dash'))
    // b を 1 段上げる → 上の a（階層 0）の形
    expect(indentList(paragraphs, { start: 2, end: 2 }, -1)[1].list).toEqual(bullet(0, 'check'))
    // a を下げる → 同じ階層の項目がないので、階層ごとの既定
    expect(indentList(paragraphs, { start: 0, end: 0 }, 1)[0].list).toEqual(bullet(1))
    // 範囲の中のリストでない段落はそのまま、端では止まる
    const all = indentList(paragraphs, { start: 0, end: 12 }, -1)
    expect(all.map((x) => x.list?.level)).toEqual([0, 0, 0, undefined])
  })

  it('recognizes the typed shortcuts', () => {
    expect(listShortcut('-')).toEqual(bullet())
    expect(listShortcut('*')).toEqual(bullet())
    expect(listShortcut('1.')).toEqual(ordered())
    expect(listShortcut('1)')).toEqual(ordered(0, 'decimal-paren'))
    expect(listShortcut('2.')).toBeNull()
    expect(listShortcut('a -')).toBeNull()
    expect(withList(p('x', bullet()), undefined)).toEqual(p('x'))
  })
})
