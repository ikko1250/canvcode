import {
  cleanFormat,
  cssLetterSpacing,
  fontFamilyCss,
  fontFamilyFromCss,
  normalizeRichText,
  paragraphAttributes,
  paragraphText,
  runStyle,
  type TextParagraph,
  type TextRun,
  type TextRunFormat,
  type TextStyle,
} from '@canvcode/nodes'

// 文字の編集用の DOM（contenteditable）と、範囲ごとに書式を持つテキスト（MAI-74）の行き来。
// - 書き出し：段落ごとに div、run ごとに span。span には書式（既定から変えた値）を属性で持たせ、見た目は style で付ける
//   （フォントは Canvas と同じ CSS の font-family。MAI-75）。
//   文字間（MAI-77）は em で、CSS では指定した要素の文字の大きさで換算されて子に継がれるので、文字の大きさを持つ div・span ごとに指定する
//   （Canvas と同じく run の大きさで換算する）。
//   空の段落は <br> だけを持ち、div にその段落の書式を持たせる（そこで打った文字の書式になる）
// - 読み取り：ブラウザがその場で変えた DOM（文字を打つ・IME・段落の中での削除）も読めるようにする。
//   段落は div などのブロックと、途中の <br> で分ける。文字の書式は、いちばん近い祖先の書式の属性から読み、
//   なければ同じ段落の直前の文字の書式を使う（ブラウザが span の外に文字を入れたときなど）。
//   読んだあとは書き出した形に書き直す（textEditor.ts。IME で変換している間を除く）
// 文字の位置は、段落を '\n' でつないだプレーンテキストでの位置（richText.ts と同じ）

export const RUN_FORMAT_ATTRIBUTE = 'data-format'
export const PARAGRAPH_ATTRIBUTE = 'data-paragraph'

const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'SECTION', 'ARTICLE'])

export interface DomPoint {
  node: Node
  offset: number
}

// ---- 書き出し ----

export function renderRichTextDom(root: HTMLElement, paragraphs: readonly TextParagraph[], base: TextStyle): void {
  root.replaceChildren(...paragraphs.map((paragraph) => paragraphElement(root.ownerDocument, paragraph, base)))
}

function paragraphElement(doc: Document, paragraph: TextParagraph, base: TextStyle): HTMLElement {
  const div = doc.createElement('div')
  const attributes = paragraphAttributes(paragraph)
  if (Object.keys(attributes).length > 0) div.setAttribute(PARAGRAPH_ATTRIBUTE, JSON.stringify(attributes))
  const runs = paragraph.runs.length > 0 ? paragraph.runs : [{ text: '' }]
  const styles = runs.map((run) => runStyle(base, run.format))
  // 段落の要素自身の文字（行の高さの strut）は、段落の中で最も小さい文字にする（Canvas のレイアウトと同じ。layout.ts）
  div.style.fontSize = `${Math.min(...styles.map((style) => style.fontSize))}px`
  const letterSpacing = cssLetterSpacing(base)
  if (letterSpacing !== 'normal') div.style.letterSpacing = letterSpacing
  if (paragraphText(paragraph) === '') {
    if (runs[0].format) div.setAttribute(RUN_FORMAT_ATTRIBUTE, JSON.stringify(runs[0].format))
    div.style.color = styles[0].color
    div.style.fontFamily = fontFamilyCss(styles[0].fontFamily)
    div.append(doc.createElement('br'))
    return div
  }
  for (const [i, run] of runs.entries()) {
    if (run.text === '') continue
    const span = doc.createElement('span')
    span.setAttribute(RUN_FORMAT_ATTRIBUTE, JSON.stringify(run.format ?? {}))
    span.style.fontSize = `${styles[i].fontSize}px`
    span.style.color = styles[i].color
    span.style.fontFamily = fontFamilyCss(styles[i].fontFamily)
    if (letterSpacing !== 'normal') span.style.letterSpacing = letterSpacing
    span.textContent = run.text
    div.append(span)
  }
  return div
}

