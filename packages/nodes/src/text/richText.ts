// 範囲ごとに書式を持てるテキスト（MAI-74）。テキスト・付箋の文字は、段落の並びで、段落は書式付きの文字列（run）の並び。
// - run の書式（TextRunFormat）：色・大きさなど、文字の範囲ごとに変えられるもの。持たない項目はノードの既定
//   （props の fontSize・color など）に従う。既定と同じ値は持たない（normalizeRichText が落とす）。
//   フォント（fontFamily。fonts.ts の名前）は MAI-75。太字・斜体・下線・取り消し線（bold など。MAI-79）は true / false で持ち、
//   既定（ノードの既定はどれも false。layout.ts の baseFormatOf）と違うときだけ持つ（ふつうは true だけが残る）。
//   文字の太さ（fontWeight。100〜900）は、太字（bold）を含めて fontWeight で持つ。bold は古いデータと、
//   太字の切り替え（Ctrl+B など）の patch の書き方として読み、cleanFormat が fontWeight（true は 700、false は 400）に直す。
//   太字としての表示（ボタンのオン・オフ）は、太さが FONT_WEIGHT_BOLD 以上か（resolveFormat が bold を出す）
// - 段落の属性：揃え・箇条書き（MAI-78）など、段落ごとに 1 つのもの。TextParagraph に runs と並べて足す。
//   ここの操作は段落を { ...paragraph, runs } で作り直すので、足した属性は分けたり、つないだりしても残る
// 文字の位置（offset）は、段落を '\n' でつないだプレーンテキストでの位置（UTF-16。DOM の選択範囲と同じ数え方）。
// 正しい形（normalizeRichText の結果）：段落は 1 つ以上。段落の run は 1 つ以上で、空の段落は空の run を 1 つだけ持つ
// （その段落で打つ文字の書式）。空でない段落は空の run を持たず、隣り合う run は書式が違う

export interface TextRunFormat {
  color?: string
  fontSize?: number
  // フォントの名前（fonts.ts。MAI-75）
  fontFamily?: string
  // 文字の太さ（100〜900）。太字はこれで 700 を持つ
  fontWeight?: number
  // 太字・斜体・下線・取り消し線（MAI-79）。bold は持たない（cleanFormat が fontWeight にする）。
  // patch に書くと、太字なら 700、そうでなければ 400 の太さにする（それまでの太さより優先する）
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
}

// オン・オフで切り替える書式（MAI-79。Ctrl+B / I / U、Ctrl+Shift+X とパネル・ツールバーのボタン）
export type TextToggleFormat = 'bold' | 'italic' | 'underline' | 'strikethrough'

export const TEXT_TOGGLE_FORMATS: readonly TextToggleFormat[] = ['bold', 'italic', 'underline', 'strikethrough']

export interface TextRun {
  text: string
  // 既定から変えている書式。なければ既定のまま
  format?: TextRunFormat
}

export interface TextParagraph {
  runs: TextRun[]
  // 箇条書き・番号付きリスト（MAI-78）。なければ普通の段落
  list?: TextList
}

// 段落のリストの属性（MAI-78）。
// - type：箇条書き（bullet）か番号付き（ordered）
// - level：階層（0 が一番外。Tab / Shift+Tab で上げ下げする。0〜MAX_LIST_LEVEL）
// - style：記号・番号の形。なければ階層ごとの既定（DEFAULT_LIST_STYLES を階層で循環。listStyleOf）
export type TextListType = 'bullet' | 'ordered'

export type BulletStyle = 'disc' | 'circle' | 'square' | 'dash' | 'check'
export type OrderedStyle = 'decimal' | 'decimal-paren' | 'paren-decimal' | 'lower-alpha' | 'lower-roman' | 'circled'
export type TextListStyle = BulletStyle | OrderedStyle

export interface TextList {
  type: TextListType
  level: number
  style?: TextListStyle
}

// 選んでいる文字の範囲（start ≤ end）
export interface TextRange {
  start: number
  end: number
}

// 書式を変えるときの差分。undefined の項目は既定に戻す
export type TextRunFormatPatch = { [K in keyof TextRunFormat]?: TextRunFormat[K] | undefined }

// ---- 作る・読む ----

