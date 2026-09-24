// 本文の中で文字列を探す（MAI-10、MAI-33）。引用の行の付け直しと、AI に渡す参照（ref）の行の付け直しに使う。
// ブラウザとサーバーの両方から使うので、DOM を使わない

// 引用した文字列を本文から探し、引用を始めた行（1 から）を返す。複数あれば、覚えていた行に最も近いもの。
// 見つからなければ null（「位置不明」。MAI-10 の「5. Markdown の SourceAnchor」）
export function locateQuote(text: string, quote: string, line: number): number | null {
  const needle = quote.replace(/\r\n?/g, '\n')
  const body = text.replace(/\r\n?/g, '\n')
  if (!needle.trim()) return null
  let best: number | null = null
  for (let at = body.indexOf(needle); at !== -1; at = body.indexOf(needle, at + 1)) {
    const found = lineAt(body, at)
    if (best === null || Math.abs(found - line) < Math.abs(best - line)) best = found
    if (found >= line) break
  }
  return best
}

// 本文の位置（文字の番号）が何行目か（1 から）
export function lineAt(text: string, offset: number): number {
  let line = 1
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line++
  return line
}

// 引用した文字列の、本文の中の位置（見つからなければ null）。全画面のエディタで、その範囲を選ぶのに使う
export function quoteRange(text: string, quote: string, line: number): { from: number; to: number } | null {
  const found = locateQuote(text, quote, line)
  if (found === null) return null
  const needle = quote.replace(/\r\n?/g, '\n')
  const body = text.replace(/\r\n?/g, '\n')
  // found 行目から始まる最初の出現
  let start = 0
  for (let n = 1; n < found; n++) start = body.indexOf('\n', start) + 1
  const from = body.indexOf(needle, start)
  if (from === -1) return null
  // 改行コードが \r\n の本文でも、位置がずれないよう、元の本文での位置に直す
  return { from: originalOffset(text, from), to: originalOffset(text, from + needle.length) }
}

function originalOffset(text: string, normalized: number): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    if (n === normalized) return i
    if (text[i] === '\r' && text[i + 1] === '\n') continue
    n++
  }
  return text.length
}