// 書き出した形の HTML（DOM が書き出した形のままかを比べるのに使う）
export function richTextHtml(doc: Document, paragraphs: readonly TextParagraph[], base: TextStyle): string {
  const root = doc.createElement('div')
  renderRichTextDom(root, paragraphs, base)
  return root.innerHTML
}

// ---- 読み取り ----

interface OpenParagraph {
  attributes: object
  runs: TextRun[]
  length: number
  // 直前が <br>（次に文字が来たら段落を分ける。ブロックの最後の <br> は改行にならない）
  pendingBreak: boolean
  sawBreak: boolean
  // 文字のない段落の書式（<br> の祖先の書式）
  emptyFormat: TextRunFormat | undefined
  lastFormat: TextRunFormat | undefined
}

// DOM を読み、段落と、points の位置（文字の位置）を返す
export function readRichTextDom(
  root: HTMLElement,
  points: readonly (DomPoint | null)[] = [],
): { paragraphs: TextParagraph[]; offsets: (number | null)[] } {
  const paragraphs: TextParagraph[] = []
  const offsets: (number | null)[] = points.map(() => null)
  // 閉じた段落の文字数と、その後ろの区切り（1 段落に 1 つ）の合計
  let closed = 0
  let current: OpenParagraph | null = null
  // <br> の直後で記録した位置。その <br> で段落が分かれたら、新しい段落の頭にする
  let afterBreak: number[] = []
  const position = () => closed + (current?.length ?? 0)

  const open = (attributes: object) => {
    current = { attributes, runs: [], length: 0, pendingBreak: false, sawBreak: false, emptyFormat: undefined, lastFormat: undefined }
    afterBreak = []
  }
  const close = (force: boolean) => {
    const p = current
    if (!p) return
    if (p.length > 0 || p.sawBreak || force) {
      paragraphs.push({ ...p.attributes, runs: p.runs.length > 0 ? p.runs : [withFormat('', p.emptyFormat)] })
      closed += p.length + 1
    }
    current = null
    afterBreak = []
  }
  const breakParagraph = () => {
    const attributes = current?.attributes ?? {}
    const pending = afterBreak
    close(true)
    open(attributes)
    for (const i of pending) offsets[i] = position()
  }
  const record = (node: Node, offset: number, at: () => number) => {
    for (const [i, point] of points.entries()) {
      if (!point || point.node !== node || point.offset !== offset) continue
      offsets[i] = at()
      if (current?.pendingBreak) afterBreak.push(i)
    }
  }

  const addText = (node: Text) => {
    const data = node.data.replace(/ /g, ' ')
    if (data === '') {
      record(node, 0, position)
      return
    }
    if (!current) open({})
    if (current!.pendingBreak) breakParagraph()
    const found = formatOf(node, root)
    const format = found.found ? found.format : current!.lastFormat
    const start = position()
    for (let k = 0; k <= data.length; k++) record(node, k, () => start + k)
    for (const [i, piece] of data.split('\n').entries()) {
      if (i > 0) breakParagraph()
      if (piece === '') continue
      const p = current!
      const last = p.runs.at(-1)
      if (last && sameJson(last.format, format)) p.runs[p.runs.length - 1] = withFormat(last.text + piece, format)
      else p.runs.push(withFormat(piece, format))
      p.length += piece.length
      p.lastFormat = format
    }
  }

  const addBreak = (br: Element) => {
    if (!current) open({})
    if (current!.pendingBreak) breakParagraph()
    const p = current!
    if (p.length === 0 && !p.sawBreak) p.emptyFormat = formatOf(br, root).format
    p.pendingBreak = true
    p.sawBreak = true
  }

  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      addText(node as Text)
      return
    }
    if (node.nodeType !== 1) return
    const element = node as Element
    if (element.tagName === 'BR') {
      addBreak(element)
      return
    }
    const block = BLOCK_TAGS.has(element.tagName)
    if (block) {
      close(false)
      open(parseJson(element.getAttribute(PARAGRAPH_ATTRIBUTE)) ?? {})
      if (element.hasAttribute(RUN_FORMAT_ATTRIBUTE)) current!.emptyFormat = formatOf(element, root).format
    }
    for (const [i, child] of [...element.childNodes].entries()) {
      record(element, i, position)
      walk(child)
    }
    record(element, element.childNodes.length, position)
    if (block) close(true)
  }

  for (const [i, child] of [...root.childNodes].entries()) {
    record(root, i, position)
    walk(child)
  }
  record(root, root.childNodes.length, position)
  close(false)

  const result = normalizeRichText(paragraphs)
  const total = result.reduce((sum, p) => sum + paragraphText(p).length, 0) + result.length - 1
  return { paragraphs: result, offsets: offsets.map((offset) => (offset === null ? null : Math.max(0, Math.min(total, offset)))) }
}

