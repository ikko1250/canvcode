import type { NodeRecord, Transaction, WorkspaceRecord } from '@canvcode/core'
import { nodeIn, type Editor } from './editor.ts'

// ノードのプロパティの変更（MAI-73：デザインパネル）。
// - 1 回の変更（色を選ぶ、数字を入れる）は 1 つのトランザクションにして、Undo 1 回で戻る
// - スライダーのドラッグや色の選択のように、値が続けて変わる操作も、begin から commit までを 1 つのトランザクションにまとめる。
//   途中の値は flush して描き直す。Esc などで cancel すれば、始める前の値に戻る
// - 文字の編集中（編集のトランザクションが開いている）は、新しいトランザクションを開けない（MAI-52）。
//   編集中のノードは、編集の中で変える（inline）。変更は編集の確定と一緒に Undo に入る

// 文字の編集中のノードを、編集のトランザクションの中で変える先（TextEditor がこの形を満たす）
export interface InlineEditTarget {
  readonly editingId: string | null
  updateNode(update: (node: NodeRecord) => NodeRecord): boolean
}

// ノードを受け取り、変えたノードを返す。変えないときは同じノードを返す（差分に入らない）
export type NodeUpdate = (node: NodeRecord) => NodeRecord

export class PropertyEdit {
  private readonly editor: Editor
  private readonly ids: readonly string[]
  private readonly label: string
  private readonly inline: InlineEditTarget | null
  private tx: Transaction<WorkspaceRecord> | null = null

  constructor(editor: Editor, ids: Iterable<string>, label: string, inline: InlineEditTarget | null = null) {
    this.editor = editor
    this.ids = [...ids]
    this.label = label
    this.inline = inline
  }

  // トランザクションを開いている（値を変えて、まだ確定していない）か
  get active(): boolean {
    return this.tx !== null && !this.tx.isDone
  }

  // 値を当てる（途中経過）。commit までに何度呼んでも、1 つのトランザクションにまとまる。
  // 当てられなかった（ほかの操作のトランザクションが開いている）ときは false
  update(update: NodeUpdate): boolean {
    const editingId = this.inline?.editingId
    if (editingId && this.ids.includes(editingId) && !this.active) {
      return this.inline!.updateNode((node) => update(node))
    }
    if (!this.active) {
      if (this.editor.store.activeTransaction) return false
      this.tx = this.editor.begin(this.label)
    }
    const tx = this.tx!
    for (const id of this.ids) {
      const node = nodeIn(tx, id)
      if (!node) continue
      const next = update(node)
      if (next !== node) tx.put(next)
    }
    tx.flush()
    return true
  }

  // 確定して Undo の履歴に入れる。何も変えていなければ履歴に入らない
  commit(): void {
    const tx = this.tx
    this.tx = null
    if (tx && !tx.isDone) this.editor.finish(tx)
  }

  // 始める前の値に戻して終える
  cancel(): void {
    const tx = this.tx
    this.tx = null
    if (tx && !tx.isDone) tx.cancel()
  }
}

// 1 回で終わる変更（色のボタン、数字の入力など）。Undo 1 回で戻る
export function editNodes(
  editor: Editor,
  ids: Iterable<string>,
  update: NodeUpdate,
  label: string,
  inline: InlineEditTarget | null = null,
): boolean {
  const edit = new PropertyEdit(editor, ids, label, inline)
  const ok = edit.update(update)
  edit.commit()
  return ok
}

// 複数のノードの、ある項目の値。すべて同じなら same、違えば mixed（パネルに「混在」と出す）
export type SharedValue<T> = { kind: 'same'; value: T } | { kind: 'mixed'; values: T[] }

export function sharedValue<T>(nodes: readonly NodeRecord[], read: (node: NodeRecord) => T): SharedValue<T> | null {
  if (nodes.length === 0) return null
  const values = nodes.map(read)
  const first = values[0]
  return values.every((value) => sameValue(value, first)) ? { kind: 'same', value: first } : { kind: 'mixed', values }
}

// 値が同じか。色や数字はそのまま比べ、オブジェクト（グラデーションなど、後で足す項目）は中身で比べる
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}
