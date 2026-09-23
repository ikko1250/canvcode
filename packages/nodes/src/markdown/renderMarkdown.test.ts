import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './renderMarkdown.ts'

// 全画面のエディタでスクロールを合わせるための data-line（MAI-44）
describe('renderMarkdown sourceLines', () => {
  it('ブロックの先頭の要素に、始まりの行を付ける', () => {
    const source = '# 見出し\n\n段落の一行目\n二行目\n\n- a\n- b\n\n```js\nx\n```\n'
    const { html } = renderMarkdown(source, { sourceLines: true })
    expect(html).toContain('<h1 data-line="1"')
    expect(html).toContain('<p data-line="3"')
    expect(html).toContain('<ul data-line="6"')
    expect(html).toContain('<pre data-line="9"')
  })

  it('指定しなければ付けない', () => {
    const { html } = renderMarkdown('# 見出し\n\n段落', {})
    expect(html).not.toContain('data-line')
  })

  it('付けても本文の HTML は変わらない', () => {
    const source = '# 見出し\n\n段落 **強い**\n\n> 引用\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n$$\nx^2\n$$\n'
    const plain = renderMarkdown(source).html
    const tagged = renderMarkdown(source, { sourceLines: true }).html
    expect(tagged.replace(/ data-line="\d+"/g, '')).toBe(plain)
    expect(tagged).toContain('<blockquote data-line="5"')
    expect(tagged).toContain('<table data-line="7"')
    expect(tagged).toContain('<div data-line="11" class="markdown-math-block"')
  })

  it('maxBlocks で切っても、残った分の行は合う', () => {
    const source = 'a\n\nb\n\nc\n'
    const { html, truncated } = renderMarkdown(source, { sourceLines: true, maxBlocks: 2 })
    expect(truncated).toBe(true)
    expect(html).toContain('<p data-line="1"')
    expect(html).toContain('<p data-line="3"')
    expect(html).not.toContain('data-line="5"')
  })
})
