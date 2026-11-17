// SVG の画像を、許したものだけで作り直す（消毒。MAI-116）。
// - SVG は中にスクリプトを持てる。キャンバスは <img>（Image）として読むので動かないが、原本の URL をブラウザで直接開くと、
//   このサーバーと同じオリジンの文書として動いてしまう（同じオリジンに MCP や、Claude Code にコマンドを動かさせる API がある）。
//   配るときに CSP（sandbox）を付けるのに加えて、取り込むときにここで消毒し、危ないものをワークスペースに置かない
// - 読んだ XML を木にし、許した要素・属性だけを書き出し直す（許していないものは、名前を知らなくても残らない）。
//   残さないもの：スクリプト・foreignObject・アニメーション（href を書き換えられる）・イベントの属性（on*）・
//   外への参照（href と url() は同じ文書の中の #id だけ。image の href は data: の PNG・JPEG・GIF・WebP だけ）・
//   CSS のエスケープ（\）と @import・@font-face・知らない CSS の関数（image-set() など）・DOCTYPE・処理命令・コメント。
//   定義済みの 5 つと数値のほかの実体参照（&name;）は、中身が分からないので読まない（SvgError）
// - 書き出した SVG は、根の svg に xmlns・width・height（px）・viewBox を必ず持つ。width・height が画像の大きさになる
//   （ないときは viewBox から、どちらもなければ 300×150。ブラウザの <img> と同じ）。viewBox があるので、どの大きさでも描き直せる
// - ブラウザ（取り込むとき）とサーバー（受け取るとき）が同じ関数を使う。消毒したものをもう一度消毒しても変わらない
//   （サーバーは、受け取ったものを消毒し直して同じかを確かめる。違えば、ブラウザが付けたハッシュと合わなくなるので断る）

export const SVG_MIME = 'image/svg+xml'
// 受け付ける SVG の大きさの上限（バイト）。アイコンは 1 KB ほど、細かい図でも数 MB まで
export const MAX_SVG_BYTES = 10 * 1024 * 1024
// 画像の大きさ（width・height）の長い辺の上限。これより大きいものは、縦横比を保って縮める（描き直すので、見た目は変わらない）
export const MAX_SVG_INTRINSIC_SIDE = 16384

const SVG_NS = 'http://www.w3.org/2000/svg'
const DEFAULT_WIDTH = 300
const DEFAULT_HEIGHT = 150
const MAX_DEPTH = 256
const MAX_ELEMENTS = 200_000

export class SvgError extends Error {}

export interface SanitizedSvg {
  svg: string
  // 画像の大きさ（CSS の px。小数第 2 位まで）
  width: number
  height: number
}

interface XmlElement {
  name: string
  attrs: [string, string][]
  children: XmlNode[]
}
type XmlNode = XmlElement | string

// 残す要素。a は中身だけを残す。ほかは中身ごと捨てる
const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'switch', 'title', 'desc', 'style',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'image',
  'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask', 'marker',
  'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting',
  'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR',
  'feGaussianBlur', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting',
  'feSpotLight', 'feTile', 'feTurbulence',
])
const UNWRAP = new Set(['a'])
// 文字を中に持てる要素（ほかの要素の中の文字（改行や字下げ）は捨てる）
const TEXT_ELEMENTS = new Set(['title', 'desc', 'style', 'text', 'tspan', 'textPath'])

