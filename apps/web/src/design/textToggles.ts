import type { NodeRecord } from '@canvcode/core'
import { editNodes, sharedOf, type Editor, type SharedValue, type TextEditor } from '@canvcode/canvas'
import { TEXT_TOGGLE_FORMATS, toggledValue, type TextToggleFormat } from '@canvcode/nodes'
import { TEXT_TOGGLE_FIELDS } from './sections.ts'

// 太字・斜体・下線・取り消し線（MAI-79）のボタンの表示と切り替え。デザインパネルと、編集中のツールバー（TextFormatToolbar）で共通。
// - 文字を編集中（そのノードだけを選んでいる）なら、Ctrl+B などと同じ TextEditor.toggleFormat で切り替える。
//   表示は、選んでいる範囲の文字の値（違えば混在）。範囲がなければ、カーソルの位置で次に打つ文字の書式
// - そうでなければノード全体：すべての文字の値を見せ、すべての文字に当てる（sections.ts の各項目の write）

// ボタンの説明に出すショートカット（TextEditor の toggleFormatOfKey。macOS では ⌘ も同じ）
export const TEXT_TOGGLE_SHORTCUTS: Record<TextToggleFormat, string> = {
  bold: 'Ctrl+B',
  italic: 'Ctrl+I',
  underline: 'Ctrl+U',
  strikethrough: 'Ctrl+Shift+X',
}

export interface TextToggleItem {
  key: TextToggleFormat
  title: string
  value: SharedValue<boolean> | null
}

// 編集中の文字のノード（nodes がそれだけのとき）
export function editingTextOf(textEditor: TextEditor | null, nodes: readonly NodeRecord[]): TextEditor | null {
  const id = textEditor?.editingId
  return id && nodes.length === 1 && nodes[0].id === id ? textEditor : null
}

// 編集中の文字の、選んでいる範囲（なければ次に打つ文字）の値
export function editingToggleValue(textEditor: TextEditor, key: TextToggleFormat): SharedValue<boolean> | null {
  return sharedOf(textEditor.selectionFormats().map((format) => format[key]))
}

export function editingToggleItems(textEditor: TextEditor): TextToggleItem[] {
  return TEXT_TOGGLE_FORMATS.map((key) => ({ key, title: TEXT_TOGGLE_FIELDS[key].label, value: editingToggleValue(textEditor, key) }))
}

// 切り替える。current はボタンに見せている値（ノード全体のとき、当てる値を決める）
export function applyTextToggle(
  editor: Editor,
  textEditor: TextEditor | null,
  nodes: readonly NodeRecord[],
  key: TextToggleFormat,
  current: SharedValue<boolean> | null,
): void {
  const editing = editingTextOf(textEditor, nodes)
  if (editing) {
    editing.toggleFormat(key)
    return
  }
  const values = !current ? [] : current.kind === 'same' ? [current.value] : current.values
  const value = toggledValue(values)
  const field = TEXT_TOGGLE_FIELDS[key]
  editNodes(editor, nodes.map((node) => node.id), (node) => field.write(node, value, null), `design: ${field.id}`, textEditor)
}