export function richTextFromPlain(text: string, format?: TextRunFormat): TextParagraph[] {
  const clean = cleanFormat(format)
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => ({ runs: [clean ? { text: line, format: clean } : { text: line }] }))
}

export function plainTextOf(paragraphs: readonly TextParagraph[]): string {
  return paragraphs.map(paragraphText).join('\n')
}

export function paragraphText(paragraph: TextParagraph): string {
  return paragraph.runs.map((run) => run.text).join('')
}

export function richTextLength(paragraphs: readonly TextParagraph[]): number {
  return paragraphs.reduce((sum, p) => sum + paragraphText(p).length, 0) + Math.max(0, paragraphs.length - 1)
}

// 段落の属性（runs 以外）
// 文字の範囲ごとの色（run の format.color。空の run は除く）。「このキャンバスで使った色」に出す（MAI-81）
export function runColors(paragraphs: readonly TextParagraph[]): string[] {
  const colors: string[] = []
  for (const paragraph of paragraphs) {
    for (const run of paragraph.runs) if (run.text !== '' && run.format?.color) colors.push(run.format.color)
  }
  return colors
}

export function paragraphAttributes(paragraph: TextParagraph): Omit<TextParagraph, 'runs'> {
  const { runs: _runs, ...attributes } = paragraph
  return attributes
}

// props の文字。版を上げる前の形（text の文字列）しかなければ、それを読む（読み込みの経路で移し忘れても描けるように）
export function paragraphsOf(props: { paragraphs?: TextParagraph[]; text?: string }): TextParagraph[] {
  if (Array.isArray(props.paragraphs) && props.paragraphs.length > 0) return props.paragraphs
  return richTextFromPlain(typeof props.text === 'string' ? props.text : '')
}

// 版 1（文字をプレーンテキストの text で持つ）の props を、paragraphs で持つ形にする（テキスト・付箋の版 2。MAI-74）
export function migratePlainTextProps<P extends { paragraphs: TextParagraph[] }>(props: Record<string, unknown>): P {
  const { text, ...rest } = props
  return { ...rest, paragraphs: richTextFromPlain(typeof text === 'string' ? text : '') } as unknown as P
}

// ---- リスト（MAI-78） ----
// 番号の数え方（listMarkers）：
// - 番号付きの段落は、同じ階層で、同じ種類（番号付き）の段落が続く間は 1 つずつ増える
// - リストでない段落が挟まると、すべての階層で数え直す（空の段落も同じ。続いた段落だけを 1 つのリストとみなす）
// - 浅い階層の段落が挟まると、それより深い階層は数え直す（入れ子のリストは親の項目ごとに 1 から）
// - 同じ階層に箇条書きが挟まると、その階層の番号は数え直す。深い階層の段落は、浅い階層の番号を途切れさせない
// 記号・番号の形は段落ごとに持てる。持たない段落は階層ごとの既定（箇条書きは • ◦ ▪、番号は 1. a. i. を循環）

export const MAX_LIST_LEVEL = 8

export const BULLET_STYLES: readonly BulletStyle[] = ['disc', 'circle', 'square', 'dash', 'check']
export const ORDERED_STYLES: readonly OrderedStyle[] = ['decimal', 'decimal-paren', 'paren-decimal', 'lower-alpha', 'lower-roman', 'circled']

// 階層ごとの既定の形（階層の数だけ循環する）
export const DEFAULT_LIST_STYLES: Record<TextListType, readonly TextListStyle[]> = {
  bullet: ['disc', 'circle', 'square'],
  ordered: ['decimal', 'lower-alpha', 'lower-roman'],
}

const BULLET_GLYPHS: Record<BulletStyle, string> = { disc: '•', circle: '◦', square: '▪', dash: '–', check: '✓' }

export function listTypeOfStyle(style: TextListStyle): TextListType {
  return (BULLET_STYLES as readonly string[]).includes(style) ? 'bullet' : 'ordered'
}

function isListStyle(value: unknown): value is TextListStyle {
  return typeof value === 'string' && ((BULLET_STYLES as readonly string[]).includes(value) || (ORDERED_STYLES as readonly string[]).includes(value))
}

