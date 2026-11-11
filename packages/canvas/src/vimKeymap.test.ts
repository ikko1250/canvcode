// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Vim, getCM } from '@replit/codemirror-vim'
import { createCodeEditor, type CodeEditorHandle, type CodeEditorOptions } from './codeEditor.ts'
import { vimModeOf, type VimMode } from './vimKeymap.ts'
import { vimKeyOfImeEvent } from './vimIme.ts'
import { characterCandidates, KANA_OF_ROMAJI } from './vimJapanese.ts'
import { EditorView } from '@codemirror/view'

// vim モードのキーの割り当て（MAI-60 の段階 1）。jsdom の上で CodeMirror を動かし、キーを vim に渡して確かめる。
// jsdom は文字の位置を計れないので、CodeMirror が計るところだけ空の値を返す。
// 上下の移動（n / s）は画面の上の位置で決まるので、ここでは確かめない（Playwright で確かめる。tests/e2e/file-editor-vim.spec.ts）
Range.prototype.getClientRects = () => [] as unknown as DOMRectList
Range.prototype.getBoundingClientRect = () => new DOMRect()

const editors: CodeEditorHandle[] = []

function open(
  doc: string,
  options: { language?: CodeEditorOptions['language']; onEscape?(): void; onModEnter?(): void; onVimModeChange?(mode: VimMode | null): void } = {},
) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const save = vi.fn()
  const close = vi.fn()
  const editor = createCodeEditor({ parent, doc, language: null, onChange() {}, vim: true, vimCommands: { save, close }, ...options })
  editors.push(editor)
  return { editor, save, close }
}

// '<Space>n' のような名前と、1 文字ずつのキーに分けて vim に渡す
function press(editor: CodeEditorHandle, keys: string) {
  const cm = getCM(editor.view)!
  for (const key of keys.match(/<[^>]+>|./g) ?? []) Vim.handleKey(cm, key, 'user')
}

// 挿入モードで文字を打つ（挿入モードの文字は vim が扱わず、CodeMirror が入れる）
function type(editor: CodeEditorHandle, text: string) {
  editor.view.dispatch({ ...editor.view.state.replaceSelection(text), userEvent: 'input.type' })
}

function head(editor: CodeEditorHandle) {
  return editor.view.state.selection.main.head
}

function keydown(editor: CodeEditorHandle, init: KeyboardEventInit) {
  editor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  document.body.textContent = ''
})

describe('vim モードの移動（t n s h）', () => {
  it('t / h で左・右に動く', () => {
    const { editor } = open('abcd')
    press(editor, 'hh')
    expect(head(editor)).toBe(2)
    press(editor, 't')
    expect(head(editor)).toBe(1)
  })

  it('w と b、W と B が入れ替わっている', () => {
    const { editor } = open('one two.three four')
    press(editor, 'b')
    expect(head(editor)).toBe(4)
    press(editor, 'b')
    expect(head(editor)).toBe(7)
    press(editor, 'w')
    expect(head(editor)).toBe(4)
    press(editor, 'B')
    expect(head(editor)).toBe(14)
    press(editor, 'W')
    expect(head(editor)).toBe(4)
  })

  it('操作待ちでも割り当てが効く（dh は元の dl、db は元の dw）', () => {
    const { editor } = open('abc def ghi')
    press(editor, 'dh')
    expect(editor.text()).toBe('bc def ghi')
    press(editor, 'db')
    expect(editor.text()).toBe('def ghi')
  })

  it('visual モードでも割り当てが効く', () => {
    const { editor } = open('abcdef')
    press(editor, 'vhhd')
    expect(editor.text()).toBe('def')
  })

  it('割り当てが連鎖しない（s は下へ動くだけで、元の s の置換にならない）', () => {
    const { editor } = open('ab\ncd')
    press(editor, 's')
    expect(vimModeOf(editor.view)).toBe('normal')
    expect(editor.text()).toBe('ab\ncd')
  })

  it('f や r のあとの文字は割り当てない', () => {
    const { editor } = open('xxsxx')
    press(editor, 'fs')
    expect(head(editor)).toBe(2)
    press(editor, 'rt')
    expect(editor.text()).toBe('xxtxx')
  })
})