// 文字の書式：いちばん近い祖先（root より内側）の書式の属性。見つからなければ found が false。
// ブラウザが作った要素（消した文字の見た目を残すために style を付けた span など）の色・大きさ・フォントも読む。
// 書き出した span は書式がなくても属性（{}）を持つので、その style（既定の値）は読まない
function formatOf(node: Node, root: HTMLElement): { found: boolean; format: TextRunFormat | undefined } {
  const styled: TextRunFormat = {}
  const merge = (format: TextRunFormat | undefined) => cleanFormat({ ...format, ...styled })
  for (let el: Node | null = node.nodeType === 1 ? node : node.parentNode; el && el !== root; el = el.parentNode) {
    if (el.nodeType !== 1) continue
    const element = el as HTMLElement
    const value = element.getAttribute(RUN_FORMAT_ATTRIBUTE)
    if (value !== null) return { found: true, format: merge(parseJson(value) as TextRunFormat | undefined) }
    if (BLOCK_TAGS.has(element.tagName)) break
    const style = element.style
    if (style?.color && styled.color === undefined) styled.color = cssColorToHex(style.color)
    const size = style?.fontSize ? Number.parseFloat(style.fontSize) : NaN
    if (Number.isFinite(size) && style.fontSize.endsWith('px') && styled.fontSize === undefined) styled.fontSize = size
    if (style?.fontFamily && styled.fontFamily === undefined) styled.fontFamily = fontFamilyFromCss(style.fontFamily)
  }
  const format = cleanFormat(styled)
  return format ? { found: true, format } : { found: false, format: undefined }
}

// rgb(r, g, b) を #rrggbb にする（それ以外の書き方はそのまま）
function cssColorToHex(color: string): string {
  const match = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(color)
  if (!match) return color
  return `#${match.slice(1, 4).map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`
}

function parseJson(value: string | null): object | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

function withFormat(text: string, format: TextRunFormat | undefined): TextRun {
  return format ? { text, format } : { text }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// ---- 位置 → DOM ----

// 書き出した形の DOM で、文字の位置 offset に当たる点。run の境目では前の run の終わりにする（続けて打つ文字は前の文字の書式）
export function domPointAt(root: HTMLElement, offset: number): DomPoint {
  const blocks = [...root.children]
  let start = 0
  for (const [i, block] of blocks.entries()) {
    const texts = textNodesIn(block)
    const length = texts.reduce((sum, t) => sum + t.data.length, 0)
    if (offset <= start + length || i === blocks.length - 1) {
      let o = Math.max(0, Math.min(length, offset - start))
      if (texts.length === 0) return { node: block, offset: 0 }
      for (const [j, text] of texts.entries()) {
        if (o <= text.data.length || j === texts.length - 1) return { node: text, offset: Math.min(o, text.data.length) }
        o -= text.data.length
      }
    }
    start += length + 1
  }
  return { node: root, offset: 0 }
}

function textNodesIn(node: Node): Text[] {
  const out: Text[] = []
  const visit = (n: Node) => {
    if (n.nodeType === 3) out.push(n as Text)
    else for (const child of n.childNodes) visit(child)
  }
  visit(node)
  return out
}