// 段落のリストの属性。読めない値（壊れたデータ）はリストでないとみなし、階層は範囲に収め、種類に合わない形は既定にする
export function listOf(paragraph: TextParagraph): TextList | undefined {
  const list = paragraph.list as Partial<TextList> | undefined
  if (!list || (list.type !== 'bullet' && list.type !== 'ordered')) return undefined
  const level = typeof list.level === 'number' && Number.isFinite(list.level) ? Math.max(0, Math.min(MAX_LIST_LEVEL, Math.round(list.level))) : 0
  const style = isListStyle(list.style) && listTypeOfStyle(list.style) === list.type ? list.style : undefined
  return style ? { type: list.type, level, style } : { type: list.type, level }
}

// 記号・番号の実際の形（持たなければ階層ごとの既定）
export function listStyleOf(list: TextList): TextListStyle {
  if (list.style) return list.style
  const cycle = DEFAULT_LIST_STYLES[list.type]
  return cycle[list.level % cycle.length]
}

// 番号を形に合わせて書く（1 から）
export function formatListNumber(n: number, style: OrderedStyle): string {
  switch (style) {
    case 'decimal':
      return `${n}.`
    case 'decimal-paren':
      return `${n})`
    case 'paren-decimal':
      return `(${n})`
    case 'lower-alpha':
      return `${alphaNumber(n)}.`
    case 'lower-roman':
      return `${romanNumber(n)}.`
    case 'circled':
      return circledNumber(n)
  }
}

// a, b, …, z, aa, ab, …（CSS の lower-alpha と同じ）
function alphaNumber(n: number): string {
  let out = ''
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) out = String.fromCharCode(97 + ((k - 1) % 26)) + out
  return out
}

// i, ii, …（3999 を超えたら数字のまま。CSS の lower-roman と同じ）
function romanNumber(n: number): string {
  if (n >= 4000) return String(n)
  const table: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
  let out = ''
  let k = n
  for (const [value, digits] of table) {
    while (k >= value) {
      out += digits
      k -= value
    }
  }
  return out
}

// ①〜㊿（Unicode にあるのは 50 まで。それより先は (51) のように書く）
function circledNumber(n: number): string {
  if (n >= 1 && n <= 20) return String.fromCodePoint(0x2460 + n - 1)
  if (n >= 21 && n <= 35) return String.fromCodePoint(0x3251 + n - 21)
  if (n >= 36 && n <= 50) return String.fromCodePoint(0x32b1 + n - 36)
  return `(${n})`
}

// 段落ごとの番号（番号付きの段落だけ。ほかは null）。数え方はこの節の頭のとおり
export function listNumbers(paragraphs: readonly TextParagraph[]): (number | null)[] {
  // 階層ごとの、今数えている種類と番号
  let counters: ({ type: TextListType; n: number } | undefined)[] = []
  return paragraphs.map((paragraph) => {
    const list = listOf(paragraph)
    if (!list) {
      counters = []
      return null
    }
    counters = counters.slice(0, list.level + 1)
    const previous = counters[list.level]
    const n = previous && previous.type === list.type ? previous.n + 1 : 1
    counters[list.level] = { type: list.type, n }
    return list.type === 'ordered' ? n : null
  })
}

// 段落ごとの記号・番号の文字（リストでない段落は null）
export function listMarkers(paragraphs: readonly TextParagraph[]): (string | null)[] {
  const numbers = listNumbers(paragraphs)
  return paragraphs.map((paragraph, i) => {
    const list = listOf(paragraph)
    if (!list) return null
    const style = listStyleOf(list)
    return list.type === 'bullet' ? BULLET_GLYPHS[style as BulletStyle] : formatListNumber(numbers[i] ?? 1, style as OrderedStyle)
  })
}

// 段落のリストの属性を変える（undefined ならリストを外す）。runs と、ほかの属性はそのまま
export function withList(paragraph: TextParagraph, list: TextList | undefined): TextParagraph {
  const { list: _list, ...rest } = paragraph
  return list ? { ...rest, list: list.style ? { type: list.type, level: list.level, style: list.style } : { type: list.type, level: list.level } } : rest
}

// start〜end にかかる段落の番号（範囲が空なら、その位置の段落）
export function paragraphIndexesInRange(paragraphs: readonly TextParagraph[], start: number, end: number): number[] {
  if (end < start) [start, end] = [end, start]
  const a = locate(paragraphs, start).p
  const b = locate(paragraphs, end).p
  return Array.from({ length: b - a + 1 }, (_, i) => a + i)
}

