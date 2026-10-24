// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './renderMarkdown.ts'

const render = (source: string) => renderMarkdown(source).html

function footnoteItems(html: string): string[] {
  const list = /<div class="md-footnotes"><ol>(.*)<\/ol><\/div>/s.exec(html)
  if (!list) return []
  return [...list[1].matchAll(/<li>(.*?)<\/li>/gs)].map((match) => match[1])
}

function refNumbers(html: string): string[] {
  return [...html.matchAll(/<sup class="md-footnote-ref">(\d+)<\/sup>/g)].map((match) => match[1])
}

// 脚注（`[^1]` と `[^1]: …`）。番号は本文で初めて参照した順で、一覧は文書の末尾に出す
describe('renderMarkdown footnotes', () => {
  it('表の見出しの参照と、空白のない定義を脚注にする', () => {
    const html = render('| 売上[^1] | 利益 |\n|---|---|\n| 1 | 2 |\n\n[^1]: 東京応化工業株式会社（2026a）\n')
    expect(html).toContain('<th>売上<sup class="md-footnote-ref">1</sup></th>')
    expect(footnoteItems(html)).toEqual(['東京応化工業株式会社（2026a）'])
    expect(html).not.toContain('[^1]')
  })

  it('空白のある定義、字下げした続きの行、本文のインラインの記法', () => {
    const html = render('本文[^a]\n\n[^a]: 一行目 **強い**\n    二行目\n\t三行目\n次の段落\n')
    expect(footnoteItems(html)).toEqual(['一行目 <strong>強い</strong>\n二行目\n三行目'])
    expect(html).toContain('<p>次の段落</p>')
  })

  it('初めて参照した順に番号を振り、同じ脚注は同じ番号になる', () => {
    const source = '[^z]: 先に書いた定義\n\nA[^b] B[^z] C[^b]\n\n[^b]: 後ろの定義\n'
    const html = render(source)
    expect(refNumbers(html)).toEqual(['1', '2', '1'])
    expect(footnoteItems(html)).toEqual(['後ろの定義', '先に書いた定義'])
  })

  it('続けて書いた定義はそれぞれの脚注になり、段落の途中の行からも始まる', () => {
    const html = render('本文[^1][^2]\n[^1]: 一つ目\n[^2]: 二つ目\n')
    expect(html).toContain('<p>本文<sup class="md-footnote-ref">1</sup><sup class="md-footnote-ref">2</sup></p>')
    expect(footnoteItems(html)).toEqual(['一つ目', '二つ目'])
  })

  it('定義のない参照は文字のまま、参照されない定義は出ない', () => {
    expect(render('本文[^x]')).toBe('<p>本文[^x]</p>\n')
    expect(render('本文\n\n[^1]: 使わない\n')).toBe('<p>本文</p>\n')
  })

  it('定義のない `[^…]` は、リンクや強調を含めて今までどおりに描く', () => {
    expect(render('[^abc](https://example.com)')).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noreferrer">^abc</a></p>\n',
    )
    expect(render('[^x][r]\n\n[r]: https://r.example\n')).toContain(
      '<a href="https://r.example" target="_blank" rel="noreferrer">^x</a>',
    )
    expect(render('x [^*a*] y')).toBe('<p>x [^<em>a</em>] y</p>\n')
  })

  it('定義があっても、すぐ後ろに ( が続くならリンクにする', () => {
    const html = render('[^1](https://example.com) と[^1]\n\n[^1]: 脚注\n')
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noreferrer">^1</a>')
    expect(refNumbers(html)).toEqual(['1'])
  })

  it('脚注の中の参照は、本文のあとに数える', () => {
    const html = render('A[^1]\n\n[^1]: 一つ目は[^2]を見る\n[^2]: 二つ目\n')
    expect(refNumbers(html)).toEqual(['1', '2'])
    expect(footnoteItems(html)).toEqual(['一つ目は<sup class="md-footnote-ref">2</sup>を見る', '二つ目'])
  })

  it('コードブロック・インラインコードの中は脚注にしない', () => {
    const html = render('`[^1]` と本文\n\n```\n[^1]\n[^1]: コード\n```\n\n[^1]: 定義\n')
    expect(html).toContain('<code>[^1]</code>')
    expect(html).toContain('<pre><code>[^1]\n[^1]: コード\n</code></pre>')
    expect(html).not.toContain('md-footnote')
  })

  it('普通の参照リンクは今までどおり', () => {
    const html = render('[リンク][a] と[^1]\n\n[a]: https://example.com\n[^1]: 脚注\n')
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noreferrer">リンク</a>')
    expect(footnoteItems(html)).toEqual(['脚注'])
  })

  it('maxBlocks で切ったら、残した部分で参照した脚注だけを出す', () => {
    const source = 'A[^1]\n\nB[^2]\n\n[^1]: 一つ目\n[^2]: 二つ目\n'
    const { html, truncated } = renderMarkdown(source, { maxBlocks: 1 })
    expect(truncated).toBe(true)
    expect(html).not.toContain('<p>B')
    expect(footnoteItems(html)).toEqual(['一つ目'])
  })

  it('定義はブロックの数に入れない', () => {
    const { html, truncated } = renderMarkdown('[^1]: 定義\n\nA[^1]\n\nB\n', { maxBlocks: 2 })
    expect(truncated).toBe(false)
    expect(html).toContain('<p>B</p>')
  })

  it('sourceLines で、ほかのブロックの data-line がずれず、一覧には付かない', () => {
    const source = '# 見出し[^1]\n\n[^1]: 定義\n    続き\n\n段落\n\n- a\n'
    const { html } = renderMarkdown(source, { sourceLines: true })
    expect(html).toContain('<h1 data-line="1"')
    expect(html).toContain('<p data-line="6"')
    expect(html).toContain('<ul data-line="8"')
    expect(html).toContain('<div class="md-footnotes">')
  })
})
