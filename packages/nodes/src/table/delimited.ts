// 区切り文字の表（CSV・TSV）を読む。グラフのデータ（chart.ts の parseChartTable）と、表のカード（tableCard.ts）で使う

export type Delimiter = '\t' | ',' | ';'

// 区切り文字：タブがあればタブ、なければカンマ（カンマがなくセミコロンがあればセミコロン）
export function detectDelimiter(text: string): Delimiter {
  return text.includes('\t') ? '\t' : !text.includes(',') && text.includes(';') ? ';' : ','
}

// 区切り文字の表を、行ごとのセルにする（CSV の "…" と "" を読む。"…" の中の区切り・改行は文字として読む）。
// 改行は \n に揃えてから渡す
export function splitDelimited(text: string, delimiter: string): string[][] {
  const records: string[][] = []
  let cells: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && cell.trim() === '') {
      quoted = true
      cell = ''
    } else if (ch === delimiter) {
      cells.push(cell)
      cell = ''
    } else if (ch === '\n') {
      cells.push(cell)
      records.push(cells)
      cells = []
      cell = ''
    } else cell += ch
  }
  cells.push(cell)
  records.push(cells)
  return records
}

// ファイルの CSV・TSV を表にする：BOM を除き、改行を揃え、末尾の空の行を除き、どの行も最も長い行と同じ列の数にする。
// delimiter を省けば detectDelimiter で選ぶ（.tsv はタブを渡す）
export function parseDelimited(text: string, delimiter?: string): string[][] {
  const source = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const rows = splitDelimited(source, delimiter ?? detectDelimiter(source))
  while (rows.length > 0 && rows.at(-1)!.every((cell) => cell === '')) rows.pop()
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0)
  for (const row of rows) while (row.length < columns) row.push('')
  return rows
}
