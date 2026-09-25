// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Vim, getCM } from '@replit/codemirror-vim'
import { createCodeEditor, type CodeEditorHandle } from './codeEditor.ts'
import { vimModeOf, type VimMode } from './vimKeymap.ts'

// vim モードのキーの割り当て（MAI-60 の段階 1）。jsdom の上で CodeMirror を動かし、キーを vim に渡して確かめる。
// jsdom は文字の位置を計れないので、CodeMirror が計るところだけ空の値を返す。
// 上下の移動（n / s）は画面の上の位置で決まるので、ここでは確かめない（Playwright で確かめる。tests/e2e/file-editor-vim.spec.ts）
Range.prototype.getClientRects = () => [] as unknown as DOMRectList
Range.prototype.getBoundingClientRect = () => new DOMRect()

const editors: CodeEditorHandle[] = []

function open(doc: string, options: { onEscape?(): void; onModEnter?(): void; onVimModeChange?(mode: VimMode | null): void } = {}) {
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
