import { describe, expect, it } from 'vitest'
import { lintDeck } from './deck-lint.ts'
import { parseMarkdownDeck } from './markdown-deck.ts'
import { serializeDeck } from './markdown-deck-writer.ts'
import { normalizeDeckData, type DeckData } from './slide-schema.ts'

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
![図](assets/a.png)
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
    expect(deck.slides[3]?.image).toEqual({ path: 'assets/a.png', alt: '図' })
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
