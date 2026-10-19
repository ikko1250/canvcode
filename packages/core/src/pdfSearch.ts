// PDF の本文の単語検索（試作）。サーバーは取り出しておいたページごとのテキスト（pages.json）で一致するページと件数を探し、
// ブラウザは一致したページの文字の断片から、ハイライトする位置を出す。両方で同じ比べ方をするよう、ここに置く（DOM を使わない）。
// 比べるときは、文字を NFKC で揃え（全角英数字 → 半角、半角カナ → 全角など）、英字の大文字小文字を区別せず、空白と改行を無視する。
// PDF から取り出したテキストは、日本語の文字の間や行の途中に余計な空白が入ったり、行の終わりで語が切れたりするので

// 比べるための文字列と、その 1 文字（UTF-16 の 1 単位）ずつが、元の文字列のどこから来たか
export interface NormalizedText {
  text: string
  // text[i] の元の範囲は [from[i], to[i])
  from: number[]
  to: number[]
}

export function normalizeForSearch(source: string): NormalizedText {
  let text = ''
  const from: number[] = []
  const to: number[] = []
  let at = 0
  for (const ch of source) {
    const end = at + ch.length
    // ソフトハイフン（U+00AD）は表示されない区切りなので、空白と同じく飛ばす
    if (!/^[\s­]$/u.test(ch)) {
      for (const unit of ch.normalize('NFKC').toLowerCase().replace(/\s/gu, '')) {
        for (let k = 0; k < unit.length; k++) {
          from.push(at)
          to.push(end)
        }
        text += unit
      }
    }
    at = end
  }
  return { text, from, to }
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
