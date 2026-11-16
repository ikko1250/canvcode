import { listMarkers, plainTextOf, richTextFromPlain, type TextRunFormat } from '@canvcode/nodes'
import { describe, expect, it } from 'vitest'
import { memoParagraphs, memoSource } from './memo.ts'

// 箇条書きのメモ：付箋の文字を Markdown にして頼み、答えの段落を付箋の段落にする

const BASE: Required<TextRunFormat> = { color: '#2b2930', fontSize: 12, fontFamily: 'sans-serif', fontWeight: 400, bold: false, italic: false, underline: false, strikethrough: false }
const item = (text: string, level: number, format?: TextRunFormat) => ({ runs: [format ? { text, format } : { text }], list: { type: 'bullet' as const, level } })

describe('memoSource', () => {
  it('渡すのは付箋の文字の Markdown（書式のない文字はそのまま）', () => {
    expect(memoSource(richTextFromPlain('えっと、予算を決める'), BASE)).toEqual({ markdown: 'えっと、予算を決める' })
    expect(memoSource([{ runs: [{ text: 'えっと、' }, { text: '予算', format: { fontWeight: 700 } }, { text: 'を決める' }] }], BASE)).toEqual({ markdown: 'えっと、**予算**を決める' })
  })

  it('すべての文字に共通の書式は Markdown に書かず、別に返す', () => {
    const red = { color: '#e03131', fontSize: 20 }
    expect(memoSource([{ runs: [{ text: 'あ', format: red }, { text: 'い', format: { ...red, fontWeight: 700 } }] }, { runs: [{ text: '', format: red }] }], BASE)).toEqual({
      markdown: 'あ**い**\n\n',
      common: red,
    })
  })
})

describe('memoParagraphs', () => {
  it('答えの箇条書きの段落を、そのまま付箋の段落にする', () => {
    const paragraphs = memoParagraphs([item('受信側も AI を使う', 0), item('送信側も AI で喋る', 1), item('人間の役割は何か', 0)], BASE)
    expect(paragraphs).toEqual([item('受信側も AI を使う', 0), item('送信側も AI で喋る', 1), item('人間の役割は何か', 0)])
    expect(plainTextOf(paragraphs)).toBe('受信側も AI を使う\n送信側も AI で喋る\n人間の役割は何か')
    expect(listMarkers(paragraphs)).toEqual(['•', '◦', '•'])
  })

  it('共通の書式を重ね、付箋の既定と同じ値は持たない', () => {
    const red = { color: '#e03131' }
    // a は答えが既定の色に戻した語（付箋の既定と同じなので持たない）
    expect(memoParagraphs([item('a', 0, { fontWeight: 700, color: '#2b2930' }), item('b', 0)], BASE, red)).toEqual([item('a', 0, { fontWeight: 700 }), item('b', 0, red)])
    expect(memoParagraphs([item('a', 0, { fontWeight: 700, fontSize: 12 })], BASE)).toEqual([item('a', 0, { fontWeight: 700 })])
  })
})