// 範囲（null ならすべて）の段落を、ほかの段落はそのままに書き換える
function mapParagraphs(
  paragraphs: readonly TextParagraph[],
  range: TextRange | null,
  map: (paragraph: TextParagraph, index: number, current: readonly TextParagraph[]) => TextParagraph,
): TextParagraph[] {
  const indexes = range ? paragraphIndexesInRange(paragraphs, range.start, range.end) : paragraphs.map((_, i) => i)
  const out = [...paragraphs]
  for (const i of indexes) out[i] = map(out[i], i, out)
  return out
}

// 範囲の段落のリストの種類を変える（none ならリストを外す）。階層はそのまま。
// 種類が変わる段落は、形を既定（階層ごとの循環）に戻す
export function setListType(paragraphs: readonly TextParagraph[], range: TextRange | null, type: TextListType | 'none'): TextParagraph[] {
  return mapParagraphs(paragraphs, range, (paragraph) => {
    if (type === 'none') return withList(paragraph, undefined)
    const list = listOf(paragraph)
    if (list?.type === type) return withList(paragraph, list)
    return withList(paragraph, { type, level: list?.level ?? 0 })
  })
}

// 範囲の段落の記号・番号の形を変える。形は範囲の中で一番浅い階層の段落に当て（リストでない段落は階層 0 とみなし、リストにする）、
// それより深い段落は階層ごとの既定のまま（種類が変われば、種類だけ合わせて形は既定に戻す）。
// こうすると、入れ子のリストを丸ごと選んで形を選んでも、階層ごとに記号が変わったままになる
export function setListStyle(paragraphs: readonly TextParagraph[], range: TextRange | null, style: TextListStyle): TextParagraph[] {
  const type = listTypeOfStyle(style)
  const indexes = range ? paragraphIndexesInRange(paragraphs, range.start, range.end) : paragraphs.map((_, i) => i)
  const top = Math.min(...indexes.map((i) => listOf(paragraphs[i])?.level ?? 0))
  return mapParagraphs(paragraphs, range, (paragraph) => {
    const list = listOf(paragraph)
    const level = list?.level ?? 0
    if (level === top) return withList(paragraph, { type, level, style })
    if (list && list.type !== type) return withList(paragraph, { type, level })
    return paragraph
  })
}

// 範囲の段落のうち、形の項目に見せるもの（setListStyle が形を当てる、一番浅い階層の段落）
export function listStyleTargets(paragraphs: readonly TextParagraph[], range: TextRange | null): TextParagraph[] {
  const indexes = range ? paragraphIndexesInRange(paragraphs, range.start, range.end) : paragraphs.map((_, i) => i)
  const top = Math.min(...indexes.map((i) => listOf(paragraphs[i])?.level ?? 0))
  return indexes.map((i) => paragraphs[i]).filter((paragraph) => (listOf(paragraph)?.level ?? 0) === top)
}

// 範囲のリストの段落の階層を delta だけ変える（Tab / Shift+Tab）。リストでない段落はそのまま。
// 形を持つ段落は、移った先の階層の形を引き継ぐ：上へさかのぼって（リストが途切れるか、移った先より浅い段落に当たるまで）
// 同じ階層・同じ種類の段落があればその形、なければ階層ごとの既定（入れ子にした項目は、親と違う記号になる）
export function indentList(paragraphs: readonly TextParagraph[], range: TextRange, delta: number): TextParagraph[] {
  return mapParagraphs(paragraphs, range, (paragraph, index, current) => {
    const list = listOf(paragraph)
    if (!list) return paragraph
    const level = Math.max(0, Math.min(MAX_LIST_LEVEL, list.level + delta))
    if (level === list.level) return paragraph
    let style: TextListStyle | undefined
    for (let i = index - 1; i >= 0; i--) {
      const before = listOf(current[i])
      if (!before || before.level < level) break
      if (before.level === level && before.type === list.type) {
        style = before.style
        break
      }
    }
    return withList(paragraph, { type: list.type, level, style })
  })
}

// 段落の頭に打つとリストになる文字（「- 」「* 」「1. 」「1) 」。最後の空白を打ったときに変える）
export function listShortcut(textBeforeSpace: string): TextList | null {
  if (textBeforeSpace === '-' || textBeforeSpace === '*') return { type: 'bullet', level: 0 }
  if (textBeforeSpace === '1.') return { type: 'ordered', level: 0 }
  if (textBeforeSpace === '1)') return { type: 'ordered', level: 0, style: 'decimal-paren' }
  return null
}

