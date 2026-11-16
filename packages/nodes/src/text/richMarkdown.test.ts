import { describe, expect, it } from 'vitest'
import { hasRichFormatting, MARKDOWN_CODE_FONT, markdownShortcutAt, parseRichMarkdown, richTextFromMarkdown, richTextFromPaste, richTextToMarkdown, standardMarkdownOf } from './richMarkdown.ts'
import { DEFAULT_LIST_STYLES, listOf, normalizeRichText, richTextFromPlain, withList, type TextListStyle, type TextParagraph, type TextRunFormat } from './richText.ts'

// 付箋の既定の書式（baseFormatOf(noteStyle(...)) と同じ形）
const NOTE_BASE: Required<TextRunFormat> = {
  color: '#2b2930',
  fontSize: 12,
  fontFamily: 'sans-serif',
  fontWeight: 400,
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
}

const md = (text: string, base?: TextRunFormat) => richTextFromMarkdown(text, base ? { base } : {})

describe('parseRichMarkdown: paragraphs', () => {
  it('reads one paragraph per line, keeping empty lines', () => {
    expect(md('a\n\nb')).toEqual([{ runs: [{ text: 'a' }] }, { runs: [{ text: '' }] }, { runs: [{ text: 'b' }] }])
  })

  it('drops one trailing newline and reads CRLF', () => {
    expect(md('a\r\nb\r\n')).toEqual([{ runs: [{ text: 'a' }] }, { runs: [{ text: 'b' }] }])
    expect(md('')).toEqual([{ runs: [{ text: '' }] }])
  })

  it('keeps leading spaces of a paragraph that is not a list', () => {
    expect(md('  indented')).toEqual([{ runs: [{ text: '  indented' }] }])
  })
})

describe('parseRichMarkdown: inline formats', () => {
  it('reads bold, italic, strikethrough and code', () => {
    expect(md('**b** *i* ~~s~~ `c`')[0]!.runs).toEqual([
      { text: 'b', format: { fontWeight: 700 } },
      { text: ' ' },
      { text: 'i', format: { italic: true } },
      { text: ' ' },
      { text: 's', format: { strikethrough: true } },
      { text: ' ' },
      { text: 'c', format: { fontFamily: MARKDOWN_CODE_FONT } },
    ])
  })

  it('does not use _ for formats, nor a single * between ASCII letters or digits', () => {
    for (const text of ['def __init__(self): _x_', '2*3*4 = a*b*c', 'https://x/_foo_/bar']) expect(md(text)[0]!.runs).toEqual([{ text }])
    // ** は英数字に挟まれていても太字（普通の Markdown と同じ）
    expect(md('**URL**s **10**x **a**b**c**')[0]!.runs).toEqual([
      { text: 'URL', format: { fontWeight: 700 } },
      { text: 's ' },
      { text: '10', format: { fontWeight: 700 } },
      { text: 'x ' },
      { text: 'a', format: { fontWeight: 700 } },
      { text: 'b' },
      { text: 'c', format: { fontWeight: 700 } },
    ])
    expect(md('API**キー**と*重要*')[0]!.runs).toEqual([{ text: 'API' }, { text: 'キー', format: { fontWeight: 700 } }, { text: 'と' }, { text: '重要', format: { italic: true } }])
  })

  it('opens and closes next to Japanese punctuation and brackets', () => {
    expect(md('これは**「重要」**です')[0]!.runs).toEqual([
      { text: 'これは' },
      { text: '「重要」', format: { fontWeight: 700 } },
      { text: 'です' },
    ])
    expect(md('**予算**。~~旧案~~、')[0]!.runs).toEqual([
      { text: '予算', format: { fontWeight: 700 } },
      { text: '。' },
      { text: '旧案', format: { strikethrough: true } },
      { text: '、' },
    ])
  })

  it('nests bold and italic', () => {
    expect(md('***bi*** **b *bi***')[0]!.runs).toEqual([
      { text: 'bi', format: { fontWeight: 700, italic: true } },
      { text: ' ' },
      { text: 'b ', format: { fontWeight: 700 } },
      { text: 'bi', format: { fontWeight: 700, italic: true } },
    ])
  })

  it('leaves lone or spaced markers and snake_case as text', () => {
    expect(md('5 * 3 = 15, a_b_c, 1~2, **')[0]!.runs).toEqual([{ text: '5 * 3 = 15, a_b_c, 1~2, **' }])
  })

  it('reads backslash escapes', () => {
    expect(md('\\*not\\* \\[x\\]{y} C:\\Users')[0]!.runs).toEqual([{ text: '*not* [x]{y} C:\\Users' }])
  })

  it('keeps the text of code literally', () => {
    expect(md('`**a** [b]{.bold}`')[0]!.runs).toEqual([{ text: '**a** [b]{.bold}', format: { fontFamily: MARKDOWN_CODE_FONT } }])
  })
})

