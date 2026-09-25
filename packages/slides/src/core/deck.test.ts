import { describe, expect, it } from 'vitest'
import { lintDeck, lintSlide } from './deck-lint.ts'
import { parseMarkdownDeck } from './markdown-deck.ts'
import { serializeDeck } from './markdown-deck-writer.ts'
import { normalizeDeckData, type DeckData } from './slide-schema.ts'
import { computeSlideGeometry } from './slide-layout-spec.ts'

// スライドデッキの読み書き（Markdown / JSON）と lint

const MARKDOWN = `---
deckTitle: 例
---

# 表紙 {#cover}
## 副題
山田

# 表 {#t1}
| ラベル | 本文 |
|---|---|
| A | **強調**<br>2 行目 |

# 箇条 {#b1}
- 一
  - 二
- 三

# 図 {#img}
| x | y |
![図](assets/a.png){zoom=1.5 x=-10 y=5}
`

function parse(text: string, name = 'deck.slide.md'): DeckData {
  return normalizeDeckData(name.endsWith('.json') ? JSON.parse(text) : parseMarkdownDeck(text, name), name)
}

describe('Markdown deck', () => {
  it('infers layouts from the content', () => {
    const deck = parse(MARKDOWN)
    expect(deck.deckTitle).toBe('例')
    expect(deck.slides.map((slide) => [slide.name, slide.layout ?? 'table'])).toEqual([
      ['cover', 'title'],
      ['t1', 'table'],
      ['b1', 'bullets'],
      ['img', 'table-image'],
    ])
    expect(deck.slides[0]).toMatchObject({ subtitle: ['副題'], credits: ['山田'] })
    // 表のヘッダー行は読み飛ばし、<br> はセル内の改行になる
    expect(deck.slides[1]?.rows).toEqual([{ labelLines: ['A'], bodyLines: ['**強調**', '2 行目'] }])
    expect(deck.slides[2]?.items).toEqual([{ text: '一', children: ['二'] }, '三'])
    expect(deck.slides[3]?.image).toEqual({ path: 'assets/a.png', alt: '図', zoom: 1.5, x: -10, y: 5 })
  })

  it('round-trips through Markdown and JSON without changing the deck', () => {
    const deck = parse(MARKDOWN)
    const markdown = serializeDeck(deck, 'deck.slide.md')
    expect(parse(markdown)).toEqual(deck)
    // 正準化した Markdown は、もう一度書き出しても変わらない
    expect(serializeDeck(parse(markdown), 'deck.slide.md')).toBe(markdown)
    const json = serializeDeck(deck, 'deck.slide.json')
    expect(parse(json, 'deck.slide.json')).toEqual(deck)
  })

  it('refuses to save content that Markdown would change', () => {
    const deck = { slides: [{ layout: 'table', title: 't', rows: [{ labelLines: ['a'], bodyLines: [' 前後に空白 '] }] }] }
    expect(() => serializeDeck(deck, 'deck.slide.md')).toThrow('Markdown として保存すると内容が変わる')
    // JSON なら保存できる
    expect(parse(serializeDeck(deck, 'deck.slide.json'), 'deck.slide.json').slides[0]?.rows?.[0]?.bodyLines).toEqual([' 前後に空白 '])
  })

  it('reports errors with the file name and line', () => {
    expect(() => parseMarkdownDeck('# a\n\n# c\n## d\n| a | b |', 'x.md')).toThrow(/^x\.md:\d+: .*副題/)
    expect(() => normalizeDeckData({ slides: [] }, 'x.json')).toThrow('slides には1件以上')
    expect(() => normalizeDeckData({ slides: [{ title: 't', bogus: 1 }] }, 'x.json')).toThrow('未知のキー "bogus"')
  })

  it('rejects unknown file extensions', () => {
    expect(() => serializeDeck(parse(MARKDOWN), 'deck.txt')).toThrow('.md または .json')
  })
})