// ---- 書式 ----

// 太字として見せる太さ（これ以上なら太字のボタンをオンにする。CSS の bold の目安と同じ）
export const FONT_WEIGHT_BOLD = 600

// 中身のない書式は undefined にする（undefined の項目を落とす）。bold は fontWeight にする（bold を優先する）
export function cleanFormat(format: TextRunFormatPatch | undefined): TextRunFormat | undefined {
  if (!format) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(format)) if (value !== undefined) out[key] = value
  if (typeof out.bold === 'boolean') out.fontWeight = out.bold ? 700 : 400
  delete out.bold
  return Object.keys(out).length > 0 ? (out as TextRunFormat) : undefined
}

export function sameFormat(a: TextRunFormat | undefined, b: TextRunFormat | undefined): boolean {
  const ca = cleanFormat(a)
  const cb = cleanFormat(b)
  if (!ca || !cb) return !ca && !cb
  const keys = Object.keys(ca)
  if (keys.length !== Object.keys(cb).length) return false
  return keys.every((key) => Object.is(ca[key as keyof TextRunFormat], cb[key as keyof TextRunFormat]))
}

// 既定と同じ値を落とす
function relativeTo(format: TextRunFormat | undefined, base: TextRunFormat | undefined): TextRunFormat | undefined {
  if (!format || !base) return cleanFormat(format)
  const out: TextRunFormatPatch = { ...cleanFormat(format) }
  for (const key of Object.keys(out) as (keyof TextRunFormat)[]) if (Object.is(out[key], base[key])) delete out[key]
  return cleanFormat(out)
}

// 既定に重ねた、実際の書式（すべての項目を持つ）
export function resolveFormat(base: Required<TextRunFormat>, format: TextRunFormat | undefined): Required<TextRunFormat> {
  const out = { ...base, ...cleanFormat(format) }
  return { ...out, bold: out.fontWeight >= FONT_WEIGHT_BOLD }
}

// オン・オフの書式を切り替えるときの、当てる値（MAI-79）。範囲の文字がすべてオンならオフ、そうでなければ（混在も）オン。
// values は範囲の文字の実際の値（既定に重ねたもの）
export function toggledValue(values: readonly boolean[]): boolean {
  return !(values.length > 0 && values.every(Boolean))
}

// ---- 正しい形にする ----

// base を渡すと、それと同じ値の書式を落とす（ノードの既定と同じなら持たない）
export function normalizeRichText(paragraphs: readonly TextParagraph[], base?: TextRunFormat): TextParagraph[] {
  const out = paragraphs.map((paragraph) => {
    const runs: TextRun[] = []
    let emptyFormat: TextRunFormat | undefined
    let sawEmpty = false
    for (const run of paragraph.runs) {
      const format = relativeTo(run.format, base)
      if (run.text === '') {
        if (!sawEmpty) emptyFormat = format
        sawEmpty = true
        continue
      }
      const last = runs.at(-1)
      if (last && sameFormat(last.format, format)) runs[runs.length - 1] = withFormat(last.text + run.text, format)
      else runs.push(withFormat(run.text, format))
    }
    if (runs.length === 0) runs.push(withFormat('', emptyFormat))
    return { ...paragraph, runs }
  })
  return out.length > 0 ? out : [{ runs: [{ text: '' }] }]
}

function withFormat(text: string, format: TextRunFormat | undefined): TextRun {
  return format ? { text, format } : { text }
}

// ---- 位置 ----

// offset が何番目の段落の、どこにあるか（範囲の外は端に寄せる）
function locate(paragraphs: readonly TextParagraph[], offset: number): { p: number; o: number } {
  let start = 0
  for (const [p, paragraph] of paragraphs.entries()) {
    const length = paragraphText(paragraph).length
    if (offset <= start + length || p === paragraphs.length - 1) return { p, o: Math.max(0, Math.min(length, offset - start)) }
    start += length + 1
  }
  return { p: 0, o: 0 }
}

