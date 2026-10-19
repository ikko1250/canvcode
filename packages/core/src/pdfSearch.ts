// PDF の本文の単語検索（試作）。サーバーは取り出しておいたページごとのテキスト（pages.json）で一致するページと件数を探し、
// ブラウザは一致したページの文字の断片から、ハイライトする位置を出す。両方で同じ比べ方をするよう、ここに置く（DOM を使わない）。
// 比べるときは、文字を NFKC で揃え（全角英数字 → 半角、半角カナ → 全角など）、英字の大文字小文字を区別しない。
// 空白と改行は、両側が英字・数字（ラテン・ギリシャ・キリル文字）のときだけ 1 つの空白にまとめ、それ以外（日本語の文字の間など）は無視する。
// PDF から取り出した日本語のテキストには、文字の間や行の途中に余計な空白が入るが、英語では空白が語の区切りなので。
// 行末のハイフンで切れた英単語（「manage-」「ment」）は、ハイフンと改行を取ってつなぐ（引用の textInRegion と同じ）

// 比べるための文字列と、その 1 文字（UTF-16 の 1 単位）ずつが、元の文字列のどこから来たか
export interface NormalizedText {
  text: string
  // text[i] の元の範囲は [from[i], to[i])
  from: number[]
  to: number[]
}

export function normalizeForSearch(source: string): NormalizedText {
  // 元の文字（コードポイント）と、その位置
  const chars: { ch: string; from: number; to: number }[] = []
  let at = 0
  for (const ch of source) {
    chars.push({ ch, from: at, to: at + ch.length })
    at += ch.length
  }
  let text = ''
  const from: number[] = []
  const to: number[] = []
  // 最後に足した文字（コードポイント）。空白とハイフンの扱いを、前の文字で決める
  let last = ''
  const emit = (units: string, start: number, end: number) => {
    for (let k = 0; k < units.length; k++) {
      from.push(start)
      to.push(end)
    }
    text += units
    if (units) last = [...units].at(-1)!
  }
  // 空白の続き（i から）の次の、空白でない文字の位置
  const skipSpaces = (i: number) => {
    let j = i
    while (j < chars.length && isSpace(chars[j].ch)) j++
    return j
  }
  for (let i = 0; i < chars.length; ) {
    const { ch } = chars[i]
    if (isSpace(ch)) {
      const j = skipSpaces(i)
      const next = j < chars.length ? [...folded(chars[j].ch)][0] : undefined
      if (last && next && isWordChar(last) && isWordChar(next)) emit(' ', chars[i].from, chars[j - 1].to)
      i = j
      continue
    }
    // ソフトハイフン（U+00AD）は表示されない区切りなので、飛ばす
    if (ch === '\u00ad') {
      i++
      continue
    }
    // 行末のハイフン：英字のあとのハイフン、改行を含む空白、小文字と続けば、語が行で切れたものとみなしてつなぐ
    if (HYPHENS.has(ch)) {
      const j = skipSpaces(i + 1)
      const between = chars.slice(i + 1, j).some((c) => c.ch === '\n' || c.ch === '\r')
      if (isLetter(last) && between && j < chars.length && /^\p{Ll}$/u.test(chars[j].ch)) {
        i = j
        continue
      }
    }
    emit(folded(ch), chars[i].from, chars[i].to)
    i++
  }
  return { text, from, to }
}

const HYPHENS = new Set(['-', '\u2010'])

function isSpace(ch: string): boolean {
  return /^\s$/u.test(ch)
}

// NFKC で揃えて小文字にし、揃えたことで出てきた空白は取る
function folded(ch: string): string {
  return ch.normalize('NFKC').toLowerCase().replace(/\s/gu, '')
}

// 空白で語を区切る文字（ラテン・ギリシャ・キリル文字と数字）。日本語・中国語・韓国語の文字は含まない
function isWordChar(ch: string): boolean {
  return /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Nd}]$/u.test(ch)
}

function isLetter(ch: string): boolean {
  return /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]$/u.test(ch)
}

// 元の文字列の中の、一致した範囲（UTF-16 の位置。[from, to)）を、前から順に返す。重なる一致は数えない
export function findMatches(source: string | NormalizedText, query: string): { from: number; to: number }[] {
  const body = typeof source === 'string' ? normalizeForSearch(source) : source
  const needle = normalizeForSearch(query).text
  if (!needle) return []
  const out: { from: number; to: number }[] = []
  for (let i = body.text.indexOf(needle); i !== -1; i = body.text.indexOf(needle, i + needle.length)) {
    out.push({ from: body.from[i], to: body.to[i + needle.length - 1] })
  }
  return out
}

export interface PdfSearchPage {
  // 0 から
  pageIndex: number
  count: number
  // 一致したところの前後の文（先頭からいくつか）。結果の一覧に見せる
  snippets: string[]
}

const SNIPPET_CONTEXT = 24
const MAX_SNIPPETS_PER_PAGE = 3

// ページごとのテキストから、一致するページと件数を探す。一致しないページは返さない
export function searchPages(pages: readonly (string | NormalizedText)[], query: string, sources?: readonly string[]): PdfSearchPage[] {
  const out: PdfSearchPage[] = []
  pages.forEach((page, pageIndex) => {
    const matches = findMatches(page, query)
    if (matches.length === 0) return
    const raw = typeof page === 'string' ? page : sources?.[pageIndex]
    const snippets = raw ? matches.slice(0, MAX_SNIPPETS_PER_PAGE).map((m) => snippet(raw, m.from, m.to)) : []
    out.push({ pageIndex, count: matches.length, snippets })
  })
  return out
}

// 一致したところの前後を、空白を詰めて切り出す。一致した部分は【】で囲む
function snippet(text: string, from: number, to: number): string {
  const start = Math.max(0, from - SNIPPET_CONTEXT)
  const end = Math.min(text.length, to + SNIPPET_CONTEXT)
  const squash = (s: string) => s.replace(/\s+/g, ' ')
  return `${start > 0 ? '…' : ''}${squash(text.slice(start, from))}【${squash(text.slice(from, to))}】${squash(text.slice(to, end))}${end < text.length ? '…' : ''}`
}