describe('parseRichMarkdown: [text]{attributes}', () => {
  it('reads colour, size, font, weight and classes', () => {
    expect(md('[a]{color=#e03131 size=20 font="M PLUS 1p" weight=600 .underline .italic .strike}')[0]!.runs).toEqual([
      { text: 'a', format: { color: '#e03131', fontSize: 20, fontFamily: 'M PLUS 1p', fontWeight: 600, underline: true, italic: true, strikethrough: true } },
    ])
    expect(md('[a]{.bold size=16px}')[0]!.runs).toEqual([{ text: 'a', format: { fontWeight: 700, fontSize: 16 } }])
  })

  it('nests spans and markdown inside spans', () => {
    expect(md('[a **b** [c]{size=20}]{color=#1971c2}')[0]!.runs).toEqual([
      { text: 'a ', format: { color: '#1971c2' } },
      { text: 'b', format: { color: '#1971c2', fontWeight: 700 } },
      { text: ' ', format: { color: '#1971c2' } },
      { text: 'c', format: { color: '#1971c2', fontSize: 20 } },
    ])
  })

  it('reports unknown attributes and bad values, and uses the rest', () => {
    const result = parseRichMarkdown('ok\n[a]{color=red .glow size=20 font=Mono}')
    expect(result.paragraphs[1]!.runs).toEqual([{ text: 'a', format: { fontSize: 20, fontFamily: 'Mono' } }])
    expect(result.issues).toEqual([expect.stringMatching(/^line 2: color=red: expected a hex colour/), expect.stringMatching(/^line 2: \.glow is not a known class/)])
  })

  it('does not report text that only looks like brackets and braces, but reports a span missing its }', () => {
    expect(parseRichMarkdown('[0-9]{3}-[0-9]{4} [a-z]{2,} [name]{{user}} arr[i]{x}').issues).toEqual([])
    expect(parseRichMarkdown('[x]{color=#e03131').issues).toEqual([expect.stringMatching(/missing \}/)])
  })

  it('accepts every size and weight it writes, and compares colours ignoring case', () => {
    expect(md('[a]{size=600 weight=450.5}')[0]!.runs).toEqual([{ text: 'a', format: { fontSize: 600, fontWeight: 450.5 } }])
    expect(md('[a]{color=#2B2930}', NOTE_BASE)[0]!.runs).toEqual([{ text: 'a' }])
  })

  it('reads a malformed span as text and reports it', () => {
    const result = parseRichMarkdown('[a]{color = #e03131} [b](https://example.com)')
    expect(result.paragraphs[0]!.runs).toEqual([{ text: '[a]{color = #e03131} [b](https://example.com)' }])
    expect(result.issues).toEqual([expect.stringMatching(/^line 1: "\[a\]\{color = #e03131\}" is not a \[text\]\{attributes\} span/)])
  })

  it('drops values that equal the node defaults', () => {
    expect(md('[a]{color=#2b2930 size=12} **b**', NOTE_BASE)[0]!.runs).toEqual([{ text: 'a ' }, { text: 'b', format: { fontWeight: 700 } }])
  })

  it('keeps the format of an empty span as the format of an empty paragraph', () => {
    expect(md('[]{color=#e03131}')).toEqual([{ runs: [{ text: '', format: { color: '#e03131' } }] }])
  })
})

