import { Vim } from '@replit/codemirror-vim'
import type { CodeMirrorV, MotionArgs, Pos, vimState } from '@replit/codemirror-vim'

// vim モードで日本語の文を扱いやすくする（MAI-96）。
// 1. f / F / t / T と ; , で、記号を打つと全角の記号にも跳ぶ（f, なら「,」「、」「，」のうち近いもの）
// 2. Space f / Space F とローマ字 2 キーで、ひらがな・カタカナに跳ぶ（Space f t a で「た」か「タ」）
// 3. w / b / e / ge と iw / aw の語の区切りを、日本語の所だけ Intl.Segmenter で決める（「日本語｜の｜単語」）。
//    codemirror-vim は漢字・かなを全部英字と同じ「語の文字」と見るので、句読点までの日本語の連続が 1 語になっていた。
//    英字・数字・記号の区切りと W / B（空白まで）は、元の codemirror-vim と同じ
// codemirror-vim の元の動作（findWord・moveToWord・expandWordUnderCursor・moveToCharacter）を写し、区切りと探す文字だけを変える

// ---- 1. 記号の全角の候補 ----

// 半角の記号と、それを打ったときに跳びたい全角の記号。全角の英数字・記号の形（，．［ など）は下で足す。
// 日本語入力が ON のときにそのキーで入る記号（、。「」・ー〜）も入れる
const WIDE_SYMBOLS: Record<string, string> = {
  ',': '、',
  '.': '。',
  '[': '「『【〔',
  ']': '」』】〕',
  '<': '〈《',
  '>': '〉》',
  '/': '・',
  '-': 'ー',
  '~': '〜',
  '\\': '￥',
  '"': '“”',
  "'": '‘’',
  ' ': '　',
}

// ---- 2. ローマ字 2 キーとかな ----

// ローマ字（2 キー）とひらがな。母音 1 文字は 2 回打つ。綴りは 2 キーで決まる形（si・ti・tu・hu）。
// 2 キーで表せないもの（っ・ゃ・漢字）は入れない
export const KANA_OF_ROMAJI: Record<string, string> = (() => {
  const table: Record<string, string> = { aa: 'あ', ii: 'い', uu: 'う', ee: 'え', oo: 'お', ya: 'や', yu: 'ゆ', yo: 'よ', wa: 'わ', wo: 'を', nn: 'ん' }
  const rows: Record<string, string> = {
    k: 'かきくけこ',
    s: 'さしすせそ',
    t: 'たちつてと',
    n: 'なにぬねの',
    h: 'はひふへほ',
    m: 'まみむめも',
    r: 'らりるれろ',
    g: 'がぎぐげご',
    z: 'ざじずぜぞ',
    d: 'だぢづでど',
    b: 'ばびぶべぼ',
    p: 'ぱぴぷぺぽ',
  }
  for (const [consonant, kana] of Object.entries(rows)) {
    ;[...'aiueo'].forEach((vowel, index) => (table[consonant + vowel] = kana[index]))
  }
  return table
})()

