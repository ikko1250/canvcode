import { describe, expect, it } from 'vitest'
import { lookupHeading, lookupMemo } from './lookup.ts'

// 調べた語を、吹き出しと引用ノートのメモにする（MAI-99）

describe('lookupHeading と lookupMemo', () => {
  it('品詞と発音記号を 1 行にし、/ で囲む（囲んであればそのまま）', () => {
    expect(lookupHeading({ partOfSpeech: '名詞', reading: 'ˈkɔːrpəs' })).toBe('名詞 /ˈkɔːrpəs/')
    expect(lookupHeading({ partOfSpeech: '名詞', reading: '/ˈkɔːrpəs/' })).toBe('名詞 /ˈkɔːrpəs/')
    expect(lookupHeading({ reading: '[kəˈrɪə]' })).toBe('[kəˈrɪə]')
  })

  it('日本語の読みは括弧に入れる。どちらもなければ空', () => {
    expect(lookupHeading({ partOfSpeech: '名詞', reading: 'きかいがくしゅう' })).toBe('名詞 （きかいがくしゅう）')
    expect(lookupHeading({})).toBe('')
    // 書き方の決まった読み方（かなと発音記号を並べたものなど）は、そのまま
    expect(lookupHeading({ partOfSpeech: '熟語', reading: 'ステート・オブ・ザ・アート（/steɪt əv ðə ɑːrt/）' })).toBe('熟語 ステート・オブ・ザ・アート（/steɪt əv ðə ɑːrt/）')
  })

  it('メモは 1 行目に品詞と読み方、そのあとに意味', () => {
    expect(lookupMemo({ phrase: 'corpus', meaning: '文章の集まり', partOfSpeech: '名詞', reading: 'ˈkɔːrpəs', model: 'm' })).toBe('名詞 /ˈkɔːrpəs/\n文章の集まり')
    expect(lookupMemo({ phrase: '語', meaning: '意味', model: 'm' })).toBe('意味')
  })
})
