import { describe, expect, it } from 'vitest'
import { MAX_SVG_INTRINSIC_SIDE, sanitizeSvg, SvgError } from './svg.ts'

// SVG の消毒（MAI-116）：許した要素・属性だけを書き出し直し、根に width・height・viewBox を持たせる

// Material Symbols の配布物と同じ形（width・height に px、viewBox は 0 -960 960 960）
const MATERIAL_CHECK =
  '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#1f1f1f"><path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z"/></svg>'

function clean(source: string): string {
  return sanitizeSvg(source).svg
}

// 消毒したものは、もう一度消毒しても変わらない（サーバーはこれで、ブラウザが消毒したものかを確かめる）
function expectStable(source: string): string {
  const once = clean(source)
  expect(clean(once)).toBe(once)
  return once
}

describe('sanitizeSvg', () => {
  it('keeps a Material Symbols icon as it is, with the size in px first', () => {
    const result = sanitizeSvg(MATERIAL_CHECK)
    expect(result).toEqual({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 -960 960 960" fill="#1f1f1f"><path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z"/></svg>',
      width: 24,
      height: 24,
    })
    expectStable(MATERIAL_CHECK)
  })

  it('reads the size from width and height, the viewBox, or neither like <img>', () => {
    const size = (attrs: string) => {
      const { width, height } = sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}/>`)
      return [width, height]
    }
    expect(size('viewBox="0 0 960 480"')).toEqual([960, 480])
    expect(size('width="48" viewBox="0 0 960 480"')).toEqual([48, 24])
    expect(size('height="10" viewBox="0,0,30,40"')).toEqual([7.5, 10])
    expect(size('width="1in" height="72pt"')).toEqual([96, 96])
    expect(size('width="10mm" height="1cm"')).toEqual([37.8, 37.8])
    // % や em は大きさにならない
    expect(size('width="100%" height="100%" viewBox="0 0 20 10"')).toEqual([20, 10])
    expect(size('')).toEqual([300, 150])
    // 壊れた viewBox は使わない
    expect(size('width="20" height="10" viewBox="0 0 0 10"')).toEqual([20, 10])
  })

  it('adds a viewBox of the original size, so that the picture scales when redrawn larger', () => {
    expect(clean('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="10" height="10"/></svg>')).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10" viewBox="0 0 20 10"><rect width="10" height="10"/></svg>',
    )
    // xmlns がなくても SVG として書く
    expect(clean('<svg viewBox="0 0 4 2"/>')).toBe('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2" viewBox="0 0 4 2"/>')
  })

  it('keeps the size within limits, keeping the aspect ratio', () => {
    expect(sanitizeSvg('<svg viewBox="0 0 0.5 0.25"/>')).toMatchObject({ width: 2, height: 1 })
    expect(sanitizeSvg('<svg width="100000" height="50000"/>')).toMatchObject({ width: MAX_SVG_INTRINSIC_SIDE, height: MAX_SVG_INTRINSIC_SIDE / 2 })
    expectStable('<svg viewBox="0 0 0.5 0.25"/>')
    expectStable('<svg width="100000" height="50000"/>')
    expectStable('<svg width="10.555" viewBox="0 0 3 1"/>')
  })

  it('removes scripts, foreignObject, animations, event handlers and elements it does not know', () => {
    const out = expectStable(`<?xml version="1.0"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<!-- a comment -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10" onload="alert(1)">
  <script>alert(1)</script>
  <script type="text/javascript"><![CDATA[ alert(2) ]]></script>
  <SCRIPT>alert(3)</SCRIPT>
  <svg:script xmlns:svg="http://www.w3.org/2000/svg">alert(4)</svg:script>
  <g xmlns="http://www.w3.org/1999/xhtml"><script>alert(5)</script></g>
  <foreignObject width="10" height="10"><body xmlns="http://www.w3.org/1999/xhtml"><iframe src="javascript:alert(6)"/></body></foreignObject>
  <iframe src="https://example.com"/>
  <rect width="10" height="10" fill="red" onclick="alert(7)" ONMOUSEOVER="alert(8)">
    <animate attributeName="fill" values="red;blue" dur="1s"/>
    <set attributeName="href" to="javascript:alert(9)"/>
  </rect>
  <a href="javascript:alert(10)"><circle r="2"/></a>
  <sodipodi:namedview xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"/>
  <metadata><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></metadata>
</svg>`)
    expect(out).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><g/><rect width="10" height="10" fill="red"/><circle r="2"/></svg>',
    )
    expect(out).not.toMatch(/script|alert|on[a-z]+=|foreignObject|iframe|javascript|animate|<set/i)
  })

  it('keeps references inside the document and drops references to the outside', () => {
    const out = expectStable(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10">
  <defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient><path id="p" d="M0 0h1"/></defs>
  <use xlink:href="#p"/>
  <use href="https://example.com/sprite.svg#icon"/>
  <use xlink:href="data:image/svg+xml;base64,PHN2Zy8+"/>
  <rect fill="url(#g)" stroke="url('https://example.com/x')" width="1" height="1"/>
  <rect fill="url(http://example.com/#g) red" mask="url( #g )" width="1" height="1"/>
  <image href="https://example.com/a.png" width="1" height="1"/>
  <image xlink:href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>
  <image href="data:image/svg+xml;base64,PHN2Zy8+" width="1" height="1"/>
  <image href="file:///etc/passwd" width="1" height="1"/>
  <filter id="f"><feImage href="https://example.com/a.png"/><feGaussianBlur stdDeviation="1"/></filter>
  <textPath href="#p">文字</textPath>
</svg>`)
    expect(out).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">' +
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient><path id="p" d="M0 0h1"/></defs>' +
        '<use href="#p"/><use/><use/>' +
        '<rect fill="url(#g)" width="1" height="1"/>' +
        '<rect mask="url( #g )" width="1" height="1"/>' +
        '<image width="1" height="1"/>' +
        '<image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>' +
        '<image width="1" height="1"/><image width="1" height="1"/>' +
        '<filter id="f"><feGaussianBlur stdDeviation="1"/></filter>' +
        '<textPath href="#p">文字</textPath></svg>',
    )
  })

  it('neutralizes CSS that can load something, and drops CSS it cannot read safely', () => {
    const out = expectStable(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">
  <style>.a { fill: url(#g); } .b { fill: url("https://example.com/x.svg#g"); } .c > .d:not(.e) { stroke: rgb(0 0 0 / 50%) }</style>
  <style>@import url(https://example.com/a.css); .a { fill: red }</style>
  <style>@IMPORT "https://example.com/a.css";</style>
  <style>@font-face { font-family: x; src: url(https://example.com/x.woff2) }</style>
  <style>.a { background: u\\72l(https://example.com/x) }</style>
  <style>.a { mask-image: image-set("https://example.com/x.png" 1x) }</style>
  <rect class="a" style="fill: url(https://example.com/x); stroke: blue" width="1" height="1"/>
  <rect style="fill: u\\rl(https://example.com/x)" width="1" height="1"/>
  <rect fill="image(https://example.com/x)" filter="drop-shadow(1px 1px 2px black)" width="1" height="1"/>
</svg>`)
    expect(out).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">' +
        '<style>.a { fill: url(#g); } .b { fill: none; } .c &gt; .d:not(.e) { stroke: rgb(0 0 0 / 50%) }</style>' +
        '<rect class="a" style="fill: none; stroke: blue" width="1" height="1"/>' +
        '<rect width="1" height="1"/>' +
        '<rect filter="drop-shadow(1px 1px 2px black)" width="1" height="1"/></svg>',
    )
    expect(out).not.toMatch(/example\.com|@import|@font-face|image-set/i)
  })

  it('drops the size from the style of the root element', () => {
    expect(clean('<svg width="10" height="10" style="width: 100%; height: 100%; fill: red"/>')).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10" style=" fill: red"/>',
    )
    expect(clean('<svg width="10" height="10" style="width: 100%"/>')).toBe('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"/>')
  })

  it('reads entities and character references, and writes the text back escaped', () => {
    const out = expectStable(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><title>A &amp; B &lt;&#x31;&#50;&gt;</title>
<text x="0" y="5" font-family="&quot;Noto Sans&quot;, sans-serif">「&#12354;」 &apos;x&apos;</text><g>stray text</g></svg>`)
    expect(out).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><title>A &amp; B &lt;12&gt;</title>' +
        '<text x="0" y="5" font-family="&quot;Noto Sans&quot;, sans-serif">「あ」 \'x\'</text><g/></svg>',
    )
    // XML に書けない文字（制御文字・対になっていないサロゲート）は捨てる。改行・CR は、書き戻しても同じに読めるように書く
    expect(clean('<svg width="1" height="1"><title>a\u0001b\uD800c&#1;😀&#13;</title><text dx="1&#10;2">x</text></svg>')).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"><title>abc😀&#13;</title><text dx="1&#10;2">x</text></svg>',
    )
    expectStable('<svg width="1" height="1"><title>a&#13;b\r\nc</title><text dx="1&#10;2">x</text></svg>')
  })

  it('refuses what is not a well-formed SVG', () => {
    const refuse = (source: string) => expect(() => sanitizeSvg(source), source).toThrow(SvgError)
    refuse('')
    refuse('not xml')
    refuse('<html><body/></html>')
    refuse('<svg><g></svg>')
    refuse('<svg></g></svg>')
    refuse('<svg width="1" width="2"/>')
    refuse('<svg width=1/>')
    refuse('<svg/><svg/>')
    refuse('<svg>a & b</svg>')
    // 外部の実体（XXE）・定義した実体は読まない
    refuse('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg><text>&x;</text></svg>')
    refuse('<!DOCTYPE svg [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><svg><text>&b;</text></svg>')
    refuse('<!ENTITY x "y"><svg/>')
    refuse(`${'<g>'.repeat(300)}`.replace(/^<g>/, '<svg>') + `${'</g>'.repeat(299)}</svg>`)
  })

  it('reads a DOCTYPE with an internal subset when no entity is used, and drops processing instructions', () => {
    const out = clean(
      '﻿<?xml version="1.0" encoding="UTF-8"?><?xml-stylesheet href="https://example.com/a.css"?><!DOCTYPE svg [<!ENTITY ns "x>y">]><svg width="1" height="1"/>',
    )
    expect(out).toBe('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"/>')
  })
})