// 残す属性。xlink:href は href にして残す
const ATTRIBUTES = new Set([
  'id', 'class', 'style', 'lang', 'xml:lang', 'xml:space', 'version', 'href',
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr', 'width', 'height', 'd', 'points', 'pathLength',
  'viewBox', 'preserveAspectRatio', 'transform', 'transform-origin',
  'offset', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'patternUnits', 'patternContentUnits', 'patternTransform',
  'clipPathUnits', 'maskUnits', 'maskContentUnits', 'markerUnits', 'markerWidth', 'markerHeight', 'refX', 'refY', 'orient',
  'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust', 'startOffset', 'method', 'spacing', 'side',
  'systemLanguage', 'requiredFeatures',
  'filterUnits', 'primitiveUnits', 'in', 'in2', 'result', 'stdDeviation', 'mode', 'type', 'values', 'operator',
  'k1', 'k2', 'k3', 'k4', 'order', 'kernelMatrix', 'divisor', 'bias', 'targetX', 'targetY', 'edgeMode', 'kernelUnitLength',
  'preserveAlpha', 'surfaceScale', 'diffuseConstant', 'specularConstant', 'specularExponent', 'scale', 'xChannelSelector',
  'yChannelSelector', 'azimuth', 'elevation', 'z', 'pointsAtX', 'pointsAtY', 'pointsAtZ', 'limitingConeAngle',
  'baseFrequency', 'numOctaves', 'seed', 'stitchTiles', 'radius', 'tableValues', 'slope', 'intercept', 'amplitude', 'exponent',
  // 見た目の属性（presentation attributes）
  'alignment-baseline', 'baseline-shift', 'clip', 'clip-path', 'clip-rule', 'color', 'color-interpolation',
  'color-interpolation-filters', 'color-rendering', 'direction', 'display', 'dominant-baseline', 'enable-background',
  'fill', 'fill-opacity', 'fill-rule', 'filter', 'flood-color', 'flood-opacity', 'font', 'font-family', 'font-size',
  'font-size-adjust', 'font-stretch', 'font-style', 'font-variant', 'font-weight', 'glyph-orientation-horizontal',
  'glyph-orientation-vertical', 'image-rendering', 'kerning', 'letter-spacing', 'lighting-color', 'marker', 'marker-end',
  'marker-mid', 'marker-start', 'mask', 'mask-type', 'opacity', 'overflow', 'paint-order', 'pointer-events', 'shape-rendering',
  'stop-color', 'stop-opacity', 'stroke', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-opacity', 'stroke-width', 'text-anchor', 'text-decoration', 'text-rendering', 'unicode-bidi',
  'vector-effect', 'visibility', 'word-spacing', 'writing-mode',
])
// CSS として読まれない（関数や url() を確かめなくてよい）属性
const PLAIN_ATTRIBUTES = new Set(['id', 'class', 'lang', 'xml:lang', 'xml:space', 'version', 'd', 'points', 'viewBox', 'in', 'in2', 'result', 'systemLanguage'])

// CSS で使ってよい関数（url() は別に確かめる）。ここにない関数（image-set()・src()・element()・expression() など）があれば捨てる
const CSS_FUNCTIONS = new Set([
  'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'light-dark',
  'calc', 'min', 'max', 'clamp', 'var', 'abs', 'sign', 'round',
  'translate', 'translatex', 'translatey', 'translatez', 'translate3d', 'scale', 'scalex', 'scaley', 'scalez', 'scale3d',
  'rotate', 'rotatex', 'rotatey', 'rotatez', 'rotate3d', 'skew', 'skewx', 'skewy', 'matrix', 'matrix3d', 'perspective',
  'cubic-bezier', 'steps', 'linear',
  'blur', 'brightness', 'contrast', 'drop-shadow', 'grayscale', 'hue-rotate', 'invert', 'opacity', 'saturate', 'sepia',
  'rect', 'inset', 'circle', 'ellipse', 'polygon', 'path',
  // セレクタ（style 要素）
  'not', 'is', 'where', 'has', 'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type', 'dir',
])

