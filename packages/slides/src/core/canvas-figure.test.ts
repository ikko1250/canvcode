import { describe, expect, it } from 'vitest'
import { canvasFigureFrameId, canvasFigurePath, deckCanvasFigures, figureSlotSize } from './canvas-figure.ts'
import { parseMarkdownDeck } from './markdown-deck.ts'
import { serializeDeck } from './markdown-deck-writer.ts'
import { normalizeDeckData } from './slide-schema.ts'
import { TABLE_IMAGE_SPEC, TABLE_IMAGES_SPEC } from './slide-layout-spec.ts'

// キャンバスのフレームを図にする（提案 B）：canvas:<フレームの id> のパス

const FRAME = 'node:AbCdEf0123456789'

const MARKDOWN = `# 1 図 {#one}

| a | b |

![構成](canvas:${FRAME})

# 2 図 {#two}

| a | b |

![左](assets/l.png "左")
![右](canvas:node:Other0123456789 "右"){zoom=1.5}
`

describe('canvas figure paths', () => {
  it('reads the frame id only from well-formed paths', () => {
    expect(canvasFigureFrameId(canvasFigurePath(FRAME))).toBe(FRAME)
    expect(canvasFigureFrameId('assets/a.png')).toBeNull()
    expect(canvasFigureFrameId('canvas:oops')).toBeNull()
    expect(canvasFigureFrameId('canvas:node:a/../b')).toBeNull()
  })

  it('round-trips canvas figures through Markdown and JSON', () => {
    const deck = normalizeDeckData(parseMarkdownDeck(MARKDOWN, 'd.slide.md'), 'd.slide.md')
    expect(serializeDeck(deck, 'd.slide.md')).toBe(MARKDOWN)
    const json = serializeDeck(deck, 'd.slide.json')
    expect(normalizeDeckData(JSON.parse(json), 'd.slide.json')).toEqual(deck)
  })

  it('lists the frames a deck uses, with the slide and slot', () => {
    const deck = normalizeDeckData(parseMarkdownDeck(MARKDOWN, 'd.slide.md'), 'd.slide.md')
    expect(deckCanvasFigures(deck)).toEqual([
      { frameId: FRAME, slideKey: 'one', slot: 'image' },
      { frameId: 'node:Other0123456789', slideKey: 'two', slot: 'images.1' },
    ])
  })
})

describe('figureSlotSize', () => {
  it('matches the figure area of a one-figure slide', () => {
    const size = figureSlotSize('image')
    expect(size.w).toBe(TABLE_IMAGE_SPEC.figureWidth - TABLE_IMAGE_SPEC.figurePadding * 2)
    expect(size.h).toBe(TABLE_IMAGE_SPEC.height - TABLE_IMAGE_SPEC.figurePadding * 2)
  })

  it('gets shorter as a two-figure slide gets more rows, and never fails on odd row counts', () => {
    const one = figureSlotSize('images.0', 1)
    const two = figureSlotSize('images.1', 2)
    expect(one.w).toBe(TABLE_IMAGES_SPEC.figureColumnWidth)
    expect(two.h).toBeLessThan(one.h)
    expect(figureSlotSize('images.0', 0)).toEqual(one)
    expect(figureSlotSize('images.0', 99).h).toBeGreaterThan(0)
  })
})
