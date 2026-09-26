import { describe, expect, it } from 'vitest'
import { figureRequestFromUrl, figureUrl, newFigureUrl } from './figureUrls.ts'

// スライドエディタからキャンバスへ移る URL（提案 B）

describe('figure URLs', () => {
  it('round-trips a new-figure request', () => {
    const url = newFigureUrl({ frameId: 'node:AbCdEf0123456789', deckId: 'file:deck', w: 920.4, h: 732, name: '構成 & 流れ' })
    expect(figureRequestFromUrl(new URL(url, 'http://x').search)).toEqual({
      kind: 'new',
      frameId: 'node:AbCdEf0123456789',
      deckId: 'file:deck',
      w: 920,
      h: 732,
      name: '構成 & 流れ',
    })
  })

  it('round-trips an open request', () => {
    expect(figureRequestFromUrl(new URL(figureUrl('node:AbCdEf0123456789'), 'http://x').search)).toEqual({ kind: 'open', frameId: 'node:AbCdEf0123456789' })
  })

  it('ignores other URLs and bad ids, and clamps sizes', () => {
    expect(figureRequestFromUrl('')).toBeNull()
    expect(figureRequestFromUrl('?figure=canvas:x')).toBeNull()
    expect(figureRequestFromUrl('?new-figure=node:a')).toBeNull()
    expect(figureRequestFromUrl('?new-figure=node:a&deck=file:d&w=1&h=abc')).toMatchObject({ w: 40, h: 732, name: '図' })
  })
})