// run を o の位置で 2 つに分ける。空の段落（空の run だけ）は、両方に同じ空の run を持たせる（書式を引き継ぐため）
function splitRuns(runs: readonly TextRun[], o: number): [TextRun[], TextRun[]] {
  if (runs.every((run) => run.text === '')) return [[...runs], [...runs]]
  const before: TextRun[] = []
  const after: TextRun[] = []
  let start = 0
  for (const run of runs) {
    const end = start + run.text.length
    if (end <= o) before.push(run)
    else if (start >= o) after.push(run)
    else {
      before.push({ ...run, text: run.text.slice(0, o - start) })
      after.push({ ...run, text: run.text.slice(o - start) })
    }
    start = end
  }
  return [before.filter((run) => run.text !== ''), after.filter((run) => run.text !== '')]
}

// offset の位置で打つ文字の書式：同じ段落で直前の文字の書式。段落の頭なら、その段落の最初の run の書式
export function formatAt(paragraphs: readonly TextParagraph[], offset: number): TextRunFormat | undefined {
  const { p, o } = locate(paragraphs, offset)
  const runs = paragraphs[p]?.runs ?? []
  let start = 0
  for (const run of runs) {
    const end = start + run.text.length
    if (o > start && o <= end) return run.format
    start = end
  }
  return runs[0]?.format
}

// offset の位置の文字（直後の文字）の書式。段落の終わりなら formatAt と同じ。範囲を打ち替えるときに使う（ブラウザと同じ）
export function formatOfCharAt(paragraphs: readonly TextParagraph[], offset: number): TextRunFormat | undefined {
  const { p, o } = locate(paragraphs, offset)
  const runs = paragraphs[p]?.runs ?? []
  let start = 0
  for (const run of runs) {
    const end = start + run.text.length
    if (o >= start && o < end) return run.format
    start = end
  }
  return formatAt(paragraphs, offset)
}

// ---- 書き換え ----

// start〜end を inserted で置き換える。inserted の最初の段落は start の段落に、最後の段落は end の段落の残りにつなぐ。
// 間の段落は、そのまま入る（段落の属性も）。最初の段落は start の段落の属性を、最後の段落は inserted の最後の段落の属性を持つ
export function replaceRange(
  paragraphs: readonly TextParagraph[],
  start: number,
  end: number,
  inserted: readonly TextParagraph[],
  base?: TextRunFormat,
): TextParagraph[] {
  if (end < start) [start, end] = [end, start]
  const a = locate(paragraphs, start)
  const b = locate(paragraphs, end)
  const headParagraph = paragraphs[a.p]
  const tailParagraph = paragraphs[b.p]
  const [head] = splitRuns(headParagraph.runs, a.o)
  const [, tail] = splitRuns(tailParagraph.runs, b.o)
  const typing = formatAt(paragraphs, start)
  const parts = inserted.length > 0 ? inserted : [{ runs: [] }]
  let middle: TextParagraph[]
  if (parts.length === 1) {
    middle = [{ ...headParagraph, runs: [...head, ...parts[0].runs, ...tail] }]
  } else {
    const last = parts[parts.length - 1]
    middle = [{ ...headParagraph, runs: [...head, ...parts[0].runs] }, ...parts.slice(1, -1), { ...last, runs: [...last.runs, ...tail] }]
  }
  // 文字のない段落は、書式（空の run）を持たせる。持っていなければ start の位置で打つ文字の書式
  middle = middle.map((paragraph) =>
    paragraph.runs.length > 0 ? paragraph : { ...paragraph, runs: [withFormat('', cleanFormat(typing))] },
  )
  return normalizeRichText([...paragraphs.slice(0, a.p), ...middle, ...paragraphs.slice(b.p + 1)], base)
}

// start〜end の文字（段落の属性・書式ごと）。範囲が空なら、その位置の書式の空の段落 1 つ
export function sliceRichText(paragraphs: readonly TextParagraph[], start: number, end: number): TextParagraph[] {
  if (end < start) [start, end] = [end, start]
  const a = locate(paragraphs, start)
  const b = locate(paragraphs, end)
  const out: TextParagraph[] = []
  for (let p = a.p; p <= b.p; p++) {
    let runs = paragraphs[p].runs
    // 後ろを先に切る（前の位置は変わらない）
    if (p === b.p) runs = splitRuns(runs, b.o)[0]
    if (p === a.p) runs = splitRuns(runs, a.o)[1]
    out.push({ ...paragraphs[p], runs: runs.length > 0 ? runs : [withFormat('', cleanFormat(p === a.p ? formatAt(paragraphs, start) : paragraphs[p].runs[0]?.format))] })
  }
  return normalizeRichText(out)
}

