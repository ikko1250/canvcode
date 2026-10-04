import type { FileManager } from '@canvcode/canvas'

// Markdown の File を PDF にしてダウンロードする（サーバーの md2pdf。apps/server/src/markdownPdf.ts）。
// 書きかけの本文を先に保存してから作る。失敗したら、サーバーの言う理由を投げる
export async function exportMarkdownPdf(files: FileManager, fileId: string): Promise<string> {
  await files.flush(fileId)
  const response = await fetch(`/api/files/${encodeURIComponent(fileId)}/pdf`, { method: 'POST' })
  if (!response.ok) {
    const result = (await response.json().catch(() => ({}))) as { error?: unknown }
    throw new Error(typeof result.error === 'string' ? result.error : `エラー ${response.status}`)
  }
  const blob = await response.blob()
  const encodedName = response.headers.get('x-canvcode-export-name')
  const name = encodedName ? decodeURIComponent(encodedName) : 'document.pdf'
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
  return name
}
