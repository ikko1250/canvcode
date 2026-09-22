// 貼り付けた表を Markdown の表にする（MAI-12 の「外からの貼り付け」の 3、MAI-30）。
// 表計算ソフトやブラウザからコピーした表は、text/html の <table> か、タブ区切りの文字列で届く。

// HTML の <table> か、タブ区切りの文字列から、Markdown の表を作る。表でなければ null
export function markdownTableFromClipboard(html: string, text: string): string | null {
  const rows = (html && typeof DOMParser !== 'undefined' ? rowsFromHtml(html) : null) ?? rowsFromTsv(text)
  return rows ? toMarkdownTable(rows) : null
}

function rowsFromHtml(html: string): string[][] | null {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const table = doc.querySelector('table')
  if (!table) return null
  const rows = [...table.querySelectorAll('tr')].map((tr) =>
    [...tr.querySelectorAll('th, td')].map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim()),
  )
  return isTable(rows) ? rows : null
}

// タブ区切り：2 行以上あり、どの行にもタブがあるもの
function rowsFromTsv(text: string): string[][] | null {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')
  if (lines.length < 2 || !lines.every((line) => line.includes('\t'))) return null
  const rows = lines.map((line) => line.split('\t').map((cell) => cell.trim()))
  return isTable(rows) ? rows : null
}

function isTable(rows: string[][]): boolean {
  return rows.length >= 2 && rows.some((row) => row.length >= 2)
}

// 1 行目を見出しにする。列の数は、いちばん多い行に合わせる
export function toMarkdownTable(rows: string[][]): string {
  const columns = Math.max(...rows.map((row) => row.length))
  const cell = (value: string | undefined) => (value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const line = (row: string[]) => `| ${Array.from({ length: columns }, (_, i) => cell(row[i])).join(' | ')} |`
  const [header, ...body] = rows
  return [line(header), `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`, ...body.map(line)].join('\n') + '\n'
}
