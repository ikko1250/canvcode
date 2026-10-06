import type { NodeRecord } from '@canvcode/core'
import type { SlideLayoutKind, SlideLayoutSlots } from '@canvcode/nodes'

// slide-layout（スライド v2）の行を足す・消すときの計算。DOM に依存しない純粋な関数だけを置く。
// 書き込むのは呼び出し側（Editor）で、並べ直しはコミットフック（arrangeSlideLayouts）に任せる

// 行を持つレイアウト（表紙は行を持たない）
export type SlideLayoutRowKind = Exclude<SlideLayoutKind, 'title'>

export function hasSlideLayoutRows(kind: unknown): kind is SlideLayoutRowKind {
  return kind === 'bullets' || kind === 'table' || kind === 'table-image'
}

// 行の見出しか本文の id から、その行の番号（rows の中で）。どの行のセルでもなければ -1
export function slideLayoutRowOf(rows: SlideLayoutSlots['rows'], id: string): number {
  return rows.findIndex((row) => row.body === id || row.label === id)
}

// 行のセル（見出しか本文）の下端を動かした（上端の位置を変えずに高さを変えた）行に、手で決めた高さ（h）として、変えたあとのセルの高さを書いた slots。
// changed は id の子のトランザクションの前と後（変わっていなければ undefined）。上端・左右のリサイズや移動は h を書かない
// （並べ直しで元の箱に戻る）。同じ行の見出しと本文を両方伸ばしたら、高い方にする。書く行がなければ null
export function slotsWithResizedRows(
  slots: SlideLayoutSlots,
  changed: (id: string) => { before: NodeRecord; after: NodeRecord } | undefined,
): SlideLayoutSlots | null {
  let edited = false
  const rows = slots.rows.map((row) => {
    let h: number | undefined
    for (const id of [row.label, row.body]) {
      const change = id ? changed(id) : undefined
      if (!change) continue
      const before = (change.before.props as Record<string, unknown>).h
      const after = (change.after.props as Record<string, unknown>).h
      if (typeof before !== 'number' || typeof after !== 'number' || !(after > 0) || Math.abs(after - before) < 0.5) continue
      if (Math.abs(change.after.y - change.before.y) > 1e-6 || change.after.parentId !== change.before.parentId) continue
      h = Math.max(h ?? 0, Math.round(after))
    }
    if (h === undefined || h === row.h) return row
    edited = true
    return { ...row, h }
  })
  return edited ? { ...slots, rows } : null
}

// 手で決めた高さ（h）を外した行（自動に戻す）
export function slotsWithAutoRowHeight(slots: SlideLayoutSlots, row: number): SlideLayoutSlots {
  return { ...slots, rows: slots.rows.map((r, i) => (i === row ? { ...(r.label ? { label: r.label } : {}), body: r.body } : r)) }
}

// rows の at 番目に行を入れた slots（足す行は高さを持たない。自動で決める）
export function insertSlideLayoutRow(slots: SlideLayoutSlots, at: number, row: SlideLayoutSlots['rows'][number]): SlideLayoutSlots {
  const rows = [...slots.rows]
  rows.splice(Math.min(Math.max(at, 0), rows.length), 0, row)
  return { ...slots, rows }
}

// セルの書式（props）を写し、文字だけを空にする。図形の中の文字（label / labelParagraphs）とテキストの段落（paragraphs）を空にする。
// 段落は 1 つにして、最初の段落のリストと最初の run の書式を残す（空のセルに打った文字が、隣の行と同じ見た目になる）
export function emptiedCellProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...props }
  if (typeof out.label === 'string') out.label = ''
  if (Array.isArray(out.labelParagraphs)) out.labelParagraphs = emptiedParagraphs(out.labelParagraphs)
  if (Array.isArray(out.paragraphs)) out.paragraphs = emptiedParagraphs(out.paragraphs)
  return out
}

function emptiedParagraphs(paragraphs: unknown[]): unknown[] {
  const first = (paragraphs[0] ?? {}) as { runs?: unknown; list?: unknown }
  const run = (Array.isArray(first.runs) ? first.runs[0] : undefined) as { format?: unknown } | undefined
  return [{ runs: [run?.format ? { text: '', format: run.format } : { text: '' }], ...(first.list ? { list: first.list } : {}) }]
}
