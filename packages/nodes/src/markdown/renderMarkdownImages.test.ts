// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './renderMarkdown.ts'

// 相対パスの画像は、Markdown ファイルの場所を基準にサーバーの /api/workspace/ から読む
describe('renderMarkdown documentPath', () => {
  const render = (source: string, documentPath?: string) => renderMarkdown(source, { documentPath }).html

  it('Markdown ファイルのフォルダを基準に解決する', () => {
    expect(render('![a](img/x.png)', 'notes/a.md')).toContain('src="/api/workspace/notes/img/x.png"')
    expect(render('![a](./x.png)', 'notes/a.md')).toContain('src="/api/workspace/notes/x.png"')
    expect(render('![a](../x.png)', 'notes/a.md')).toContain('src="/api/workspace/x.png"')
    expect(render('![a](/assets/y.png)', 'notes/a.md')).toContain('src="/api/workspace/assets/y.png"')
    expect(render('![a](x.png?v=1#top)', 'a.md')).toContain('src="/api/workspace/x.png"')
    expect(render('![a](<図 1.png>)', 'a.md')).toContain(`src="/api/workspace/${encodeURIComponent('図 1.png')}"`)
  })

  it('ワークスペースの外を指すもの、documentPath がないときは、代わりの文字にする', () => {
    expect(render('![外](../../x.png)', 'notes/a.md')).not.toContain('<img')
    expect(render('![相対](img/x.png)')).not.toContain('<img')
    expect(render('![js](javascript:alert(1))', 'a.md')).not.toContain('<img')
  })

  it('絶対 URL と data: はそのまま', () => {
    expect(render('![a](https://example.com/x.png)', 'a.md')).toContain('src="https://example.com/x.png"')
  })

  it('生 HTML の <img> の相対パスも解決する', () => {
    expect(render('<img src="img/x.png" alt="a">', 'notes/a.md')).toContain('src="/api/workspace/notes/img/x.png"')
    expect(render('<img src="javascript:alert(1)">', 'a.md')).not.toContain('javascript:')
  })
})