// 同じ文書の中を指す参照（#id）。空白や引用符を含まないもの
const LOCAL_REF = /^#[^\s"'()<>\\]+$/
// image に埋め込んだ画像（SVG は入れない。入れ子の SVG のスクリプトを確かめられないので）
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]*$/
const NAME = /[A-Za-z_:À-￯][-\w.:·À-￯]*/y
const SPACE = /[ \t\n]*/y
const ENTITY = /&(?:#x([0-9a-fA-F]{1,6})|#([0-9]{1,7})|(lt|gt|amp|quot|apos));/g
const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
// XML に書けない文字（制御文字・対になっていないサロゲート・U+FFFE と U+FFFF）
const INVALID_CHARS = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/
const LENGTH = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*(px|pt|pc|mm|cm|in)?$/i
const UNIT_PX: Record<string, number> = { px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 }

// SVG の文字列を消毒し、大きさを読む。XML として読めない・根が svg でない・大きすぎる・深すぎるなら SvgError
export function sanitizeSvg(source: string): SanitizedSvg {
  const root = parseXml(source)
  if (root.name !== 'svg') throw new SvgError(`the root element is not svg: ${root.name}`)
  const size = intrinsicSize(root)
  const attrs: [string, string][] = [
    ['xmlns', SVG_NS],
    ['width', String(size.width)],
    ['height', String(size.height)],
    ['viewBox', size.viewBox],
  ]
  for (const [name, value] of safeAttributes(root)) {
    if (name === 'width' || name === 'height' || name === 'viewBox') continue
    // 根の style の width・height は、上の大きさより強いので外す
    if (name === 'style') {
      const style = withoutSizeDeclarations(value)
      if (style) attrs.push([name, style])
      continue
    }
    attrs.push([name, value])
  }
  const out: string[] = [`<svg${attributeText(attrs)}`]
  const inner: string[] = []
  writeChildren(root.children, 'svg', inner)
  out.push(inner.length ? `>${inner.join('')}</svg>` : '/>')
  return { svg: out.join(''), width: size.width, height: size.height }
}

// ---- XML を読む ----

// 要素・属性・文字だけの木にする。コメント・処理命令（<?xml-stylesheet?> も）・DOCTYPE は読み飛ばす
function parseXml(input: string): XmlElement {
  // 改行は \n にそろえる（XML の決まり）
  const s = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  let pos = 0
  let root: XmlElement | null = null
  let count = 0
  const stack: XmlElement[] = []
  const fail = (message: string): never => {
    throw new SvgError(`${message} (at ${pos})`)
  }
  const name = (): string => {
    NAME.lastIndex = pos
    const match = NAME.exec(s)
    if (!match) fail('a name is expected')
    pos = NAME.lastIndex
    return match![0]
  }
  const space = (): boolean => {
    SPACE.lastIndex = pos
    SPACE.exec(s)
    const moved = SPACE.lastIndex > pos
    pos = SPACE.lastIndex
    return moved
  }
  const closeAt = (token: string, from: number, what: string): number => {
    const at = s.indexOf(token, from)
    if (at < 0) fail(`unterminated ${what}`)
    return at
  }
  while (pos < s.length) {
    const lt = s.indexOf('<', pos)
    const end = lt < 0 ? s.length : lt
    if (end > pos) {
      const text = s.slice(pos, end)
      const parent = stack.at(-1)
      if (parent) parent.children.push(decode(text, pos))
      else if (text.trim()) fail('text outside the root element')
      pos = end
      continue
    }
    if (s.startsWith('<!--', pos)) {
      pos = closeAt('-->', pos + 4, 'comment') + 3
    } else if (s.startsWith('<![CDATA[', pos)) {
      const close = closeAt(']]>', pos + 9, 'CDATA section')
      const parent = stack.at(-1)
      if (!parent) fail('CDATA outside the root element')
      parent!.children.push(clean(s.slice(pos + 9, close)))
      pos = close + 3
    } else if (s.startsWith('<?', pos)) {
      pos = closeAt('?>', pos + 2, 'processing instruction') + 2
    } else if (s.startsWith('<!DOCTYPE', pos)) {
      if (root) fail('DOCTYPE after the root element')
      pos = skipDoctype(s, pos)
    } else if (s.startsWith('</', pos)) {
      pos += 2
      const tag = name()
      const open = stack.pop()
      if (!open || open.name !== tag) fail(`unexpected end tag: ${tag}`)
      space()
      if (s[pos] !== '>') fail('">" is expected')
      pos++
    } else {
      pos++
      const element: XmlElement = { name: name(), attrs: [], children: [] }
      if (root && stack.length === 0) fail('more than one root element')
      const seen = new Set<string>()
      let selfClosing = false
      for (;;) {
        const spaced = space()
        if (s[pos] === '>') {
          pos++
          break
        }
        if (s.startsWith('/>', pos)) {
          pos += 2
          selfClosing = true
          break
        }
        if (!spaced) fail('a space is expected before an attribute')
        const attr = name()
        space()
        if (s[pos] !== '=') fail('"=" is expected')
        pos++
        space()
        const quote = s[pos]
        if (quote !== '"' && quote !== "'") fail('a quoted value is expected')
        const close = closeAt(quote, pos + 1, 'attribute value')
        const raw = s.slice(pos + 1, close)
        if (raw.includes('<')) fail('"<" in an attribute value')
        if (seen.has(attr)) fail(`duplicate attribute: ${attr}`)
        seen.add(attr)
        // 属性の値の空白は、空白 1 つにする（XML の決まり。&#10; などで書いた改行は残る）
        element.attrs.push([attr, decode(raw.replace(/[\t\n]/g, ' '), pos)])
        pos = close + 1
      }
      if (++count > MAX_ELEMENTS) fail('too many elements')
      if (stack.length >= MAX_DEPTH) fail('nested too deeply')
      const parent = stack.at(-1)
      if (parent) parent.children.push(element)
      else root = element
      if (!selfClosing) stack.push(element)
    }
  }
  if (stack.length > 0) fail(`unclosed element: ${stack.at(-1)!.name}`)
  if (!root) fail('no root element')
  return root!
}

// <!DOCTYPE …> を読み飛ばす（中の [ ] の定義も。実体の定義は使わない）
function skipDoctype(s: string, start: number): number {
  let quote = ''
  let depth = 0
  for (let i = start + 9; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '[') {
      depth++
    } else if (c === ']') {
      depth--
    } else if (c === '>' && depth <= 0) {
      return i + 1
    }
  }
  throw new SvgError(`unterminated DOCTYPE (at ${start})`)
}