describe('image zoom/x/y', () => {
  it('parses the attribute block after an image, on both single and two-image lines', () => {
    const md = `# 図 {#img}\n| x | y |\n![図](assets/a.png){zoom=1.5 x=-10 y=5}\n`
    const deck = parse(md)
    expect(deck.slides[0]?.image).toEqual({ path: 'assets/a.png', alt: '図', zoom: 1.5, x: -10, y: 5 })

    const md2 = `# 比較 {#compare}\n| a | b |\n![旧](assets/old.png "旧版"){zoom=2}\n![新](assets/new.png "新版"){x=-20 y=30}\n`
    const deck2 = parse(md2)
    expect(deck2.slides[0]?.images).toEqual([
      { path: 'assets/old.png', alt: '旧', title: '旧版', zoom: 2 },
      { path: 'assets/new.png', alt: '新', title: '新版', x: -20, y: 30 },
    ])
  })

  it('drops the attribute block for default values on normalize and serialize', () => {
    const md = `# 図 {#img}\n| x | y |\n![図](assets/a.png){zoom=1 x=0 y=0}\n`
    const deck = parse(md)
    expect(deck.slides[0]?.image).toEqual({ path: 'assets/a.png', alt: '図' })
    const markdown = serializeDeck(deck, 'deck.slide.md')
    expect(markdown).toContain('![図](assets/a.png)\n')
    expect(markdown).not.toContain('zoom=')
  })

  it('round-trips adjusted images through Markdown and JSON', () => {
    const deck = parse(MARKDOWN)
    const markdown = serializeDeck(deck, 'deck.slide.md')
    expect(markdown).toContain('{zoom=1.5 x=-10 y=5}')
    expect(parse(markdown)).toEqual(deck)
    const json = serializeDeck(deck, 'deck.slide.json')
    expect(parse(json, 'deck.slide.json')).toEqual(deck)
  })

  it('rejects malformed attribute blocks with the file name and line', () => {
    const withAttrs = (attrs: string) => `# 図 {#img}\n| x | y |\n![図](assets/a.png){${attrs}}\n`
    expect(() => parseMarkdownDeck(withAttrs('zoom=abc'), 'x.md')).toThrow(/^x\.md:\d+: .*画像属性/)
    expect(() => parseMarkdownDeck(withAttrs('foo=1'), 'x.md')).toThrow(/^x\.md:\d+: .*画像属性/)
    expect(() => parseMarkdownDeck(withAttrs('zoom=1 zoom=2'), 'x.md')).toThrow(/^x\.md:\d+: .*画像属性/)
  })

  it('rejects out-of-range or wrong-typed values in normalizeDeckData', () => {
    const deckWith = (image: Record<string, unknown>) => ({
      slides: [{ layout: 'table-image', title: 't', rows: [{ labelLines: ['a'], bodyLines: ['b'] }], image: { path: 'a.png', alt: 'a', ...image } }],
    })
    expect(() => normalizeDeckData(deckWith({ zoom: 5 }), 'x.json')).toThrow(/zoom/)
    expect(() => normalizeDeckData(deckWith({ x: 101 }), 'x.json')).toThrow(/x/)
    expect(() => normalizeDeckData(deckWith({ zoom: '1' }), 'x.json')).toThrow(/zoom/)
  })
})

describe('lintDeck', () => {
  it('warns about rows that overflow the slide', () => {
    const rows = Array.from({ length: 6 }, () => ({ labelLines: ['a'], bodyLines: ['長い本文'.repeat(40)] }))
    const deck = normalizeDeckData({ slides: [{ layout: 'title', title: '表紙' }, { layout: 'table', title: 't', rows }] }, 'x.json')
    const lint = lintDeck(deck)
    expect(lint.slides[0]?.capacityWarnings).toEqual([])
    expect(lint.warnings).toHaveLength(1)
    expect(lint.warnings[0]).toContain('容量超過')
  })
})

describe('full-panel fallback', () => {
  it('switches a compact table-image slide to the full-height panel when the rows do not fit', () => {
    // 3 行の table-image は compact（行高 162px、予算 576px）。4 行に折り返す本文が 2 行あると収まらない
    const long = '相対取引、スポット市場、時間前取引を通じて、需給が一致するように調整する。'
    const rows = [
      { labelLines: ['電力小売'], bodyLines: [long] },
      { labelLines: ['残余'], bodyLines: ['それでも残った、需給の差がインバランス'] },
      { labelLines: ['料金'], bodyLines: [long] },
    ]
    const compact = computeSlideGeometry('table-image', 3)
    expect(compact.compact).toBe(true)
    const lint = lintSlide({ layout: 'table-image', title: 't', rows, image: { path: 'a.png', alt: 'a' } }, 0)
    expect(lint.computedFullPanel).toBe(true)
    expect(lint.capacityWarnings.some((w) => w.includes('超過'))).toBe(false)
    expect(lint.capacityWarnings[0]).toContain('全高パネル')
    const full = computeSlideGeometry('table-image', 3, { forceFull: true })
    expect(full.compact).toBe(false)
    expect(full.panelHeight).toBe(772)
    expect(full.grid.defaultRowPx).toBeGreaterThanOrEqual(195)
  })

  it('keeps the compact panel when the rows fit', () => {
    const rows = [
      { labelLines: ['a'], bodyLines: ['短い'] },
      { labelLines: ['b'], bodyLines: ['短い'] },
      { labelLines: ['c'], bodyLines: ['短い'] },
    ]
    const lint = lintSlide({ layout: 'table-image', title: 't', rows, image: { path: 'a.png', alt: 'a' } }, 0)
    expect(lint.computedFullPanel).toBeUndefined()
    expect(lint.capacityWarnings).toEqual([])
  })

  it('still warns when even the full-height panel cannot hold the rows', () => {
    const rows = Array.from({ length: 3 }, () => ({ labelLines: ['a'], bodyLines: ['長い本文'.repeat(40)] }))
    const lint = lintSlide({ layout: 'table-image', title: 't', rows, image: { path: 'a.png', alt: 'a' } }, 0)
    expect(lint.computedFullPanel).toBeUndefined()
    expect(lint.capacityWarnings.join('\n')).toContain('超過')
  })
})
