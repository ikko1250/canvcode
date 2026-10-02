// 範囲ごとに書式を持てるテキスト（MAI-74）。テキスト・付箋の文字は、段落の並びで、段落は書式付きの文字列（run）の並び。
// - run の書式（TextRunFormat）：色・大きさなど、文字の範囲ごとに変えられるもの。持たない項目はノードの既定
//   （props の fontSize・color など）に従う。既定と同じ値は持たない（normalizeRichText が落とす）。
//   フォント（fontFamily。fonts.ts の名前）は MAI-75。後の課題で、太字・斜体・下線・取り消し線（MAI-79）をここに足す
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
}

export interface TextRun {
  text: string
  // 既定から変えている書式。なければ既定のまま
  format?: TextRunFormat
}

export interface TextParagraph {
  runs: TextRun[]
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

// ---- 書式 ----

// 中身のない書式は undefined にする（undefined の項目を落とす）
export function cleanFormat(format: TextRunFormatPatch | undefined): TextRunFormat | undefined {
  if (!format) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(format)) if (value !== undefined) out[key] = value
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
  const out: TextRunFormatPatch = { ...format }
  for (const key of Object.keys(out) as (keyof TextRunFormat)[]) if (Object.is(out[key], base[key])) delete out[key]
  return cleanFormat(out)
}

// 既定に重ねた、実際の書式（すべての項目を持つ）
export function resolveFormat(base: Required<TextRunFormat>, format: TextRunFormat | undefined): Required<TextRunFormat> {
  return { ...base, ...cleanFormat(format) }
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
export function clearRunFormat(paragraphs: readonly TextParagraph[], key: keyof TextRunFormat): TextParagraph[] {
  return mapRunFormats(paragraphs, (format) => (format ? { ...format, [key]: undefined } : undefined))
}

// 書式を、既定に重ねた実際の値にする（クリップボードに載せるとき。貼り付け先の既定が違っても同じに見えるように）
export function resolveRichText(paragraphs: readonly TextParagraph[], base: Required<TextRunFormat>): TextParagraph[] {
  return paragraphs.map((paragraph) => ({
    ...paragraph,
    runs: paragraph.runs.map((run) => ({ text: run.text, format: resolveFormat(base, run.format) })),
  }))
}
