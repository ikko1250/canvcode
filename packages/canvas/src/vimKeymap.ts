import type { EditorView } from '@codemirror/view'
import { Vim, getCM } from '@replit/codemirror-vim'

// 全画面エディタの vim モードのキーの割り当て（MAI-60 の段階 1）。
// 元の ~/.config/nvim/init.lua の表と対応が分かるように、表と同じ順に並べる。
// Vim の割り当ては全部のエディタで共通（codemirror-vim の作り）なので、最初に vim を使うときに一度だけ登録する。
// :w や :q で何をするかはエディタごとに違うので、エディタ（EditorView）ごとに handlers を覚えておく

export interface VimHandlers {
  // 待たずに保存する（:w）
  save(): void
  // 閉じる（:q、Space x）
  close(): void
}

const handlers = new WeakMap<EditorView, VimHandlers>()

export function setVimHandlers(view: EditorView, value: VimHandlers | null): void {
  if (value) handlers.set(view, value)
  else handlers.delete(view)
}

function handlersOf(cm: { cm6: EditorView }): VimHandlers | undefined {
  return handlers.get(cm.cm6)
}

// いまの vim のモード。vim がオフなら null
export type VimMode = 'normal' | 'insert' | 'visual' | 'visual line' | 'visual block' | 'replace'

export function vimModeOf(view: EditorView): VimMode | null {
  const vim = getCM(view)?.state.vim
  if (!vim) return null
  if (vim.insertMode) return vim.mode === 'replace' ? 'replace' : 'insert'
  if (vim.visualMode) return vim.visualBlock ? 'visual block' : vim.visualLine ? 'visual line' : 'visual'
  return 'normal'
}

// 文脈を付けない割り当て（normal / visual / 操作待ち。挿入モードは含まない）。型は string だが、undefined を渡す
const ANY_MODE = undefined as unknown as string

let registered = false

export function registerVimKeymap(): void {
  if (registered) return
  registered = true

  // Space は元々「右へ」（l）。Space n などを待てるように、元の割り当てを外す。
  // codemirror-vim は、元の割り当てを外すと noremap で探す範囲が 1 つずれ、最初に足した割り当てまで見てしまう。
  // noremap の右辺に出てこない、何もしない割り当てを最初に足して、ずれた分を受ける
  Vim.unmap('<Space>', ANY_MODE)
  Vim.noremap('<CanvcodeUnmapGuard>', '', 'normal')

  // 移動（変則大西配列：JKL; の位置を方向キーとして使う）。normal / visual / 操作待ち
  Vim.noremap('t', 'h', ANY_MODE)
  Vim.noremap('n', 'k', ANY_MODE)
  Vim.noremap('s', 'j', ANY_MODE)
  Vim.noremap('h', 'l', ANY_MODE)
  Vim.noremap('w', 'b', ANY_MODE)
  Vim.noremap('b', 'w', ANY_MODE)
  Vim.noremap('W', 'B', ANY_MODE)
  Vim.noremap('B', 'W', ANY_MODE)

  // 移動キーと重なった元の機能の移動先（normal / visual）。noremap なので、右辺は元の t / n / s を指す
  for (const context of ['normal', 'visual']) {
    Vim.noremap('<Space>t', 't', context)
    Vim.noremap('<Space>T', 'T', context)
    Vim.noremap('<Space>n', 'n', context)
    Vim.noremap('<Space>N', 'N', context)
    Vim.noremap('<Space>s', 's', context)
    Vim.noremap('<Space>S', 'S', context)
  }

  // バッファを閉じる → 全画面エディタを閉じる
  Vim.defineAction('canvcodeClose', (cm) => handlersOf(cm)?.close())
  Vim.mapCommand('<Space>x', 'action', 'canvcodeClose', {}, { context: 'normal' })
  // ZZ（保存して閉じる）
  Vim.defineAction('canvcodeSaveAndClose', (cm) => {
    const found = handlersOf(cm)
    found?.save()
    found?.close()
  })
  Vim.mapCommand('ZZ', 'action', 'canvcodeSaveAndClose', {}, { context: 'normal' })

  // 選択範囲のインデントを増やす・減らす（選択は保つ）
  Vim.noremap('<Tab>', '>gv', 'visual')
  Vim.noremap('<S-Tab>', '<gv', 'visual')

  // ex コマンド。:w はすぐ保存、:q は閉じる、:wq は保存して閉じる
  Vim.defineEx('write', 'w', (cm) => handlersOf(cm)?.save())
  Vim.defineEx('quit', 'q', (cm) => handlersOf(cm)?.close())
  Vim.defineEx('wq', 'wq', (cm) => {
    const found = handlersOf(cm)
    found?.save()
    found?.close()
  })
}