describe('parseRichMarkdown: lists', () => {
  it('reads bullets and nesting with 2, 3 or 4 spaces', () => {
    for (const indent of ['  ', '   ', '    ']) {
      expect(md(`- a\n${indent}- b\n${indent}${indent}- c\n- d`).map((p) => listOf(p))).toEqual([
        { type: 'bullet', level: 0 },
        { type: 'bullet', level: 1 },
        { type: 'bullet', level: 2 },
        { type: 'bullet', level: 0 },
      ])
    }
  })

  it('reads numbered markers in the style they are written', () => {
    const paragraphs = md('1. a\n   a. b\n   b. c\n2) d\n(1) e\n① f\nx\ni. g\nii. h')
    expect(paragraphs.map((p) => listOf(p))).toEqual([
      { type: 'ordered', level: 0 },
      { type: 'ordered', level: 1 },
      { type: 'ordered', level: 1 },
      { type: 'ordered', level: 0, style: 'decimal-paren' },
      { type: 'ordered', level: 0, style: 'paren-decimal' },
      { type: 'ordered', level: 0, style: 'circled' },
      undefined,
      { type: 'ordered', level: 0, style: 'lower-roman' },
      { type: 'ordered', level: 0, style: 'lower-roman' },
    ])
    expect(paragraphs.map((p) => p.runs[0]!.text)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'x', 'g', 'h'])
  })

  it('reads a list only when it starts at 1 (a, i, ①)', () => {
    expect(md('3. x\n4. y\n(2) z\n② w').map((p) => listOf(p))).toEqual([undefined, undefined, undefined, undefined])
    expect(md('1. x\n1. y\n7. z').map((p) => listOf(p))).toEqual([{ type: 'ordered', level: 0 }, { type: 'ordered', level: 0 }, { type: 'ordered', level: 0 }])
  })

  it('skips empty lines between items, joins indented continuation lines, and drops spaces after the marker', () => {
    expect(md('1. a\n\n2. b\n\n\n3. c').map((p) => [listOf(p)?.type, p.runs[0]!.text])).toEqual([
      ['ordered', 'a'],
      ['ordered', 'b'],
      ['ordered', 'c'],
    ])
    expect(md('1. Step\n   continued here\n2. 次\n   の行\n\nafter')).toEqual([
      { runs: [{ text: 'Step continued here' }], list: { type: 'ordered', level: 0 } },
      { runs: [{ text: '次の行' }], list: { type: 'ordered', level: 0 } },
      { runs: [{ text: '' }] },
      { runs: [{ text: 'after' }] },
    ])
    expect(md('-   a\n1.  b').map((p) => p.runs[0]!.text)).toEqual(['a', 'b'])
  })

  it('skips an empty line only before a real item (not before a sentence like "etc. …")', () => {
    expect(md('- a\n\napprox. 5 items')).toEqual([{ runs: [{ text: 'a' }], list: { type: 'bullet', level: 0 } }, { runs: [{ text: '' }] }, { runs: [{ text: 'approx. 5 items' }] }])
    const paragraphs: TextParagraph[] = [{ runs: [{ text: 'a' }], list: { type: 'bullet', level: 0 } }, { runs: [{ text: '' }] }, { runs: [{ text: '  etc. x' }] }]
    expect(md(richTextToMarkdown(paragraphs))).toEqual(paragraphs)
  })

  it('reads circled numbers past 50, written as (51)', () => {
    const lines = Array.from({ length: 52 }, (_, i) => (i < 50 ? String.fromCodePoint(i < 20 ? 0x2460 + i : i < 35 ? 0x3251 + i - 20 : 0x32b1 + i - 35) : `(${i + 1})`) + ' x')
    expect(md(lines.join('\n')).map((p) => listOf(p)?.style)).toEqual(Array.from({ length: 52 }, () => 'circled'))
  })

  it('numbers on across styles at one level, so a roman i. after four items is text', () => {
    // 同じ階層の番号は、形が変わっても数え続ける（5 番目は v.）
    expect(listOf(md('1. a\n2) b\n(3) c\n④ d\ni. e')[4]!)).toBeUndefined()
    expect(listOf(md('1. a\n2) b\n(3) c\n④ d\nv. e')[4]!)).toEqual({ type: 'ordered', level: 0, style: 'lower-roman' })
  })

  it('reads a nested 1. as an explicit decimal list (the level default is a.)', () => {
    expect(listOf(md('1. a\n   1. b')[1]!)).toEqual({ type: 'ordered', level: 1, style: 'decimal' })
  })

  it('reads bullet glyphs as their styles', () => {
    expect(md('• a\n– b\n✓ c').map((p) => listOf(p))).toEqual([
      { type: 'bullet', level: 0 },
      { type: 'bullet', level: 0, style: 'dash' },
      { type: 'bullet', level: 0, style: 'check' },
    ])
  })

  it('reads letters as a list only when they are the next number', () => {
    expect(md('vs. b').map((p) => listOf(p))).toEqual([undefined])
    expect(md('a. x\nc. y').map((p) => listOf(p))).toEqual([{ type: 'ordered', level: 0, style: 'lower-alpha' }, undefined])
  })

  it('reads empty items and formats inside items', () => {
    expect(md('-\n- **b**')).toEqual([
      { runs: [{ text: '' }], list: { type: 'bullet', level: 0 } },
      { runs: [{ text: 'b', format: { fontWeight: 700 } }], list: { type: 'bullet', level: 0 } },
    ])
  })

  it('does not read emphasis or rules at the start of a line as bullets', () => {
    expect(md('*a* b\n---\n**c**').map((p) => listOf(p))).toEqual([undefined, undefined, undefined])
  })
})

