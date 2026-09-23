import type { NodeRecord } from '@canvcode/core'
import type { CanvasView, Editor } from '@canvcode/canvas'
import { stepFontSize, type NoteProps, type TextAlign, type TextProps } from '@canvcode/nodes'

// テキストと付箋の文字の大きさ・揃えを変える（MAI-50、MAI-52）。
// 左端のパレットとパイメニュー「操作」（MAI-57）の両方から同じ手順で変えるので、ここにまとめる

export type TextStyleProps = TextProps | NoteProps
export type TextStylePatch = Partial<{ fontSize: number; align: TextAlign }> | ((props: TextStyleProps) => Partial<TextStyleProps>)

// 選んでいるノードのうち、テキストと付箋
export function selectedTextNodes(editor: Editor): NodeRecord[] {
  return [...editor.session.get().selectedIds].flatMap((id) => {
    const node = editor.getNode(id)
    return node?.type === 'text' || node?.type === 'note' ? [node] : []
  })
}

// nodes（テキストか付箋）の props を patch で変える。
// 画面を描いたあとで変わっている（編集中の文字など）ことがあるので、今の値を読み直して変える。
// 編集中は編集のトランザクションが開いたままで、新しいトランザクションを開けない（MAI-52）。
// 編集中のノード（編集中は、選んでいるのはそのノードだけ）は、編集の中で変える
export function applyTextStyle(editor: Editor, view: CanvasView | null, nodes: readonly NodeRecord[], patch: TextStylePatch): void {
  const apply = (node: NodeRecord): NodeRecord => {
    const props = node.props as TextStyleProps
    return { ...node, props: { ...props, ...(typeof patch === 'function' ? patch(props) : patch) } }
  }
  if (view?.textEditor.editingId && view.textEditor.updateNode(apply)) return
  editor.transact('text style', (tx) => {
    for (const { id } of nodes) {
      const node = editor.getNode(id)
      if (node) tx.put(apply(node))
    }
  })
}

// 文字を 1 段階大きく（direction = 1）・小さく（-1）する
export function stepTextFontSize(editor: Editor, view: CanvasView | null, nodes: readonly NodeRecord[], direction: 1 | -1): void {
  applyTextStyle(editor, view, nodes, (props) => ({ fontSize: stepFontSize(props.fontSize, direction) }))
}

// 揃えを変える
export function setTextAlign(editor: Editor, view: CanvasView | null, nodes: readonly NodeRecord[], align: TextAlign): void {
  applyTextStyle(editor, view, nodes, { align })
}