// 跳ぶ先の候補。半角の記号なら全角の記号も、ひらがななら同じ音のカタカナも入れる。ほかは打った文字だけ
export function characterCandidates(character: string): string[] {
  const candidates = [character]
  const code = character.charCodeAt(0)
  if (character.length === 1 && /[!-/:-@[-`{-~ ]/.test(character)) {
    if (code > 0x20) candidates.push(String.fromCharCode(code + 0xfee0))
    candidates.push(...(WIDE_SYMBOLS[character] ?? ''))
  } else if (character.length === 1 && code >= 0x3041 && code <= 0x3096) {
    candidates.push(String.fromCharCode(code + 0x60))
  }
  return candidates
}

// 行の中で、start より後ろ（前）にある候補のうち、一番近いものの位置。なければ -1
function indexOfCandidates(line: string, start: number, candidates: string[], forward: boolean): number {
  let found = -1
  for (const candidate of candidates) {
    if (forward) {
      const index = line.indexOf(candidate, start + 1)
      if (index !== -1 && (found === -1 || index < found)) found = index
    } else if (start > 0) {
      const index = line.lastIndexOf(candidate, start - 1)
      if (index > found) found = index
    }
  }
  return found
}

// codemirror-vim の moveToCharacter（f の本体）と同じ。repeat 回目の候補の位置
function moveToCharacter(cm: CodeMirrorV, repeat: number, forward: boolean, character: string | undefined, head: Pos): Pos | undefined {
  if (!character) return undefined
  const line = cm.getLine(head.line)
  const candidates = characterCandidates(character)
  let index = head.ch
  for (let i = 0; i < repeat; i++) {
    index = indexOfCandidates(line, index, candidates, forward)
    if (index === -1) return undefined
  }
  return { line: head.line, ch: index }
}

// ; と , で繰り返せるよう、最後の f / t を覚える（codemirror-vim の recordLastCharacterSearch と同じ）
function recordLastCharacterSearch(increment: number, args: MotionArgs): void {
  const last = Vim.getVimGlobalState_().lastCharacterSearch
  last.increment = increment
  last.forward = !!args.forward
  last.selectedCharacter = args.selectedCharacter ?? ''
}

// ---- 3. 語の区切り ----

// codemirror-vim の「語の文字」と同じ
const WORD_CHAR = /[\w\p{Alphabetic}\p{Number}_]/u
// 日本語の文字（漢字・ひらがな・カタカナ・ー・々）。この文字の前後だけを Intl.Segmenter で区切る
const JAPANESE_CHAR = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u

const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('ja', { granularity: 'word' }) : null

// 行の各位置（UTF-16 の位置）が入る語の番号。空白は -1。
// bigWord（W / B）なら空白でない文字の連続が 1 語。そうでなければ、語の文字の連続と記号の連続が 1 語で（ここまで codemirror-vim と同じ）、
// 語の文字の連続の中の日本語の文字の前後を、Intl.Segmenter の区切りで分ける
export function wordGroupsOfLine(line: string, bigWord: boolean): Int32Array {
  const cache = bigWord ? bigWordGroupCache : wordGroupCache
  const cached = cache.get(line)
  if (cached) {
    // 最近使ったものとして、後ろに付け直す
    cache.delete(line)
    cache.set(line, cached)
    return cached
  }
  const groups = new Int32Array(line.length)
  // 0：空白、1：語の文字、2：記号。サロゲートペアの文字は、2 つの位置に同じ種類を入れる
  const kinds = new Uint8Array(line.length)
  for (let i = 0; i < line.length; ) {
    const char = String.fromCodePoint(line.codePointAt(i)!)
    const kind = /\s/.test(char) ? 0 : bigWord ? 1 : WORD_CHAR.test(char) ? 1 : 2
    kinds.fill(kind, i, i + char.length)
    i += char.length
  }
  let group = -1
  for (let i = 0; i < line.length; i++) {
    if (kinds[i] === 0) {
      groups[i] = -1
      continue
    }
    if (i === 0 || kinds[i - 1] !== kinds[i]) group++
    groups[i] = group
  }
  if (!bigWord && segmenter && JAPANESE_CHAR.test(line)) {
    // 語の文字の連続ごとに、日本語の文字が入っていれば区切る
    const breaks: number[] = []
    for (let start = 0; start < line.length; ) {
      if (kinds[start] !== 1) {
        start++
        continue
      }
      let end = start
      while (end < line.length && kinds[end] === 1) end++
      const run = line.slice(start, end)
      if (JAPANESE_CHAR.test(run)) {
        for (const { index } of segmenter.segment(run)) {
          if (index > 0 && (isJapaneseBefore(run, index) || isJapaneseAt(run, index))) breaks.push(start + index)
        }
      }
      start = end
    }
    // 区切りの位置から後ろの番号を 1 つずつずらす
    let shift = 0
    let next = 0
    for (let i = 0; i < line.length; i++) {
      while (next < breaks.length && breaks[next] === i) {
        shift++
        next++
      }
      if (groups[i] >= 0) groups[i] += shift
    }
  }
  cache.set(line, groups)
  if (cache.size > GROUP_CACHE_SIZE) cache.delete(cache.keys().next().value!)
  return groups
}

function isJapaneseAt(text: string, index: number): boolean {
  return JAPANESE_CHAR.test(String.fromCodePoint(text.codePointAt(index)!))
}

function isJapaneseBefore(text: string, index: number): boolean {
  const low = text.charCodeAt(index - 1)
  const start = low >= 0xdc00 && low <= 0xdfff && index >= 2 ? index - 2 : index - 1
  return isJapaneseAt(text, start)
}

// 同じ行を何度も区切らないよう、最近の行の区切りを覚えておく
const GROUP_CACHE_SIZE = 200
const wordGroupCache = new Map<string, Int32Array>()
const bigWordGroupCache = new Map<string, Int32Array>()

function isLine(cm: CodeMirrorV, line: number): boolean {
  return line >= cm.firstLine() && line <= cm.lastLine()
}

interface FoundWord {
  from: number
  to: number
  line: number
}

// codemirror-vim の findWord と同じ。cur から forward の向きに、次の語の範囲を返す。
// 前へ探したときの to は、語の最後の文字の位置（codemirror-vim と同じ）
function findWord(cm: CodeMirrorV, cur: Pos, forward: boolean, bigWord: boolean, emptyLineIsWord: boolean): FoundWord | null {
  let lineNum = cur.line
  let pos = cur.ch
  let line = cm.getLine(lineNum)
  const dir = forward ? 1 : -1
  if (emptyLineIsWord && line === '') {
    lineNum += dir
    if (!isLine(cm, lineNum)) return null
    line = cm.getLine(lineNum)
    pos = forward ? 0 : line.length
  }
  for (;;) {
    if (emptyLineIsWord && line === '') return { from: 0, to: 0, line: lineNum }
    const stop = dir > 0 ? line.length : -1
    const groups = wordGroupsOfLine(line, bigWord)
    while (pos !== stop) {
      const group = pos < line.length ? groups[pos] : -1
      if (group < 0) {
        pos += dir
        continue
      }
      const wordStart = pos
      while (pos !== stop && groups[pos] === group) pos += dir
      const wordEnd = pos
      // 語の最後の文字から始めたときは、次の語を探す
      if (wordStart === cur.ch && lineNum === cur.line && wordEnd === wordStart + dir) continue
      return { from: Math.min(wordStart, wordEnd + 1), to: Math.max(wordStart, wordEnd), line: lineNum }
    }
    lineNum += dir
    if (!isLine(cm, lineNum)) return null
    line = cm.getLine(lineNum)
    pos = dir > 0 ? 0 : line.length
  }
}

// codemirror-vim の moveToWord と同じ（w・e・b・ge と W・E・B・gE）
function moveToWord(cm: CodeMirrorV, cur: Pos, repeat: number, forward: boolean, wordEnd: boolean, bigWord: boolean): Pos | undefined {
  const curStart = { line: cur.line, ch: cur.ch }
  const words: FoundWord[] = []
  if ((forward && !wordEnd) || (!forward && wordEnd)) repeat++
  // e では、空行を語と見ない（vim と同じ）
  const emptyLineIsWord = !(forward && wordEnd)
  for (let i = 0; i < repeat; i++) {
    const word = findWord(cm, cur, forward, bigWord, emptyLineIsWord)
    if (!word) {
      const end = cm.getLine(cm.lastLine()).length
      words.push(forward ? { line: cm.lastLine(), from: end, to: end } : { line: 0, from: 0, to: 0 })
      break
    }
    words.push(word)
    cur = { line: word.line, ch: forward ? word.to - 1 : word.from }
  }
  const shortCircuit = words.length !== repeat
  const firstWord = words[0]
  let lastWord = words.pop()
  if (forward && !wordEnd) {
    // w：語の途中から始めたのでなければ、余分に探した最後の語を捨てる
    if (!shortCircuit && (firstWord.from !== curStart.ch || firstWord.line !== curStart.line)) lastWord = words.pop()
    return lastWord && { line: lastWord.line, ch: lastWord.from }
  }
  if (forward && wordEnd) return lastWord && { line: lastWord.line, ch: lastWord.to - 1 }
  if (!forward && wordEnd) {
    // ge
    if (!shortCircuit && (firstWord.to !== curStart.ch || firstWord.line !== curStart.line)) lastWord = words.pop()
    return lastWord && { line: lastWord.line, ch: lastWord.to }
  }
  // b
  return lastWord && { line: lastWord.line, ch: lastWord.from }
}

// codemirror-vim の expandWordUnderCursor と同じ（iw・aw。複数行にまたがってよい）
function expandWordUnderCursor(cm: CodeMirrorV, cur: Pos, inclusive: boolean): { start: Pos; end: Pos } | null {
  const line = cm.getLine(cur.line)
  let endLine = line
  let endLineNumber = cur.line
  let idx = cur.ch
  const isSpace = (ch: string) => /\s/.test(ch)
  let wordOnNextLine: FoundWord | null = null
  let start: number
  let end: number
  if (!inclusive && isSpace(line.charAt(idx))) {
    // iw を空白の上で使ったときは、空白の連続
    start = idx
    end = idx
    while (start >= 0 && isSpace(line.charAt(start))) start--
    start++
    while (end < line.length && isSpace(line.charAt(end))) end++
  } else {
    // 空白でない文字まで進める。行の終わりまでなければ、次の行の語まで
    while (!/\S/.test(line.charAt(idx))) {
      idx++
      if (idx >= line.length) {
        idx--
        wordOnNextLine = findWord(cm, cur, true, false, true)
        break
      }
    }
    const groups = wordGroupsOfLine(line, false)
    const group = idx >= 0 && idx < line.length ? groups[idx] : -1
    start = idx
    end = idx
    if (group < 0) {
      start = idx + 1
    } else {
      while (start >= 0 && groups[start] === group) start--
      start++
    }
    if (wordOnNextLine) {
      end = wordOnNextLine.to
      endLineNumber = wordOnNextLine.line
      endLine = cm.getLine(endLineNumber)
      if (!endLine && end === 0) end++
    } else if (group >= 0) {
      while (end < line.length && groups[end] === group) end++
    }
  }
  if (inclusive) {
    // 語の後ろに空白があれば含める。なければ、語の前の空白を含める（行の始めの字下げは除く）
    const wordEnd = end
    const startsWithSpace = cur.ch <= start && isSpace(line.charAt(cur.ch))
    if (!startsWithSpace) {
      while (end < endLine.length && isSpace(endLine.charAt(end))) end++
    }
    if (wordEnd === end || startsWithSpace) {
      const wordStart = start
      while (start > 0 && isSpace(line.charAt(start - 1))) start--
      if (!start && !startsWithSpace) start = wordStart
    }
  }
  return { start: { line: cur.line, ch: start }, end: { line: endLineNumber, ch: end } }
}

function isBefore(a: Pos, b: Pos): boolean {
  return a.line < b.line || (a.line === b.line && a.ch < b.ch)
}

// codemirror-vim の expandSelection と同じ（visual モードで、いまの選択を語まで広げる）
function expandSelection(cm: CodeMirrorV, vim: vimState, start: Pos, end: Pos): [Pos, Pos] {
  let { head, anchor } = vim.sel
  if (isBefore(end, start)) [start, end] = [end, start]
  if (isBefore(head, anchor)) {
    head = isBefore(start, head) ? start : head
    anchor = isBefore(anchor, end) ? end : anchor
  } else {
    anchor = isBefore(start, anchor) ? start : anchor
    head = isBefore(head, end) ? end : head
    head = { line: head.line, ch: head.ch - 1 }
    if (head.ch === -1 && head.line !== cm.firstLine()) head = { line: head.line - 1, ch: cm.getLine(head.line - 1).length }
  }
  return [anchor, head]
}

// ---- 登録 ----

let registered = false

export function registerJapaneseMotions(): void {
  if (registered) return
  registered = true

  // f / F（Space f・Space F のかなも、この動作を使う）。
  // 見つからなければ動かない。codemirror-vim はいまの位置を返すので、df で見つからないときにカーソルの文字を消していた
  Vim.defineMotion('moveToCharacter', (cm, head, args) => {
    recordLastCharacterSearch(0, args)
    return moveToCharacter(cm, args.repeat, !!args.forward, args.selectedCharacter, head) ?? null
  })
  // t / T（この配列では Space t・Space T）
  Vim.defineMotion('moveTillCharacter', (cm, head, args) => {
    const increment = args.forward ? -1 : 1
    recordLastCharacterSearch(increment, args)
    const found = moveToCharacter(cm, args.repeat, !!args.forward, args.selectedCharacter, head)
    return found ? { line: found.line, ch: found.ch + increment } : null
  })
  // ; と ,
  Vim.defineMotion('repeatLastCharacterSearch', (cm, head, args) => {
    const last = Vim.getVimGlobalState_().lastCharacterSearch
    const forward = args.forward === last.forward
    const increment = (last.increment ? 1 : 0) * (forward ? -1 : 1)
    args.inclusive = forward
    const found = moveToCharacter(cm, args.repeat, forward, last.selectedCharacter, { line: head.line, ch: head.ch - increment })
    return found ? { line: found.line, ch: found.ch + increment } : null
  })

  // Space f / Space F とローマ字 2 キーで、かなに跳ぶ。normal / visual / 操作待ち（d Space f t a など）。
  // 表にない綴り（yi など）は、2 キー目も受けて何もしない（2 キー目が a・i などのコマンドにならないように）。
  // 割り当ては後に足したものが先に選ばれるので、何もしない割り当てを先に足す
  Vim.defineMotion('canvcodeNoMotion', () => null)
  for (const first of new Set(Object.keys(KANA_OF_ROMAJI).map((romaji) => romaji[0]))) {
    for (const leader of ['<Space>f', '<Space>F']) Vim.mapCommand(`${leader}${first}<character>`, 'motion', 'canvcodeNoMotion', {}, {})
  }
  for (const [romaji, kana] of Object.entries(KANA_OF_ROMAJI)) {
    Vim.mapCommand(`<Space>f${romaji}`, 'motion', 'moveToCharacter', { forward: true, inclusive: true, selectedCharacter: kana }, {})
    Vim.mapCommand(`<Space>F${romaji}`, 'motion', 'moveToCharacter', { forward: false, selectedCharacter: kana }, {})
  }

  // w・e・b・ge（W・E・B・gE も同じ動作を通るが、区切りは元のまま）。
  // 名前を変えないので、cw が語の後ろの空白を消さないこと（codemirror-vim の change）も元のまま効く
  Vim.defineMotion('moveByWords', (cm, head, args) => moveToWord(cm, head, args.repeat, !!args.forward, !!args.wordEnd, !!args.bigWord))

  // iw / aw。ほかのテキストオブジェクト（iW・i( など）は元の動作のまま
  Vim.defineMotion('canvcodeWordObject', (cm, head, args, vim) => {
    const inclusive = !args.textObjectInner
    let range: { start: Pos; end: Pos } | null = null
    for (let i = 0; i < (args.repeat || 1); i++) {
      const next = expandWordUnderCursor(cm, range ? range.end : head, inclusive)
      if (!next) continue
      if (range) range.end = next.end
      else range = next
    }
    if (!range) return null
    return vim.visualMode ? expandSelection(cm, vim, range.start, range.end) : [range.start, range.end]
  })
  for (const context of ['operatorPending', 'visual']) {
    Vim.mapCommand('iw', 'motion', 'canvcodeWordObject', { textObjectInner: true }, { context })
    Vim.mapCommand('aw', 'motion', 'canvcodeWordObject', {}, { context })
  }
}
