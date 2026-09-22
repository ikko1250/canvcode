// 旧実装（recursive-infinite-canvas）の markdownMath.ts から、数式を見つける関数だけを流用している（MAI-3）。
// CodeMirror（Lezer）用の拡張は、エディタを作る段階で必要になったら移す。

// Pandoc / Obsidian は「開き $ の直後・閉じ $ の直前に空白を許さない」。
// 論文 PDF からの Markdown（OCR）は `$ v(t) $` や連続する `$ a $  $ b $` が
// 普通に出るので、閉じ $ までの中身が数式らしいときだけ採用する。
// 最初の閉じ $ で判定を打ち切る（先の $ まで飲み込む暴走を防ぐ）。

export interface MathMatch {
  raw: string
  tex: string
  displayMode: boolean
  open: string
  close: string
}

export function looksLikeMath(raw: string): boolean {
  const text = raw.trim()
  if (text.length === 0 || text.length > 800) return false
  if (/[\\^_{}]/.test(text)) return true
  if (/=/.test(text) && /[A-Za-z]/.test(text)) return true
  // `$ T $` / `$ t $` / `$ v(t) $` / `$ t+k $` のような短い識別子
  if (/^[A-Za-z](?:[A-Za-z0-9+\-*/|,.]|\([^)]{0,80}\))*$/.test(text) && text.length <= 40) {
    return true
  }
  return false
}

function isEscaped(source: string, position: number) {
  let backslashes = 0
  for (let index = position - 1; index >= 0 && source[index] === '\\'; index -= 1) {
    backslashes += 1
  }
  return backslashes % 2 === 1
}

function findClosing(source: string, close: string, from: number, allowNewline: boolean) {
  for (let index = from; index <= source.length - close.length; index += 1) {
    if (!allowNewline && source[index] === '\n') return -1
    if (source.startsWith(close, index) && !isEscaped(source, index)) return index
  }
  return -1
}

function inlineDollarMath(source: string): MathMatch | undefined {
  if (!source.startsWith('$') || source.startsWith('$$')) return undefined

  const closeFrom = findClosing(source, '$', 1, false)
  if (closeFrom <= 1 || source.startsWith('$$', closeFrom)) return undefined

  const inner = source.slice(1, closeFrom)
  // 密着 `$t+k$` は Pandoc どおり無条件。空白入りは数式らしい中身のときだけ。
  const tight = inner === inner.trim()
  if (!tight && !looksLikeMath(inner)) return undefined

  const nextCh = source.charCodeAt(closeFrom + 1)
  if (nextCh >= 48 && nextCh <= 57) return undefined

  return {
    raw: source.slice(0, closeFrom + 1),
    tex: inner.trim(),
    displayMode: false,
    open: '$',
    close: '$',
  }
}

function inlineBackslashMath(source: string): MathMatch | undefined {
  if (!source.startsWith('\\(')) return undefined

  const closeFrom = findClosing(source, '\\)', 2, false)
  if (closeFrom < 0) return undefined
  const inner = source.slice(2, closeFrom)
  if (inner.trim() === '') return undefined

  return {
    raw: source.slice(0, closeFrom + 2),
    tex: inner.trim(),
    displayMode: false,
    open: '\\(',
    close: '\\)',
  }
}

export function matchInlineMath(source: string): MathMatch | undefined {
  return inlineDollarMath(source) ?? inlineBackslashMath(source)
}

function blockMath(source: string, open: string, close: string): MathMatch | undefined {
  if (!source.startsWith(open)) return undefined

  const closeFrom = findClosing(source, close, open.length, true)
  if (closeFrom < 0) return undefined
  const afterClose = source.slice(closeFrom + close.length)
  if (afterClose !== '' && afterClose[0] !== '\n') return undefined

  const inner = source.slice(open.length, closeFrom)
  if (inner.trim() === '') return undefined

  return {
    raw: source.slice(0, closeFrom + close.length),
    tex: inner.trim(),
    displayMode: true,
    open,
    close,
  }
}

export function matchBlockMath(source: string): MathMatch | undefined {
  return blockMath(source, '$$', '$$') ?? blockMath(source, '\\[', '\\]')
}
