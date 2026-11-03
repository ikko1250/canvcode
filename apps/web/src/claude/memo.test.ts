import { listMarkers, plainTextOf } from '@canvcode/nodes'
import { describe, expect, it } from 'vitest'
import { memoParagraphs } from './memo.ts'

// 箇条書きのメモの項目を、付箋の段落にする

describe('memoParagraphs', () => {
  it('項目ごとに、深さを持った箇条書きの段落にする', () => {
    const paragraphs = memoParagraphs([
      { text: '受信側も AI を使う', level: 0 },
      { text: '送信側も AI で喋る', level: 1 },
      { text: '人間の役割は何か', level: 0 },
    ])
    expect(paragraphs).toEqual([
      { runs: [{ text: '受信側も AI を使う' }], list: { type: 'bullet', level: 0 } },
      { runs: [{ text: '送信側も AI で喋る' }], list: { type: 'bullet', level: 1 } },
      { runs: [{ text: '人間の役割は何か' }], list: { type: 'bullet', level: 0 } },
    ])
    expect(plainTextOf(paragraphs)).toBe('受信側も AI を使う\n送信側も AI で喋る\n人間の役割は何か')
    expect(listMarkers(paragraphs)).toEqual(['•', '◦', '•'])
  })

  it('元の文字の書式を引き継ぎ、深さは付箋のリストの範囲に収める', () => {
    expect(memoParagraphs([{ text: 'a', level: 99 }], { color: '#ff0000' })).toEqual([{ runs: [{ text: 'a', format: { color: '#ff0000' } }], list: { type: 'bullet', level: 8 } }])
    expect(memoParagraphs([{ text: 'a', level: -1 }])[0]!.list).toEqual({ type: 'bullet', level: 0 })
  })
})