describe('Space で元の機能を使う', () => {
  it('Space t / Space T は元の till', () => {
    const { editor } = open('abc;def;ghi')
    press(editor, '<Space>t;')
    expect(head(editor)).toBe(2)
    press(editor, '$<Space>T;')
    expect(head(editor)).toBe(8)
  })

  it('Space n / Space N は元の検索結果の次・前', () => {
    const { editor } = open('foo x foo y foo')
    // * でカーソルの下の語を探す（次の foo へ動く）
    press(editor, '*')
    expect(head(editor)).toBe(6)
    press(editor, '<Space>n')
    expect(head(editor)).toBe(12)
    press(editor, '<Space>N')
    expect(head(editor)).toBe(6)
  })

  it('Space s は 1 文字置換、Space S は行全体の置換', () => {
    const { editor } = open('abc\ndef')
    press(editor, '<Space>s')
    expect(vimModeOf(editor.view)).toBe('insert')
    expect(editor.text()).toBe('bc\ndef')
    press(editor, '<Esc>s<Space>S')
    expect(vimModeOf(editor.view)).toBe('insert')
    expect(editor.text()).toBe('bc\n')
  })

  it('Space だけでは右へ動かない（Space n などを待つ）', () => {
    const { editor } = open('abc')
    press(editor, '<Space>')
    expect(head(editor)).toBe(0)
  })

  it('Space x は閉じる', () => {
    const { editor, save, close } = open('abc')
    press(editor, '<Space>x')
    expect(close).toHaveBeenCalledTimes(1)
    expect(save).not.toHaveBeenCalled()
  })

  it('ZZ は保存して閉じる', () => {
    const { editor, save, close } = open('abc')
    press(editor, 'ZZ')
    expect(save).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('visual モードの Tab / Shift-Tab', () => {
  it('選んだ行のインデントを増やし・減らし、選択を保つ', () => {
    const { editor } = open('a\nb')
    press(editor, 'VG<Tab>')
    expect(editor.text()).toBe('  a\n  b')
    expect(vimModeOf(editor.view)).toBe('visual line')
    press(editor, '<Tab>')
    expect(editor.text()).toBe('    a\n    b')
    press(editor, '<S-Tab>')
    expect(editor.text()).toBe('  a\n  b')
    // 2 行とも選んだまま
    const { from, to } = editor.view.state.selection.main
    expect(editor.view.state.doc.lineAt(from).number).toBe(1)
    expect(editor.view.state.doc.lineAt(to).number).toBe(2)
    expect(vimModeOf(editor.view)).toBe('visual line')
  })
})

describe('o で箇条書きを続ける（MAI-71）', () => {
  function openMarkdown(doc: string) {
    return open(doc, { language: 'markdown' }).editor
  }

  it('箇条書きの行では、次の行に記号を付けて挿入モードに入る', () => {
    const editor = openMarkdown('- a')
    press(editor, 'o')
    expect(editor.text()).toBe('- a\n- ')
    expect(vimModeOf(editor.view)).toBe('insert')
    expect(head(editor)).toBe(editor.text().length)
  })

  it('行の途中にカーソルがあっても、行の終わりから続ける', () => {
    const editor = openMarkdown('- abc\nx')
    press(editor, 'o')
    expect(editor.text()).toBe('- abc\n- \nx')
    expect(head(editor)).toBe(8)
  })

  it('番号付きの箇条書きは次の番号を付け、後ろの番号を振り直す', () => {
    const editor = openMarkdown('1. a\n2. b')
    press(editor, 'o')
    expect(editor.text()).toBe('1. a\n2. \n3. b')
    expect(head(editor)).toBe(8)
  })

  it('チェックボックスは空のチェックボックスで続ける', () => {
    const editor = openMarkdown('- [x] a')
    press(editor, 'o')
    expect(editor.text()).toBe('- [x] a\n- [ ] ')
  })

  it('引用は > で続ける', () => {
    const editor = openMarkdown('> a')
    press(editor, 'o')
    expect(editor.text()).toBe('> a\n> ')
  })

  it('箇条書きでない行・Markdown でないとき・中身が空の項目は、元の o と同じ', () => {
    const plain = openMarkdown('  a')
    press(plain, 'o')
    expect(plain.text()).toBe('  a\n  ')
    const code = open('- a', { language: 'python' }).editor
    press(code, 'o')
    expect(code.text()).toBe('- a\n')
    const empty = openMarkdown('- a\n- ')
    press(empty, 'Go')
    expect(empty.text()).toBe('- a\n- \n')
    expect(vimModeOf(empty.view)).toBe('insert')
  })

  it('Undo は元の o と同じ（打った文字、続けた記号の順に戻す）。. で繰り返せる', () => {
    // 元の o も、打った文字と改行を別々に戻す（codemirror-vim の作り）
    const plain = openMarkdown('a')
    press(plain, 'o')
    type(plain, 'b')
    press(plain, '<Esc>u')
    expect(plain.text()).toBe('a\n')
    press(plain, 'u')
    expect(plain.text()).toBe('a')

    const editor = openMarkdown('- a')
    press(editor, 'o<Esc>u')
    expect(editor.text()).toBe('- a')
    press(editor, 'o')
    type(editor, 'b')
    press(editor, '<Esc>u')
    expect(editor.text()).toBe('- a\n- ')
    press(editor, 'u')
    expect(editor.text()).toBe('- a')
    press(editor, 'o')
    type(editor, 'b')
    press(editor, '<Esc>.')
    expect(editor.text()).toBe('- a\n- b\n- b')
  })

  it('回数付き（3o）は元の o と同じ', () => {
    const editor = openMarkdown('- a')
    press(editor, '3o')
    type(editor, 'b')
    press(editor, '<Esc>')
    expect(editor.text()).toBe('- a\nb\nb\nb')
  })
})

describe('ex コマンド', () => {
  it(':w は保存、:q は閉じる、:wq は保存して閉じる', () => {
    const { editor, save, close } = open('abc')
    const cm = getCM(editor.view) as Parameters<typeof Vim.handleEx>[0]
    Vim.handleEx(cm, 'w')
    expect(save).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
    Vim.handleEx(cm, 'write')
    expect(save).toHaveBeenCalledTimes(2)
    Vim.handleEx(cm, 'q')
    expect(close).toHaveBeenCalledTimes(1)
    Vim.handleEx(cm, 'wq')
    expect(save).toHaveBeenCalledTimes(3)
    expect(close).toHaveBeenCalledTimes(2)
  })
})

describe('閉じるキーとモード', () => {
  it('vim モードの Esc は vim に渡し、閉じない', () => {
    const onEscape = vi.fn()
    const { editor } = open('abc', { onEscape })
    press(editor, 'i')
    expect(vimModeOf(editor.view)).toBe('insert')
    keydown(editor, { key: 'Escape' })
    expect(vimModeOf(editor.view)).toBe('normal')
    keydown(editor, { key: 'Escape' })
    expect(onEscape).not.toHaveBeenCalled()
  })

  it('Ctrl+Enter で閉じるのはノーマルモードのときだけ。挿入モードでは改行する', () => {
    const onModEnter = vi.fn()
    const { editor } = open('abc', { onModEnter })
    press(editor, 'A')
    keydown(editor, { key: 'Enter', ctrlKey: true })
    expect(onModEnter).not.toHaveBeenCalled()
    expect(editor.text()).toBe('abc\n')
    press(editor, '<Esc>v')
    keydown(editor, { key: 'Enter', ctrlKey: true })
    expect(onModEnter).not.toHaveBeenCalled()
    press(editor, '<Esc>')
    keydown(editor, { key: 'Enter', ctrlKey: true })
    expect(onModEnter).toHaveBeenCalledTimes(1)
  })

  it('日本語入力の変換中のキーは vim に渡さない', () => {
    const { editor } = open('abc')
    keydown(editor, { key: 'h', isComposing: true })
    expect(head(editor)).toBe(0)
    keydown(editor, { key: 'h' })
    expect(head(editor)).toBe(1)
  })

  it('モードの変化を知らせ、オフにすると null になる', () => {
    const modes: (VimMode | null)[] = []
    const { editor } = open('abc', { onVimModeChange: (mode) => modes.push(mode) })
    press(editor, 'i<Esc>vV<Esc>')
    editor.setVim(false)
    expect(getCM(editor.view)).toBeNull()
    editor.setVim(true)
    expect(modes.slice(0, 5)).toEqual(['normal', 'insert', 'normal', 'visual', 'visual line'])
    expect(modes.slice(-3)).toEqual(['normal', null, 'normal'])
  })

  it('vim をオフにすると、Esc で onEscape を呼ぶ（作り直さずに切り替える）', () => {
    const onEscape = vi.fn()
    const { editor } = open('abc', { onEscape })
    const view = editor.view
    editor.setVim(false)
    keydown(editor, { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)
    expect(editor.view).toBe(view)
  })
})

describe('日本語入力が ON のままの通常モード', () => {
  // IME が文字を入れようとしたときに CodeMirror が呼ぶ inputHandler を、同じ順に呼ぶ（true を返したものがあれば入れない）
  function imeInput(editor: CodeEditorHandle, text: string) {
    const view = editor.view
    const { from, to } = view.state.selection.main
    const handled = view.state.facet(EditorView.inputHandler).some((handler) => handler(view, from, to, text, () => view.state.update({ changes: { from, to, insert: text } })))
    if (!handled) view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: 'input.type' })
  }

  it('IME を通ったキーを vim のキーにする', () => {
    const base = { code: '', keyCode: 229, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false }
    expect(vimKeyOfImeEvent({ ...base, key: 'i' })).toBe('i')
    expect(vimKeyOfImeEvent({ ...base, key: 'I', shiftKey: true })).toBe('I')
    expect(vimKeyOfImeEvent({ ...base, key: '：' })).toBe(':')
    expect(vimKeyOfImeEvent({ ...base, key: 'Process', code: 'KeyI', shiftKey: true })).toBe('I')
    expect(vimKeyOfImeEvent({ ...base, key: 'Process', code: 'Digit3' })).toBe('3')
    expect(vimKeyOfImeEvent({ ...base, key: 'Process', code: 'Semicolon' })).toBeNull()
    expect(vimKeyOfImeEvent({ ...base, key: 'い' })).toBeNull()
    expect(vimKeyOfImeEvent({ ...base, key: 'i', ctrlKey: true })).toBeNull()
    // IME を通っていないキーは、codemirror-vim がそのまま扱う
    expect(vimKeyOfImeEvent({ ...base, key: 'i', keyCode: 73 })).toBeNull()
  })

  it('I で挿入モードに入り、IME が入れようとした「い」は入れない', () => {
    const { editor } = open('  abc')
    press(editor, '$')
    keydown(editor, { key: 'I', code: 'KeyI', keyCode: 229, shiftKey: true })
    expect(vimModeOf(editor.view)).toBe('insert')
    expect(head(editor)).toBe(2)
    imeInput(editor, 'い')
    expect(editor.text()).toBe('  abc')
    // 挿入モードに入ったあとの日本語は、そのまま入る
    imeInput(editor, 'あ')
    expect(editor.text()).toBe('  あabc')
  })

  it('Space と、記号のキーで入る全角の文字も vim のキーにする（MAI-96）', () => {
    const base = { code: '', keyCode: 229, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false }
    expect(vimKeyOfImeEvent({ ...base, key: ' ' })).toBe(' ')
    expect(vimKeyOfImeEvent({ ...base, key: '　' })).toBe(' ')
    expect(vimKeyOfImeEvent({ ...base, key: 'Process', code: 'Space' })).toBe(' ')
    expect(vimKeyOfImeEvent({ ...base, key: '、' })).toBe(',')
    expect(vimKeyOfImeEvent({ ...base, key: '。' })).toBe('.')
    expect(vimKeyOfImeEvent({ ...base, key: '「' })).toBe('[')
  })

  it('IME が ON のままでも、Space f とローマ字でかなに跳ぶ。f のあとの「、」は , と同じ（MAI-96）', () => {
    const { editor } = open('あいうえおかきたち、つ')
    const keys: [string, string][] = [[' ', 'Space'], ['f', 'KeyF'], ['t', 'KeyT'], ['a', 'KeyA']]
    for (const [key, code] of keys) {
      keydown(editor, { key, code, keyCode: 229 })
      imeInput(editor, key === ' ' ? '　' : key)
    }
    expect(head(editor)).toBe(7)
    expect(vimModeOf(editor.view)).toBe('normal')
    for (const [key, code] of [['f', 'KeyF'], ['、', 'Comma']]) {
      keydown(editor, { key, code, keyCode: 229 })
      imeInput(editor, key)
    }
    expect(head(editor)).toBe(9)
    expect(editor.text()).toBe('あいうえおかきたち、つ')
  })

  it('IME が ON のままでも、dd などのコマンドが効く', () => {
    const { editor } = open('one\ntwo')
    for (const key of ['d', 'd']) {
      keydown(editor, { key, code: 'KeyD', keyCode: 229 })
      imeInput(editor, 'ｄ')
    }
    expect(editor.text()).toBe('two')
    expect(vimModeOf(editor.view)).toBe('normal')
  })
})

describe('f で全角の記号にも跳ぶ（MAI-96）', () => {
  it('記号の候補に全角の記号を入れる。英数字・かなはそのまま', () => {
    expect(characterCandidates(',')).toEqual([',', '，', '、'])
    expect(characterCandidates('.')).toEqual(['.', '．', '。'])
    expect(characterCandidates('[')).toEqual(['[', '［', '「', '『', '【', '〔'])
    expect(characterCandidates(']')).toEqual([']', '］', '」', '』', '】', '〕'])
    for (const [half, wide] of ['(（', ')）', '!！', '?？', ':：', ';；', '-ー', '/・', '~〜']) {
      expect(characterCandidates(half)).toContain(wide)
    }
    expect(characterCandidates(' ')).toEqual([' ', '　'])
    expect(characterCandidates('t')).toEqual(['t'])
    expect(characterCandidates('1')).toEqual(['1'])
  })

  it('f, は , 、 ， のうち一番近いものへ跳び、; と , でも同じ候補を使う', () => {
    const { editor } = open('ab、c,d，e、f')
    press(editor, 'f,')
    expect(head(editor)).toBe(2)
    press(editor, ';')
    expect(head(editor)).toBe(4)
    press(editor, ';')
    expect(head(editor)).toBe(6)
    press(editor, ';')
    expect(head(editor)).toBe(8)
    press(editor, ',')
    expect(head(editor)).toBe(6)
    press(editor, '$F,')
    expect(head(editor)).toBe(8)
  })

  it('f. は 。．、f[ は 「『［、f( は （ にも跳ぶ', () => {
    const { editor } = open('あ。い．う「え『お［か（き')
    press(editor, 'f.')
    expect(head(editor)).toBe(1)
    press(editor, 'f.')
    expect(head(editor)).toBe(3)
    press(editor, 'f[')
    expect(head(editor)).toBe(5)
    press(editor, '2f[')
    expect(head(editor)).toBe(9)
    press(editor, 'f(')
    expect(head(editor)).toBe(11)
  })

  it('英字は今までどおり 1 キーで跳ぶ（ft で t へ、fta で t に跳んで追記）', () => {
    const { editor } = open('xxtxx')
    press(editor, 'ft')
    expect(head(editor)).toBe(2)
    press(editor, '0fta')
    expect(vimModeOf(editor.view)).toBe('insert')
    expect(head(editor)).toBe(3)
  })

  it('操作待ちと till（Space t）でも全角の記号を探す', () => {
    const { editor } = open('はい、そう')
    press(editor, 'df,')
    expect(editor.text()).toBe('そう')
    // 見つからなければ、操作もしない（カーソルの文字を消さない）
    press(editor, 'df,')
    expect(editor.text()).toBe('そう')
    const till = open('はい、そう').editor
    press(till, '<Space>t,')
    expect(head(till)).toBe(1)
  })
})

describe('Space f とローマ字でかなに跳ぶ（MAI-96）', () => {
  it('ローマ字の表：母音は 2 回、si・ti・tu・hu、ん は nn、濁音・半濁音もある', () => {
    expect(KANA_OF_ROMAJI.aa).toBe('あ')
    expect(KANA_OF_ROMAJI.oo).toBe('お')
    expect(KANA_OF_ROMAJI.si).toBe('し')
    expect(KANA_OF_ROMAJI.ti).toBe('ち')
    expect(KANA_OF_ROMAJI.tu).toBe('つ')
    expect(KANA_OF_ROMAJI.hu).toBe('ふ')
    expect(KANA_OF_ROMAJI.nn).toBe('ん')
    expect(KANA_OF_ROMAJI.wo).toBe('を')
    expect(KANA_OF_ROMAJI.ga).toBe('が')
    expect(KANA_OF_ROMAJI.zi).toBe('じ')
    expect(KANA_OF_ROMAJI.pa).toBe('ぱ')
    expect(KANA_OF_ROMAJI.po).toBe('ぽ')
    // 2 キーで決まらない綴りは入れない
    expect(KANA_OF_ROMAJI.a).toBeUndefined()
    expect(KANA_OF_ROMAJI.n).toBeUndefined()
    expect(Object.keys(KANA_OF_ROMAJI).every((romaji) => romaji.length === 2)).toBe(true)
  })

  it('Space f t a で「た」へ、Space f a a で「あ」へ。カタカナも候補にする', () => {
    const { editor } = open('ここでタイプした。あア')
    press(editor, '<Space>fta')
    expect(head(editor)).toBe(3)
    press(editor, ';')
    expect(head(editor)).toBe(7)
    press(editor, ',')
    expect(head(editor)).toBe(3)
    press(editor, '<Space>faa')
    expect(head(editor)).toBe(9)
    press(editor, '<Space>faa')
    expect(head(editor)).toBe(10)
    expect(vimModeOf(editor.view)).toBe('normal')
    expect(editor.text()).toBe('ここでタイプした。あア')
  })

  it('Space F は前へ。濁音・半濁音・ん にも跳ぶ', () => {
    const { editor } = open('がっこうでパンをかう')
    press(editor, '$<Space>Fga')
    expect(head(editor)).toBe(0)
    press(editor, '<Space>fpa')
    expect(head(editor)).toBe(5)
    press(editor, '<Space>fnn')
    expect(head(editor)).toBe(6)
    press(editor, '<Space>Fde')
    expect(head(editor)).toBe(4)
  })

  it('操作待ち（d Space f）と visual でも使える', () => {
    const { editor } = open('あいうえお')
    press(editor, 'd<Space>fuu')
    expect(editor.text()).toBe('えお')
    const visual = open('かきくけこ').editor
    press(visual, 'v<Space>fkud')
    expect(visual.text()).toBe('けこ')
  })

  it('表にないローマ字は何もしない（2 キー目も受けて捨てる）', () => {
    const { editor } = open('あいう')
    press(editor, '<Space>fta')
    expect(head(editor)).toBe(0)
    press(editor, '<Space>fyi')
    expect(head(editor)).toBe(0)
    press(editor, 'd<Space>fka')
    expect(editor.text()).toBe('あいう')
    expect(vimModeOf(editor.view)).toBe('normal')
    press(editor, 'h')
    expect(head(editor)).toBe(1)
  })
})

describe('日本語の語の区切り（MAI-96）', () => {
  // w（この配列では b）を n 回押したときのカーソルの位置
  function wordStarts(editor: CodeEditorHandle, key: string, count: number) {
    const heads: number[] = []
    for (let i = 0; i < count; i++) {
      press(editor, key)
      heads.push(head(editor))
    }
    return heads
  }

  it('w（b のキー）は「日本語｜の｜単語」のように進む', () => {
    const { editor } = open('日本語の単語を移動する。次')
    expect(wordStarts(editor, 'b', 7)).toEqual([3, 4, 6, 7, 9, 11, 12])
  })

  it('b（w のキー）と e も同じ区切りで動く', () => {
    const { editor } = open('日本語の単語を移動する')
    press(editor, '$')
    expect(wordStarts(editor, 'w', 4)).toEqual([9, 7, 6, 4])
    press(editor, '0')
    expect(wordStarts(editor, 'e', 3)).toEqual([2, 3, 5])
    press(editor, '$ge')
    expect(head(editor)).toBe(8)
  })

  it('英字と日本語が続くところは区切る。英語・コードの区切りは今までと同じ', () => {
    const { editor } = open('CanvCodeの単語')
    expect(wordStarts(editor, 'b', 2)).toEqual([8, 9])
    const code = open('foo_bar.baz(qux1, 2) x').editor
    expect(wordStarts(code, 'b', 7)).toEqual([7, 8, 11, 12, 16, 18, 19])
  })

  it('W / B は今のまま（空白まで）', () => {
    const { editor } = open('日本語の単語、次の文 二つ目')
    press(editor, 'B')
    expect(head(editor)).toBe(11)
    press(editor, 'W')
    expect(head(editor)).toBe(0)
  })

  it('行をまたいでも区切る', () => {
    const { editor } = open('日本語\nの単語。')
    expect(wordStarts(editor, 'b', 3)).toEqual([4, 5, 7])
  })

  it('操作（dw・cw）も同じ区切り。cw は語の後ろの空白を残す', () => {
    const { editor } = open('日本語の単語')
    press(editor, 'db')
    expect(editor.text()).toBe('の単語')
    press(editor, 'cb')
    expect(vimModeOf(editor.view)).toBe('insert')
    expect(editor.text()).toBe('単語')
    const english = open('foo bar').editor
    press(english, 'cb')
    expect(english.text()).toBe(' bar')
  })

  it('visual でも同じ区切りで選ぶ', () => {
    const { editor } = open('日本語の単語')
    press(editor, 'vbd')
    expect(editor.text()).toBe('単語')
  })

  it('iw / aw も同じ区切り。英語の iw / aw は今までと同じ', () => {
    const { editor } = open('日本語の単語を移動')
    press(editor, 'hhhhdiw')
    expect(editor.text()).toBe('日本語のを移動')
    press(editor, 'daw')
    expect(editor.text()).toBe('日本語の移動')
    press(editor, '0viwd')
    expect(editor.text()).toBe('の移動')
    press(editor, 'h2diw')
    expect(editor.text()).toBe('の')
    const english = open('foo bar baz').editor
    press(english, 'bdaw')
    expect(english.text()).toBe('foo baz')
    press(english, 'ciw')
    expect(english.text()).toBe('foo ')
    expect(vimModeOf(english.view)).toBe('insert')
  })
})
