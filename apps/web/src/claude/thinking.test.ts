import { describe, expect, it } from 'vitest'
import { thinkingBlocks } from './thinking.ts'

// 考えている中身を、段落と調べている行のまとまりに分ける

describe('thinkingBlocks', () => {
  it('splits the thinking into paragraphs and runs of search lines, dropping the extra blank lines between them', () => {
    const text =
      'The user wants me to run searches,\nso I will fire off several.\n\n― Web で調べる：容量市場 問題点\n\n\n\n― Web で調べる：容量拠出金 新電力\n\n\n\n― ページを読む：https://www.occto.or.jp/\n\nI am reading the results.\n\n\n\nNow I write.'
    expect(thinkingBlocks(text)).toEqual([
      { kind: 'text', text: 'The user wants me to run searches,\nso I will fire off several.' },
      { kind: 'tool', lines: ['Web で調べる：容量市場 問題点', 'Web で調べる：容量拠出金 新電力', 'ページを読む：https://www.occto.or.jp/'] },
      { kind: 'text', text: 'I am reading the results.' },
      { kind: 'text', text: 'Now I write.' },
    ])
    expect(thinkingBlocks('')).toEqual([])
  })
})
