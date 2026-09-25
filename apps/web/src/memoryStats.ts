import type { CanvasView, Editor, FileManager, Workspace } from '@canvcode/canvas'
import { rasterizeImageCacheStats } from '@canvcode/nodes/markdown'

// 画面が手元に持っているものの内訳（メモリーのベンチマーク。MAI-67）。
// ヒープ全体の数字と並べて、どれが増えているかを見るために使う。
// バイト数は目安：画像は幅×高さ×4、レコードは JSON にしたときの文字数、本文は文字数

export interface MemoryBreakdown {
  records: { count: number; jsonChars: number; byType: Record<string, number> }
  editors: number
  imageCache: { entries: number; bytes: number; idle: boolean }
  thumbnails: { entries: number; bytes: number }
  assets: { records: number; pdfDocuments: number; localAssets: number; uploads: number }
  files: { entries: number; chars: number; dirty: number }
  markdownImages: { entries: number; chars: number }
}

export function memoryBreakdown(options: {
  workspace: Workspace
  view: CanvasView
  files: FileManager
  editors: ReadonlyMap<string, Editor>
}): MemoryBreakdown {
  const { workspace, view, files, editors } = options
  let count = 0
  let jsonChars = 0
  const byType: Record<string, number> = {}
  for (const record of workspace.store.values()) {
    count++
    jsonChars += JSON.stringify(record).length
    const key = record.typeName === 'node' ? `node:${record.type}` : record.typeName
    byType[key] = (byType[key] ?? 0) + 1
  }
  return {
    records: { count, jsonChars, byType },
    editors: editors.size,
    ...view.memoryStats(),
    files: files.stats,
    markdownImages: rasterizeImageCacheStats(),
  }
}