// 実体参照を文字にする。定義済みの 5 つと数値のほかは読まない
function decode(text: string, at: number): string {
  if (!text.includes('&')) return clean(text)
  if (text.replace(ENTITY, '').includes('&')) throw new SvgError(`an unknown entity or a bare "&" (at ${at})`)
  return clean(
    text.replace(ENTITY, (_match, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
      if (named) return NAMED_ENTITIES[named]
      const code = hex ? parseInt(hex, 16) : Number(dec)
      return code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }),
  )
}

function clean(text: string): string {
  return text.replace(INVALID_CHARS, '')
}

// ---- 書き出す ----

function writeChildren(children: XmlNode[], parent: string, out: string[]): void {
  for (const child of children) {
    if (typeof child === 'string') {
      if (TEXT_ELEMENTS.has(parent) && parent !== 'style') out.push(escapeText(child))
    } else if (UNWRAP.has(child.name)) {
      writeChildren(child.children, parent, out)
    } else if (ELEMENTS.has(child.name)) {
      writeElement(child, out)
    }
  }
}

function writeElement(element: XmlElement, out: string[]): void {
  const attrs = attributeText(safeAttributes(element))
  if (element.name === 'style') {
    const css = safeCss(element.children.filter((child): child is string => typeof child === 'string').join(''))
    if (css !== null && css.trim()) out.push(`<style${attrs}>${escapeText(css)}</style>`)
    return
  }
  const inner: string[] = []
  writeChildren(element.children, element.name, inner)
  out.push(inner.length ? `<${element.name}${attrs}>${inner.join('')}</${element.name}>` : `<${element.name}${attrs}/>`)
}

// 許した属性だけを、値を確かめて残す
function safeAttributes(element: XmlElement): [string, string][] {
  const out: [string, string][] = []
  const hasHref = element.attrs.some(([name]) => name === 'href')
  for (const [rawName, rawValue] of element.attrs) {
    let name = rawName
    let value = rawValue
    if (name === 'xlink:href') {
      if (hasHref) continue
      name = 'href'
    }
    if (!ATTRIBUTES.has(name)) continue
    // CSS のエスケープで url( や関数の名前を隠せるので、\ を含む値は残さない
    if (value.includes('\\')) continue
    if (name === 'href') {
      if (!safeHref(element.name, value.trim())) continue
      value = value.trim()
    } else if (name === 'style') {
      const css = safeCss(value)
      if (css === null || !css.trim()) continue
      value = css
    } else if (!PLAIN_ATTRIBUTES.has(name) && !safeCssValue(value)) {
      continue
    }
    out.push([name, value])
  }
  return out
}

function safeHref(element: string, value: string): boolean {
  if (LOCAL_REF.test(value)) return element === 'use' || element === 'textPath' || element.endsWith('Gradient') || element === 'pattern' || element === 'filter'
  return element === 'image' && DATA_IMAGE.test(value)
}

