import { copyFile, mkdir, rm } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { AssetStore } from '../assets.ts'
import type { FileStore } from '../files.ts'
import type { RecordStore, StoredRecord } from '../records.ts'
import type { SyncHub } from '../sync.ts'
import type { ThumbnailStore } from '../thumbnails.ts'
import { convertBackup, type ImportReport } from './convert.ts'
import { ZipReader } from './zip.ts'

// 旧データ（.ricbackup）の取り込み（MAI-13 の「7.」、MAI-36）。変換した結果を書き込む。
// 書く順番：Asset → .md / .py の本文 → サムネイル → レコード（1 つのトランザクション）。
// レコードを保存できなかったときは、書き出した .md / .py を .canvcode/deleted/ に移し、何も取り込まなかったことにする
// （Asset とサムネイルは、どこからも参照されないだけなので残す）。
// 元の .ricbackup は .canvcode/imports/ に残す（AI 会話などを、あとから取り込めるように）

export interface ImportDeps {
  dataDir: string
  records: RecordStore
  files: FileStore
  assets: AssetStore
  thumbnails: ThumbnailStore
  // 開いているブラウザに知らせる（サーバーの外から取り込むときはない）
  sync?: SyncHub
}

export interface ImportResult {
  report: ImportReport
  rev: number
}

let running = false

export async function importBackup(path: string, deps: ImportDeps): Promise<ImportResult> {
  if (running) throw new ImportError('ほかの取り込みの途中です')
  running = true
  try {
    return await importOnce(path, deps)
  } finally {
    running = false
  }
}

async function importOnce(path: string, deps: ImportDeps): Promise<ImportResult> {
  const { records, files, assets, thumbnails } = deps
  const current = records.load()
  const rootNodes = current.records.filter((r) => r.typeName === 'node' && r.parentId === current.rootCanvasId)
  // ルートの Canvas しかなければ「空」（旧のルートの中身を、そのままルートに入れる）
  const empty = current.records.length <= 1
  const zip = await ZipReader.open(path).catch(() => {
    throw new ImportError('.ricbackup を開けませんでした（ZIP ではないか、壊れています）')
  })
  let plan
  try {
    plan = await convertBackup(zip, { rootCanvasId: current.rootCanvasId, empty, rootNodes })
  } catch (error) {
    throw error instanceof Error ? new ImportError(error.message) : error
  } finally {
    await zip.close()
  }
  const existing = new Set(current.records.map((r) => r.id))
  if (plan.oldCanvasIds.some((id) => existing.has(id))) throw new ImportError('この .ricbackup は、すでに取り込んであります')

  for (const asset of plan.assets) await assets.storeOriginal(asset.data, asset.mime, asset.width, asset.height)

  // 本文を書き出し、File のレコードにパスとハッシュを入れる
  const fileRecords: StoredRecord[] = []
  const written: string[] = []
  try {
    for (const file of plan.files) {
      const info = await files.create(file.kind, file.title, file.content, { id: file.id, announce: deps.sync !== undefined })
      written.push(info.id)
      fileRecords.push({ ...file.record, title: info.title, path: info.path, size: info.size, mtime: info.mtime, hash: info.hash, missing: false })
    }
    for (const thumbnail of plan.thumbnails) await thumbnails.save(thumbnail.canvasId, thumbnail.png)
    const puts = [...plan.records, ...fileRecords]
    const rev = records.apply(puts, [])
    deps.sync?.broadcast(rev, puts, { imported: plan.report })
    return { report: plan.report, rev }
  } catch (error) {
    for (const id of written) await files.removeForever(id).catch(() => {})
    throw error
  }
}

export class ImportError extends Error {}

// 結果の報告を、人が読む文にする（コマンドの出力用。画面は App.tsx が同じ内容を出す）
export function describeReport(report: ImportReport): string[] {
  const lines = [
    `キャンバス ${report.canvases} 個、Markdown ${report.markdown} 個、Python ${report.code} 個、PDF ${report.pdf} 個、ノード ${report.nodes} 個（画像 ${report.images}、引用ノート ${report.quotes}）を取り込みました`,
  ]
  if (report.unplaced > 0) lines.push(`どこからもたどれなかった ${report.unplaced} 個は「未配置」に入れました`)
  if (report.skippedTrashed > 0) lines.push(`ゴミ箱の中の ${report.skippedTrashed} 個は取り込みませんでした`)
  if (report.skippedLinks > 0) lines.push(`ゴミ箱の中のものを指していた Portal・カード・引用 ${report.skippedLinks} 個は取り込みませんでした`)
  if (report.lostFormatting > 0) lines.push(`テキスト ${report.lostFormatting} 個の書式（太字・リンク・箇条書きなど）は失われ、プレーンテキストになりました`)
  if (report.lostPortalLabels > 0) lines.push(`Portal ${report.lostPortalLabels} 個の独自の名前は失われ、参照先の名前になりました`)
  for (const [what, count] of Object.entries(report.unsupported)) lines.push(`${what} ${count} 個は変換できませんでした`)
  return lines
}

// 元の .ricbackup を .canvcode/imports/ に置く（置いた場所を返す）
export async function keepBackup(dataDir: string, source: string): Promise<string> {
  const dir = join(dataDir, 'imports')
  await mkdir(dir, { recursive: true })
  const target = join(dir, basename(source))
  if (resolve(source) !== resolve(target)) await copyFile(source, target)
  return target
}

// POST /api/import：ブラウザからドロップしたファイル（本文）か、サーバーの上のファイルの場所（JSON の path）を受け取って取り込む
export async function handleImport(req: IncomingMessage, res: ServerResponse, path: string, deps: ImportDeps): Promise<boolean> {
  if (path !== '/api/import') return false
  if (req.method !== 'POST') {
    send(res, 405, { error: 'method not allowed' })
    return true
  }
  let source: string
  try {
    if ((req.headers['content-type'] ?? '').startsWith('application/json')) {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { path?: string }
      if (!body.path) throw new ImportError('path がありません')
      source = await keepBackup(deps.dataDir, resolve(body.path))
    } else {
      // 本文をそのまま .canvcode/imports/ に書く（数百 MB あるので、メモリに載せない）
      const name = basename(decodeURIComponent(String(req.headers['x-filename'] ?? 'upload.ricbackup'))).replace(/[^\w.\-()]/g, '_')
      const dir = join(deps.dataDir, 'imports')
      await mkdir(dir, { recursive: true })
      source = join(dir, `${Date.now()}-${name}`)
      try {
        await pipeline(req, createWriteStream(source))
      } catch (error) {
        await rm(source, { force: true })
        throw error
      }
    }
    const result = await importBackup(source, deps)
    send(res, 200, result)
  } catch (error) {
    if (error instanceof ImportError) send(res, 400, { error: error.message })
    else {
      console.error('import failed', error)
      send(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  return true
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
