import { describe, expect, it } from 'vitest'
import { deckFromData, deckToData, duplicateDraftSlide, ensureDraftSlideNames, newSlide } from '../editor/state.ts'
import { assignSlideNames, newSlideName, slideKey } from './slide-ids.ts'
import { SLIDE_NAME_PATTERN, type DeckData } from './slide-schema.ts'

// スライドの id（キャンバスの画像と結び付ける）

describe('slide ids', () => {
  it('gives every unnamed slide a unique id and keeps the names people gave', () => {
    const deck: DeckData = { slides: [{ title: 'a', name: 'cover' }, { title: 'b' }, { title: 'c' }] }
    const named = assignSlideNames(deck)
    const names = named.slides.map((slide) => slide.name!)
    expect(names[0]).toBe('cover')
    expect(new Set(names).size).toBe(3)
    for (const name of names) expect(name).toMatch(SLIDE_NAME_PATTERN)
    // 全部に名前があれば、そのまま返す
    expect(assignSlideNames(named)).toBe(named)
  })

  it('avoids ids already taken', () => {
    const taken = new Set(['s-aaaaaa'])
    for (let i = 0; i < 50; i++) expect(taken.has(newSlideName(taken))).toBe(false)
  })

  it('falls back to the position for a slide without an id', () => {
    expect(slideKey({ name: 'cover' }, 3)).toBe('cover')
    expect(slideKey({}, 3)).toBe('@3')
  })
})

describe('editor drafts', () => {
  it('assigns ids when a deck is loaded, and to new and duplicated slides', () => {
    const draft = deckFromData({ slides: [{ title: 'a' }, { title: 'b', name: 'keep' }] })
    expect(draft.slides[0]?.name).toMatch(/^s-/)
    expect(draft.slides[1]?.name).toBe('keep')
    expect(newSlide('title').name).toMatch(/^s-/)
    const copy = duplicateDraftSlide(draft.slides[1]!)
    expect(copy.name).toMatch(/^s-/)
    expect(copy.name).not.toBe('keep')
    // 読み込んだ id は、そのまま保存される
    expect((deckToData(draft).slides as { name?: string }[]).map((slide) => slide.name)).toEqual(draft.slides.map((slide) => slide.name))
  })

  it('fills a cleared name field before saving', () => {
    const draft = deckFromData({ slides: [{ title: 'a' }, { title: 'b' }] })
    const cleared = { ...draft, slides: [{ ...draft.slides[0]!, name: '' }, draft.slides[1]!] }
    const filled = ensureDraftSlideNames(cleared)
    expect(filled.slides[0]?.name).toMatch(/^s-/)
    expect(filled.slides[1]?.name).toBe(draft.slides[1]?.name)
    expect(ensureDraftSlideNames(filled)).toBe(filled)
  })
})