describe('parseRichMarkdown: headings and code blocks', () => {
  it('makes headings bold and larger than the node default', () => {
    expect(md('# T\n## U\n#### V\n#tag', NOTE_BASE)).toEqual([
      { runs: [{ text: 'T', format: { fontWeight: 700, fontSize: 19 } }] },
      { runs: [{ text: 'U', format: { fontWeight: 700, fontSize: 16 } }] },
      { runs: [{ text: 'V', format: { fontWeight: 700 } }] },
      { runs: [{ text: '#tag' }] },
    ])
  })

  it('drops the indent of a fence from its lines', () => {
    expect(md('   ```\n   code\n     more\n   ```')).toEqual([
      { runs: [{ text: 'code', format: { fontFamily: MARKDOWN_CODE_FONT } }] },
      { runs: [{ text: '  more', format: { fontFamily: MARKDOWN_CODE_FONT } }] },
    ])
  })

  it('reads fenced lines as monospace paragraphs, and an unclosed fence as text', () => {
    expect(md('```js\nconst a = *b*\n\n```\nafter')).toEqual([
      { runs: [{ text: 'const a = *b*', format: { fontFamily: MARKDOWN_CODE_FONT } }] },
      { runs: [{ text: '', format: { fontFamily: MARKDOWN_CODE_FONT } }] },
      { runs: [{ text: 'after' }] },
    ])
    expect(md('```\nx')).toEqual([{ runs: [{ text: '```' }] }, { runs: [{ text: 'x' }] }])
  })
})

