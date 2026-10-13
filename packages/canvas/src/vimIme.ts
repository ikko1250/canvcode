import { Prec, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'
import { getCM } from '@replit/codemirror-vim'

// vim の通常モード（visual・操作待ちも）で、日本語入力が ON のまま打ったキーを vim のコマンドとして扱う。
// macOS の Chrome / Safari では、IME が ON のときのキーは key: 'i'・keyCode: 229 で届き、そのあと IME が変換を始める。
// codemirror-vim は key: 'Process' のときしか IME のキーと見ないので、i で挿入モードに入ったあと「い」が本文に入ってしまう。
// ここでは、キーを vim に渡したうえで、続けて IME が入れようとする文字を捨て、変換を終わらせる。
// 挿入モードでは何もしない（日本語をそのまま打てる）

type ImeKeyEvent = Pick<KeyboardEvent, 'key' | 'code' | 'keyCode' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>

// IME を通ったキーを、vim に渡すキー（1 文字）にする。IME のキーでない・決められないなら null
export function vimKeyOfImeEvent(event: ImeKeyEvent): string | null {
  if (event.keyCode !== 229 && event.key !== 'Process') return null
  // 修飾キー付き（Ctrl+[ など）は、codemirror-vim にそのまま任せる
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  if ([...event.key].length === 1) {
    // 全角の英数字・記号（「ｉ」「：」）は半角にする
    const key = event.key.normalize('NFKC')
    return /^[\x20-\x7e]$/.test(key) ? key : null
  }
  // key が 'Process' のとき（Windows・Linux など）は、キーの位置から決める。決まるのは英字と数字だけ
  const letter = /^Key([A-Z])$/.exec(event.code)
  if (letter) return event.shiftKey ? letter[1] : letter[1].toLowerCase()
  const digit = /^Digit([0-9])$/.exec(event.code)
  if (digit && !event.shiftKey) return digit[1]
  return null
}

// codemirror-vim の中の ViewPlugin。キーを渡す入り口（handleKey）だけを使う
interface VimPlugin {
  handleKey(event: { key: string; preventDefault(): void; stopPropagation(): void }): boolean | undefined
}

// vim に渡したキーのあとで、IME が入れようとする文字を捨てるエディタ
const swallowing = new WeakSet<EditorView>()

export function vimImeExtension(): Extension {
  return Prec.highest([
    // 日本語入力の変換中のキー（確定の Enter、取り消しの Esc など）は vim に渡さず、IME に任せる
    EditorView.domEventHandlers({ keydown: (event, view) => event.isComposing || view.composing }),
    // CodeMirror は（Safari では）変換を終えた直後のキーを捨てるので、CodeMirror より前に受ける
    ViewPlugin.define((view) => {
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.isComposing || view.composing) return
        // 新しいキーを押したら、前のキーの分の「捨てる」は終わり（IME が文字を入れてこなかったとき）
        swallowing.delete(view)
        const cm = getCM(view)
        const vim = cm?.state.vim
        if (!cm || !vim || vim.insertMode) return
        const key = vimKeyOfImeEvent(event)
        if (key === null) return
        const plugin = (cm.state as { vimPlugin?: VimPlugin }).vimPlugin
        if (!plugin) return
        swallowing.add(view)
        event.preventDefault()
        event.stopImmediatePropagation()
        plugin.handleKey({ key, preventDefault() {}, stopPropagation() {} })
      }
      view.contentDOM.addEventListener('keydown', onKeyDown, true)
      return { destroy: () => view.contentDOM.removeEventListener('keydown', onKeyDown, true) }
    }),
    EditorView.inputHandler.of((view) => {
      if (!swallowing.has(view)) return false
      swallowing.delete(view)
      forceEndComposition(view)
      return true
    }),
  ])
}

// IME の変換を終わらせる（codemirror-vim の forceEndComposition と同じ）。
// 本文の要素を外して付け直すと、ブラウザは変換を取り消す。選択とフォーカスを戻し、CodeMirror に変換の終わりを知らせる
function forceEndComposition(view: EditorView): void {
  const parent = view.scrollDOM.parentElement
  if (!parent) return
  const sibling = view.scrollDOM.nextSibling
  const selection = window.getSelection()
  const saved = selection && {
    anchorNode: selection.anchorNode,
    anchorOffset: selection.anchorOffset,
    focusNode: selection.focusNode,
    focusOffset: selection.focusOffset,
  }
  view.scrollDOM.remove()
  parent.insertBefore(view.scrollDOM, sibling)
  try {
    if (saved && selection && saved.anchorNode) {
      selection.setPosition(saved.anchorNode, saved.anchorOffset)
      if (saved.focusNode) selection.extend(saved.focusNode, saved.focusOffset)
    }
  } catch (error) {
    console.error(error)
  }
  view.focus()
  view.contentDOM.dispatchEvent(new CustomEvent('compositionend'))
}