// start〜end の文字の書式を変える（patch を重ねる。undefined の項目は既定に戻す）。
// 範囲の中の空の段落にも当てる（そこで打つ文字の書式になる）。範囲が空なら何もしない
export function applyRunFormat(
  paragraphs: readonly TextParagraph[],
  start: number,
  end: number,
  patch: TextRunFormatPatch,
  base?: TextRunFormat,
): TextParagraph[] {
  if (end < start) [start, end] = [end, start]
  if (start === end) return normalizeRichText(paragraphs, base)
  const apply = (run: TextRun): TextRun => withFormat(run.text, cleanFormat({ ...run.format, ...patch }))
  let offset = 0
  const out = paragraphs.map((paragraph) => {
    const length = paragraphText(paragraph).length
    const pStart = offset
    offset += length + 1
    const from = Math.max(start, pStart) - pStart
    const to = Math.min(end, pStart + length) - pStart
    if (length === 0) return start <= pStart && pStart <= end ? { ...paragraph, runs: paragraph.runs.map(apply) } : paragraph
    if (from >= to) return paragraph
    const [before, rest] = splitRuns(paragraph.runs, from)
    const [inside, after] = splitRuns(rest, to - from)
    return { ...paragraph, runs: [...before, ...inside.map(apply), ...after] }
  })
  return normalizeRichText(out, base)
}

// start〜end の文字の書式（文字ごと。同じ書式の続きは 1 つ）。範囲が空なら、その位置で打つ文字の書式。
// 範囲の中の空の段落の書式も含める
export function formatsInRange(paragraphs: readonly TextParagraph[], start: number, end: number): (TextRunFormat | undefined)[] {
  if (end < start) [start, end] = [end, start]
  if (start === end) return [formatAt(paragraphs, start)]
  const out: (TextRunFormat | undefined)[] = []
  let offset = 0
  for (const paragraph of paragraphs) {
    const length = paragraphText(paragraph).length
    const pStart = offset
    offset += length + 1
    if (length === 0) {
      if (start <= pStart && pStart <= end) out.push(paragraph.runs[0]?.format)
      continue
    }
    let runStart = pStart
    for (const run of paragraph.runs) {
      const runEnd = runStart + run.text.length
      if (runEnd > start && runStart < end) out.push(run.format)
      runStart = runEnd
    }
  }
  return out
}

// すべての run の書式を変える（ノード全体の文字を大きくする・既定に戻すなど）
export function mapRunFormats(
  paragraphs: readonly TextParagraph[],
  map: (format: TextRunFormat | undefined) => TextRunFormatPatch | undefined,
  base?: TextRunFormat,
): TextParagraph[] {
  return normalizeRichText(
    paragraphs.map((paragraph) => ({ ...paragraph, runs: paragraph.runs.map((run) => withFormat(run.text, cleanFormat(map(run.format)))) })),
    base,
  )
}

// key の書式をすべての run から外す（ノード全体の値を変えたとき、範囲ごとの値をやめてノードの値にそろえる）
// 太さと太字は同じ値（fontWeight）なので、どちらを外しても太さを外す
export function clearRunFormat(paragraphs: readonly TextParagraph[], key: keyof TextRunFormat): TextParagraph[] {
  const keys = key === 'bold' || key === 'fontWeight' ? ['bold', 'fontWeight'] : [key]
  return mapRunFormats(paragraphs, (format) => {
    const clean = cleanFormat(format)
    return clean ? { ...clean, ...Object.fromEntries(keys.map((k) => [k, undefined])) } : undefined
  })
}

// 書式を、既定に重ねた実際の値にする（クリップボードに載せるとき。貼り付け先の既定が違っても同じに見えるように）
export function resolveRichText(paragraphs: readonly TextParagraph[], base: Required<TextRunFormat>): TextParagraph[] {
  return paragraphs.map((paragraph) => ({
    ...paragraph,
    runs: paragraph.runs.map((run) => ({ text: run.text, format: resolveFormat(base, run.format) })),
  }))
}
