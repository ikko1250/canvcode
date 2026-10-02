import type { NodeRecord } from '@canvcode/core'
import type { CanvasView, Editor } from '@canvcode/canvas'
import { hasRichText, mapRunFormats, richTextTargetOf, stepFontSize, type RichTextTarget, type TextAlign } from '@canvcode/nodes'

// テキスト・付箋・図形の中の文字の大きさ・揃えを変える（MAI-50、MAI-52）。パイメニュー「操作」（MAI-57）から変える。
// 型ごとの props のキーは richTextTargetOf（図形は labelFontSize など）

export type TextStylePatch = (props: object, target: RichTextTarget) => object

// 選んでいるノードのうち、文字を持つもの（テキスト・付箋・図形）
export function selectedTextNodes(editor: Editor): NodeRecord[] {
  return [...editor.session.get().selectedIds].flatMap((id) => {
    const node = editor.getNode(id)
    return node && hasRichText(node) ? [node] : []
  })
}

// nodes（文字を持つノード）の props を patch で変える。
// 画面を描いたあとで変わっている（編集中の文字など）ことがあるので、今の値を読み直して変える。
// 編集中は編集のトランザクションが開いたままで、新しいトランザクションを開けない（MAI-52）。
// 編集中のノード（編集中は、選んでいるのはそのノードだけ）は、編集の中で変える
export function applyTextStyle(editor: Editor, view: CanvasView | null, nodes: readonly NodeRecord[], patch: TextStylePatch): void {
  const apply = (node: NodeRecord): NodeRecord => {
    const target = richTextTargetOf(node)
    return target ? { ...node, props: patch(node.props as object, target) } : node
  }
  if (view?.textEditor.editingId && view.textEditor.updateNode(apply)) return
  editor.transact('text style', (tx) => {
    for (const { id } of nodes) {
      const node = editor.getNode(id)
      if (node) tx.put(apply(node))
    }
  })
}

// 文字を 1 段階大きく（direction = 1）・小さく（-1）する。
// 範囲ごとに大きさを変えた文字（MAI-74）も、それぞれ 1 段階ずつ変える（大きさの違いを残す）
export function stepTextFontSize(editor: Editor, view: CanvasView | null, nodes: readonly NodeRecord[], direction: 1 | -1): void {
  applyTextStyle(editor, view, nodes, (props, target) => {
    const fontSize = stepFontSize(target.style(props).fontSize, direction)
    const paragraphs = mapRunFormats(
      target.paragraphs(props),
      (format) => (format?.fontSize === undefined ? format : { ...format, fontSize: stepFontSize(format.fontSize, direction) }),
      { fontSize },
    )
    return target.withParagraphs({ ...props, [target.keys.fontSize!]: fontSize }, paragraphs)
  })
}

// 揃えを変える
export function setTextAlign(editor: Editor, view: CanvasView | null, nodes: readonly NodeRecord[], align: TextAlign): void {
  applyTextStyle(editor, view, nodes, (props, target) => ({ ...props, [target.keys.align]: align }))
}