// CSS（style 要素の中身・style 属性）。外を指す url() は none にする。エスケープ・@import・@font-face・@namespace があるか、
// 知らない関数があれば null（全部捨てる）
function safeCss(css: string): string | null {
  if (css.includes('\\') || /@(?:import|font-face|namespace)/i.test(css)) return null
  const replaced = css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s"'()]*))\s*\)/gi, (match, a?: string, b?: string, c?: string) =>
    LOCAL_REF.test((a ?? b ?? c ?? '').trim()) ? match : 'none',
  )
  return safeCssValue(replaced) ? replaced : null
}

// 値の中の関数が、使ってよいものだけか。url() は同じ文書の中（#id）を指すものだけ
function safeCssValue(value: string): boolean {
  if (!value.includes('(')) return true
  let urls = 0
  for (const match of value.matchAll(/([A-Za-z_-][\w-]*)\s*\(/g)) {
    const fn = match[1].toLowerCase()
    if (fn === 'url') urls++
    else if (!CSS_FUNCTIONS.has(fn)) return false
  }
  if (urls === 0) return true
  let local = 0
  for (const match of value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s"'()]*))\s*\)/gi)) {
    if (!LOCAL_REF.test((match[1] ?? match[2] ?? match[3] ?? '').trim())) return false
    local++
  }
  return local === urls
}

// 根の style から、大きさの宣言（width・height など）を外す。引用符を含むなど、区切れないときは style ごと捨てる
function withoutSizeDeclarations(style: string): string | null {
  if (/["']/.test(style)) return null
  const kept = style
    .split(';')
    .filter((declaration) => !/^\s*(?:min-|max-)?(?:width|height)\s*:/i.test(declaration))
    .join(';')
  return kept.trim() ? kept : null
}

function attributeText(attrs: [string, string][]): string {
  return attrs.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('')
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;')
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;')
}

// ---- 大きさ ----

// 画像の大きさ（px）と、書き出す viewBox。width・height が両方あればそれ、片方なら viewBox の縦横比でもう片方を決め、
// どちらもなければ viewBox の大きさ、viewBox もなければ 300×150。viewBox がなければ、元の大きさの範囲を viewBox にする
function intrinsicSize(root: XmlElement): { width: number; height: number; viewBox: string } {
  const attr = (name: string) => root.attrs.find(([key]) => key === name)?.[1]
  const w = parseLength(attr('width'))
  const h = parseLength(attr('height'))
  const box = parseViewBox(attr('viewBox'))
  let width: number
  let height: number
  if (w && h) {
    width = w
    height = h
  } else if (box) {
    width = w ?? (h ? (h * box.w) / box.h : box.w)
    height = h ?? (w ? (w * box.h) / box.w : box.h)
  } else {
    width = w ?? DEFAULT_WIDTH
    height = h ?? DEFAULT_HEIGHT
  }
  const viewBox = box ? `${box.x} ${box.y} ${box.w} ${box.h}` : `0 0 ${width} ${height}`
  // 短い辺は 1 以上、長い辺は MAX_SVG_INTRINSIC_SIDE まで（縦横比は保つ。両方は満たせないときは長い辺を優先する）
  let scale = Math.max(1, 1 / Math.min(width, height))
  scale = Math.min(scale, MAX_SVG_INTRINSIC_SIDE / Math.max(width, height))
  const round = (v: number) => Math.max(0.01, Math.round(v * scale * 100) / 100)
  return { width: round(width), height: round(height), viewBox }
}

// 長さ（px と、pt・pc・mm・cm・in）を px で。% や em、0 以下なら null
function parseLength(value: string | undefined): number | null {
  const match = value === undefined ? null : LENGTH.exec(value.trim())
  if (!match) return null
  const px = Number(match[1]) * UNIT_PX[(match[2] ?? 'px').toLowerCase()]
  return Number.isFinite(px) && px > 0 ? px : null
}

function parseViewBox(value: string | undefined): { x: number; y: number; w: number; h: number } | null {
  if (value === undefined) return null
  const parts = value.trim().split(/[\s,]+/)
  if (parts.length !== 4 || !parts.every((part) => NUMBER.exec(part)?.[0] === part)) return null
  const [x, y, w, h] = parts.map(Number)
  return [x, y, w, h].every(Number.isFinite) && w > 0 && h > 0 ? { x, y, w, h } : null
}