describe('limits', () => {
  it('reads long lines in linear time and deep nesting without overflowing the stack', () => {
    const inputs = [
      `# a${' '.repeat(40_000)}b`,
      'a* '.repeat(40_000),
      '['.repeat(40_000),
      '`'.repeat(3) + 'a'.repeat(40_000),
      'a*a'.repeat(40_000),
      `${'['.repeat(5_000)}x${']{.bold}'.repeat(5_000)}`,
      `${'*'.repeat(30_000)}x${'*'.repeat(30_000)}`,
      Array.from({ length: 4_000 }, () => '```js').join('\n'),
      Array.from({ length: 4_000 }, (_, i) => `${i === 0 ? 'a' : 'b'}. x`).join('\n'),
    ]
    for (const input of inputs) {
      const started = performance.now()
      expect(() => parseRichMarkdown(input)).not.toThrow()
      expect(performance.now() - started).toBeLessThan(1_000)
    }
    for (const input of ['[a]{'.repeat(20_000), '[a]{x='.repeat(20_000), `- a\n${'  b\n'.repeat(20_000)}`]) {
      const started = performance.now()
      const result = parseRichMarkdown(input)
      expect(performance.now() - started).toBeLessThan(1_000)
      expect(result.issues.length).toBeLessThanOrEqual(21)
    }
    const started = performance.now()
    richTextToMarkdown(Array.from({ length: 20_000 }, () => ({ runs: [{ text: '' }] })))
    richTextToMarkdown([{ runs: [{ text: `a${' '.repeat(40_000)}b`, format: { fontWeight: 700 } }] }])
    markdownShortcutAt(`\`${'a'.repeat(40_000)}\``)
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})

describe('richTextToMarkdown', () => {
  const p = (runs: TextParagraph['runs'], list?: TextParagraph['list']): TextParagraph => (list ? { runs, list } : { runs })

  it('writes plain text as it is, escaping only markdown characters', () => {
    expect(richTextToMarkdown(richTextFromPlain('会議の議題\nsnake_case と 5*3\n'))).toBe('会議の議題\nsnake_case と 5\\*3\n\n')
  })

  it('writes formats with delimiters and [text]{attributes}', () => {
    const paragraphs = [
      p([{ text: '会議の ' }, { text: '議題', format: { fontWeight: 700 } }]),
      p([{ text: '予算', format: { color: '#e03131' } }, { text: ' を決める' }], { type: 'bullet', level: 0 }),
      p([{ text: '20 万円まで', format: { fontSize: 16, fontFamily: 'M PLUS 1p' } }], { type: 'bullet', level: 1 }),
      p([{ text: '資料', format: { underline: true } }, { text: ' を送る' }], { type: 'bullet', level: 0 }),
    ]
    expect(richTextToMarkdown(paragraphs, { base: NOTE_BASE })).toBe('会議の **議題**\n- [予算]{color=#e03131} を決める\n  - [20 万円まで]{size=16 font="M PLUS 1p"}\n- [資料]{.underline} を送る')
  })

  it('keeps a mark open across runs', () => {
    const paragraphs = [p([{ text: 'a', format: { fontWeight: 700, color: '#e03131' } }, { text: 'b', format: { fontWeight: 700 } }])]
    expect(richTextToMarkdown(paragraphs)).toBe('**[a]{color=#e03131}b**')
  })

  it('writes code as backticks when it can', () => {
    expect(richTextToMarkdown([p([{ text: 'npm test', format: { fontFamily: MARKDOWN_CODE_FONT } }, { text: ' と ' }, { text: ' x`', format: { fontFamily: MARKDOWN_CODE_FONT } }])])).toBe(
      '`npm test` と [ x\\`]{font=monospace}',
    )
  })

  it('writes standard Markdown for other apps (no [text]{attributes})', () => {
    const paragraphs = [
      p([{ text: '予算', format: { color: '#e03131', fontWeight: 700 } }, { text: ' x ', format: { fontWeight: 700 } }, { text: 'y', format: { underline: true } }]),
      p([{ text: '', format: { fontWeight: 700 } }]),
      p([{ text: 'a' }], { type: 'bullet', level: 0 }),
    ]
    expect(richTextToMarkdown(paragraphs, { flavor: 'standard' })).toBe('**予算 x** y\n\n- a')
  })

  it('escapes quotes, rules and setext underlines for other apps', () => {
    const lines = ['Title', '---', '> quote', '==', '- - -']
    expect(standardMarkdownOf([{ runs: [{ text: 'b', format: { fontWeight: 700 } }] }, ...richTextFromPlain(lines.join('\n'))])).toBe('**b**\nTitle\n\\---\n\\> quote\n\\==\n\\- - -')
  })

  it('escapes _ for other apps, except between ASCII letters or digits', () => {
    expect(standardMarkdownOf([{ runs: [{ text: 'a', format: { fontWeight: 700 } }, { text: ' __x__ snake_case' }] }])).toBe('**a** \\_\\_x\\_\\_ snake_case')
    expect(standardMarkdownOf(richTextFromPlain('a_b'))).toBeNull()
  })

  it('keeps empty paragraphs between items and leading spaces that would read as indents', () => {
    const paragraphs = [
      p([{ text: 'a' }], { type: 'bullet', level: 0 }),
      p([{ text: '' }]),
      p([{ text: '  b' }], { type: 'bullet', level: 0 }),
      p([{ text: '  c' }]),
    ]
    const markdown = richTextToMarkdown(paragraphs)
    expect(markdown).toBe('- a\n[]{}\n- [  ]{}b\n[  ]{}c')
    expect(md(markdown)).toEqual(paragraphs)
  })

  it('writes a lone _ next to a formatted run as text (round trip)', () => {
    const paragraphs = [p([{ text: '_' }, { text: 'a', format: { color: '#e03131' } }, { text: '_' }]), p([{ text: 'x _' }, { text: 'a', format: { fontFamily: MARKDOWN_CODE_FONT } }, { text: '_ y' }])]
    expect(md(richTextToMarkdown(paragraphs))).toEqual(paragraphs)
  })

  it('writes bold spaces at the edge of a mark as a class', () => {
    expect(richTextToMarkdown([p([{ text: 'a ', format: { fontWeight: 700 } }, { text: 'b' }])])).toBe('**a**[ ]{.bold}b')
  })

  it('indents nested items to the text of their parent', () => {
    const paragraphs = [
      p([{ text: 'a' }], { type: 'ordered', level: 0 }),
      p([{ text: 'b' }], { type: 'ordered', level: 1 }),
      p([{ text: 'c' }], { type: 'bullet', level: 2 }),
      p([{ text: 'd' }], { type: 'bullet', level: 0, style: 'check' }),
    ]
    expect(richTextToMarkdown(paragraphs)).toBe('1. a\n   a. b\n      - c\n✓ d')
  })

  it('escapes the start of a paragraph that would read as a list or heading', () => {
    const lines = ['- a', '1. b', '2) c', '(3) d', '# e', '• f', 'i. g', '  + h', 'etc. i', '-x']
    const markdown = richTextToMarkdown(richTextFromPlain(lines.join('\n')))
    expect(markdown).toBe('\\- a\n1\\. b\n2\\) c\n\\(3) d\n\\# e\n\\• f\ni\\. g\n  \\+ h\netc. i\n-x')
    expect(md(markdown)).toEqual(richTextFromPlain(lines.join('\n')))
  })

  it('writes the format of an empty paragraph as an empty span', () => {
    expect(richTextToMarkdown([p([{ text: '', format: { fontWeight: 700 } }], { type: 'bullet', level: 0 })])).toBe('- []{.bold}')
  })

  it('writes an empty note as an empty string', () => {
    expect(richTextToMarkdown(richTextFromPlain(''))).toBe('')
  })

  it('omits values equal to the node defaults', () => {
    expect(richTextToMarkdown([p([{ text: 'a', format: { color: '#2b2930', fontSize: 12, italic: false } }])], { base: NOTE_BASE })).toBe('a')
  })

  it('writes a non-bold weight and a bold weight over a bold default', () => {
    const base = { ...NOTE_BASE, fontWeight: 700, bold: true }
    expect(richTextToMarkdown([p([{ text: 'a', format: { fontWeight: 400 } }, { text: 'b' }])], { base })).toBe('[a]{weight=400}b')
  })
})

describe('hasRichFormatting', () => {
  it('is false for plain text and true for formats or lists', () => {
    expect(hasRichFormatting(richTextFromPlain('a*b\nc'))).toBe(false)
    expect(hasRichFormatting([{ runs: [{ text: 'a', format: { color: '#2b2930' } }] }], NOTE_BASE)).toBe(false)
    expect(hasRichFormatting([{ runs: [{ text: 'a', format: { color: '#e03131' } }] }], NOTE_BASE)).toBe(true)
    expect(hasRichFormatting([withList({ runs: [{ text: 'a' }] }, { type: 'bullet', level: 0 })])).toBe(true)
    // 空の段落で打つ文字の書式は数えない
    expect(hasRichFormatting([{ runs: [{ text: 'abc' }] }, { runs: [{ text: '', format: { fontWeight: 700 } }] }])).toBe(false)
  })
})

describe('richTextFromPaste', () => {
  it('reads Markdown, but keeps text without any format as it is', () => {
    expect(richTextFromPaste('**a**\n')).toEqual([{ runs: [{ text: 'a', format: { fontWeight: 700 } }] }, { runs: [{ text: '' }] }])
    expect(richTextFromPaste('C:\\\\server\\share\\*.log\n3. x')).toEqual(richTextFromPlain('C:\\\\server\\share\\*.log\n3. x'))
  })

  it('keeps indented lines after an item as their own paragraphs (YAML, code)', () => {
    expect(richTextFromPaste('- name: foo\n  value: 1\n- step\n    npm install')).toEqual([
      { runs: [{ text: 'name: foo' }], list: { type: 'bullet', level: 0 } },
      { runs: [{ text: '  value: 1' }] },
      { runs: [{ text: 'step' }], list: { type: 'bullet', level: 0 } },
      { runs: [{ text: '    npm install' }] },
    ])
  })

  it('reads the first line inline when asked (pasting into the middle of a paragraph)', () => {
    expect(richTextFromPaste('- a\n- b', { inlineFirstLine: true })).toEqual([{ runs: [{ text: '- a' }] }, { runs: [{ text: 'b' }], list: { type: 'bullet', level: 0 } }])
  })
})

// ---- 往復 ----

// 決まった種から乱数を作る（mulberry32）
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ALPHABET = ['a', 'b', 'x', 'i', 'v', 'あ', '漢', '「', '」', '。', ' ', ' ', '\t', '\u3000', '*', '_', '~', '`', '[', ']', '{', '}', '\\', '-', '#', '1', '.', ')', '(', '①', '•', '"', '=', '<', '!', '|', '😀']

const FORMAT_CHOICES: TextRunFormat[] = [
  { fontWeight: 700 },
  { italic: true },
  { strikethrough: true },
  { underline: true },
  { color: '#e03131' },
  { color: '#1971c2' },
  { fontSize: 20.5 },
  { fontFamily: MARKDOWN_CODE_FONT },
  { fontFamily: 'M PLUS 1p' },
  { fontFamily: 'a "b" \\ c}' },
  { fontWeight: 300 },
  { fontSize: 600 },
  { fontWeight: 450.5 },
]

function randomParagraphs(next: () => number): TextParagraph[] {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!
  const paragraphs: TextParagraph[] = []
  const count = 1 + Math.floor(next() * 4)
  for (let i = 0; i < count; i++) {
    const runs = Array.from({ length: 1 + Math.floor(next() * 4) }, () => {
      const text = Array.from({ length: Math.floor(next() * 5) }, () => pick(ALPHABET)).join('')
      const format: TextRunFormat = {}
      for (const choice of FORMAT_CHOICES) if (next() < 0.18) Object.assign(format, choice)
      return Object.keys(format).length > 0 ? { text, format } : { text }
    })
    const previous = paragraphs.at(-1)
    const previousList = previous ? listOf(previous) : undefined
    let paragraph: TextParagraph = { runs }
    if (next() < 0.5) {
      const type = next() < 0.5 ? 'bullet' : 'ordered'
      // 階層は前の項目より 2 段以上深くしない（字下げでは 1 段ずつしか書けない）
      const level = Math.floor(next() * ((previousList ? previousList.level + 1 : 3) + 1))
      const styles: readonly TextListStyle[] =
        type === 'bullet' ? ['disc', 'circle', 'square', 'dash', 'check'] : ['decimal', 'decimal-paren', 'paren-decimal', 'lower-alpha', 'lower-roman', 'circled']
      const style = next() < 0.4 ? pick(styles) : undefined
      paragraph = withList(paragraph, style ? { type, level, style } : { type, level })
    }
    paragraphs.push(paragraph)
  }
  return paragraphs
}

// 比べる形：既定と同じ記号の形は持たない（読むと持たない）
function canonical(paragraphs: TextParagraph[], base?: TextRunFormat): TextParagraph[] {
  return normalizeRichText(paragraphs, base).map((paragraph) => {
    const list = listOf(paragraph)
    if (!list?.style) return paragraph
    const cycle = DEFAULT_LIST_STYLES[list.type]
    return list.style === cycle[list.level % cycle.length] ? withList(paragraph, { type: list.type, level: list.level }) : paragraph
  })
}

describe('round trip', () => {
  it('reads back what it writes (random rich text)', () => {
    const bases = [undefined, NOTE_BASE, { ...NOTE_BASE, fontWeight: 700, bold: true, fontFamily: MARKDOWN_CODE_FONT }]
    for (let seed = 1; seed <= 3000; seed++) {
      const next = random(seed)
      const base = bases[seed % bases.length]
      const paragraphs = randomParagraphs(next)
      const markdown = richTextToMarkdown(paragraphs, { base })
      const result = parseRichMarkdown(markdown, { base })
      expect({ seed, markdown, paragraphs: result.paragraphs }).toEqual({ seed, markdown, paragraphs: canonical(paragraphs, base) })
      expect({ seed, issues: result.issues }).toEqual({ seed, issues: [] })
    }
  })

  it('writes what it reads back the same way (stable)', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const markdown = richTextToMarkdown(randomParagraphs(random(seed)))
      expect(richTextToMarkdown(md(markdown))).toBe(markdown)
    }
  })
})

