import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { assetIdFromHash } from '@canvcode/core'
import type { AssetStore } from '../assets.ts'
import type { FileStore } from '../files.ts'
import { allowedUrl, isPdfBody, type LinkPreviewService } from '../linkPreview.ts'
import { EditError } from './ops.ts'

// AI の編集（edit_canvas）の create type "pdf" の PDF を、編集の前に読む。
// - edit_canvas の操作は 1 つのトランザクションで同期に行うので、PDF を読む・Asset に保存する・ページの大きさを測るのは先に済ませる
// - path はワークスペースの中のファイル（外は断る）、url はリンクのカードの「PDF ポータルを作成」と同じ取り方（ローカルのアドレスを断る）
// - 保存した Asset は、編集が失敗しても残る（どこからも参照されなければ、assetGc.ts が 30 日後に消す）

const MAX_PDF_BYTES = 200 * 1024 * 1024

export interface PreparedPdf {
  // 既定の名前（ファイルの名前）
  title: string
  asset: { id: string; hash: string; size: number }
  // ページの大きさ（ポイント）
  pageSizes: { width: number; height: number }[]
}

export interface PdfSources {
  files: FileStore
  assets: AssetStore
  links?: LinkPreviewService
}

// ops の中の create type "pdf" を読む（ops の何番目か → 読んだもの）。読めなければ EditError を投げる（何も変えない）
export async function preparePdfs(ops: unknown[], sources: PdfSources | undefined): Promise<Map<number, PreparedPdf>> {
  const prepared = new Map<number, PreparedPdf>()
  for (const [i, raw] of ops.entries()) {
    const op = raw as { op?: unknown; type?: unknown; path?: unknown; url?: unknown }
    if (op?.op !== 'create' || op.type !== 'pdf') continue
    // path と url の形の誤りは、ops.ts の確かめに任せる
    if ((typeof op.path === 'string') === (typeof op.url === 'string')) continue
    try {
      if (!sources) throw new Error('importing PDFs is not available')
      prepared.set(i, typeof op.path === 'string' ? await fromPath(op.path, sources) : await fromUrl(op.url as string, sources))
    } catch (error) {
      throw new EditError(`ops[${i}] (create): ${error instanceof Error ? error.message : String(error)}. Nothing was changed.`)
    }
  }
  return prepared
}

async function fromPath(path: string, sources: PdfSources): Promise<PreparedPdf> {
  let abs: string
  try {
    abs = sources.files.resolveWorkspacePath(path)
  } catch {
    throw new Error(`${path} is outside the workspace`)
  }
  const info = await stat(abs).catch(() => null)
  if (!info?.isFile()) throw new Error(`no file at ${path}`)
  if (info.size > MAX_PDF_BYTES) throw new Error(`${path} is too large (over ${MAX_PDF_BYTES / 1024 / 1024} MB)`)
  return store(await readFile(abs), basename(abs).replace(/\.pdf$/i, '') || 'PDF', path, sources)
}

async function fromUrl(raw: string, sources: PdfSources): Promise<PreparedPdf> {
  const url = allowedUrl(raw)
  if (!url) throw new Error(`${raw} is not an allowed http(s) URL`)
  if (!sources.links) throw new Error('downloading PDFs is not available')
  const pdf = await sources.links.pdf(url.href)
  if (pdf === 'too large') throw new Error(`${raw} is too large`)
  if (!pdf) throw new Error(`${raw} is not a PDF`)
  return store(pdf.body, pdf.name, raw, sources)
}

async function store(body: Buffer, title: string, source: string, sources: PdfSources): Promise<PreparedPdf> {
  // 中身で決める（.pdf という名前でも PDF でないことがある）
  if (!isPdfBody(body)) throw new Error(`${source} is not a PDF`)
  let pageSizes: PreparedPdf['pageSizes']
  try {
    pageSizes = await measurePages(body)
  } catch (error) {
    throw new Error(`could not read ${source} as a PDF (${error instanceof Error ? error.message : String(error)})`)
  }
  if (pageSizes.length === 0) throw new Error(`${source} has no pages`)
  const hash = await sources.assets.storeOriginal(body, 'application/pdf', 0, 0)
  return { title, asset: { id: assetIdFromHash(hash), hash, size: body.length }, pageSizes }
}

// ページの大きさ（画面の取り込みの pageSize と同じく、scale 1 の viewport。回転も含む）
async function measurePages(body: Buffer): Promise<PreparedPdf['pageSizes']> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // data は PDF.js に渡すと使えなくなるので、写しを渡す
  const task = pdfjs.getDocument({ data: new Uint8Array(body), useSystemFonts: false })
  try {
    const doc = await task.promise
    const sizes = []
    for (let i = 1; i <= doc.numPages; i++) {
      const viewport = (await doc.getPage(i)).getViewport({ scale: 1 })
      sizes.push({ width: viewport.width, height: viewport.height })
    }
    return sizes
  } finally {
    await task.destroy()
  }
}