describe('markdownShortcutAt', () => {
  it('finds the format closed by the last typed character', () => {
    expect(markdownShortcutAt('これは **重要**')).toEqual({ start: 4, innerStart: 6, innerEnd: 8, end: 10, format: { fontWeight: 700 } })
    expect(markdownShortcutAt('a *b c*')).toMatchObject({ start: 2, innerStart: 3, innerEnd: 6, format: { italic: true } })
    expect(markdownShortcutAt('~~旧案~~')).toMatchObject({ start: 0, innerStart: 2, innerEnd: 4, format: { strikethrough: true } })
    expect(markdownShortcutAt('run `npm test`')).toMatchObject({ start: 4, innerStart: 5, innerEnd: 13, format: { fontFamily: MARKDOWN_CODE_FONT } })
    expect(markdownShortcutAt('[予算]{color=#e03131 .underline}')).toEqual({ start: 0, innerStart: 1, innerEnd: 3, end: 30, format: { color: '#e03131', underline: true } })
  })

  it('does not change half-typed bold, spaced markers, snake_case, escapes or bad attributes', () => {
    expect(markdownShortcutAt('**bold*')).toBeNull()
    expect(markdownShortcutAt('5 * 3 *')).toBeNull()
    expect(markdownShortcutAt('* a*')).toBeNull()
    expect(markdownShortcutAt('snake_case_')).toBeNull()
    expect(markdownShortcutAt('\\*a*')).toBeNull()
    expect(markdownShortcutAt('****')).toBeNull()
    expect(markdownShortcutAt('[a]{colour=red}')).toBeNull()
    expect(markdownShortcutAt('[a]{}')).toBeNull()
    expect(markdownShortcutAt('__x__')).toBeNull()
    expect(markdownShortcutAt('5*3=15, 2*')).toBeNull()
    expect(markdownShortcutAt('*a\\*')).toBeNull()
    expect(markdownShortcutAt('**a\\**')).toBeNull()
    expect(markdownShortcutAt('[a\\]{.bold}')).toBeNull()
  })

  it('drops one space on each side of code, as the reader does', () => {
    expect(markdownShortcutAt('` a `')).toMatchObject({ start: 0, innerStart: 2, innerEnd: 3 })
  })
})
