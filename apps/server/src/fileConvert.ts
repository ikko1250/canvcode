import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import readXlsxFile from 'read-excel-file/node'
import type { AssetStore } from './assets.ts'
import { HttpError, type FileInfo, type FileStore } from './files.ts'

// ファイルのカード（attachment。MAI-100）の中身を、CanvCode で読める文書の写しにする。
// - docx は pandoc で Markdown（GFM）にする。中の画像は pandoc の --extract-media で取り出し、PDF の取り込みと同じく
//   Asset（.canvcode/assets/<ハッシュ>.<拡張子>）に置いて、Markdown からはルートからのパス（/.canvcode/assets/…）で指す
//   （画像の Asset を Markdown に貼るときと同じ形。#33）。ブラウザで出せない種類（EMF・WMF・TIFF など）も置くが、見えないことを知らせる
// - xlsx はシートごとに表（CSV）にする。日付のセルは 2026-11-11（時刻があれば 2026-11-11 09:30）、真偽は TRUE / FALSE
// - できた文書は、ワークスペースのフォルダの直下に新しい .md / .csv として作る（ふつうの File なので、画面のカードでも
//   MCP の read_document でも読める）。元のファイル（Asset）はそのまま残し、写しを直しても元には戻らない
// - 変換は自動では行わず、画面の右クリックから頼まれたときだけ行う（POST /api/convert）。
//   GET /api/convert は、変換できる種類と、pandoc があるか（ないなら理由）を返す
// - pandoc は CANVCODE_PANDOC で場所を変えられる（既定は PATH の pandoc）。--sandbox で動かし、渡したファイルのほかは読ませない

export type ConvertTarget = 'markdown' | 'table'

export interface ConvertCapabilities {
  // 変換できる拡張子（. なし）
  markdown: string[]
  table: string[]
  // docx の変換に要る pandoc があるか。ないなら、その理由
  pandoc: { available: boolean; reason?: string }
}

export interface ConvertResult {
  files: FileInfo[]
  // 変換はできたが、写せなかったもの（ブラウザで出せない画像・空のシートなど）
  warnings: string[]
}

export interface FileConverterOptions {
  files: FileStore
  assets: AssetStore
  pandoc?: string
}

export const MARKDOWN_SOURCES = ['docx']
export const TABLE_SOURCES = ['xlsx']
const TIMEOUT_MS = 60_000
// 作る文書の大きさの上限（FileStore が文書として扱う大きさ。files.ts の MAX_FILE_BYTES と同じ）
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
const MAX_BODY_BYTES = 64 * 1024
// 一度に動かす変換の数
const MAX_RUNNING = 2
// Markdown のカードでそのまま見せられる画像の種類（拡張子 → 種類。apps/server/src/assets.ts の ORIGINAL_TYPES に入るもの）
const VIEWABLE_IMAGES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
}
// 取り出した画像で、上のほかに種類の分かるもの（置くときの mime）
const OTHER_MEDIA: Record<string, string> = {
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  emf: 'image/emf',
  wmf: 'image/wmf',
}
const PANDOC_MISSING = 'サーバーのマシンに pandoc がないので、docx を Markdown に変換できません（pandoc を入れるか、CANVCODE_PANDOC で場所を指定してください）'

export class FileConverter {
  private readonly files: FileStore
  private readonly assets: AssetStore
  private readonly pandoc: string
  private pandocCheck: Promise<{ available: boolean; reason?: string }> | null = null
  private running = 0
  private readonly waiting: (() => void)[] = []

  constructor(options: FileConverterOptions) {
    this.files = options.files
    this.assets = options.assets
    this.pandoc = options.pandoc ?? 'pandoc'
  }

  // /api/convert を扱う。扱わないパスなら false を返す
  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (path !== '/api/convert') return false
    try {
      if (req.method === 'GET') {
        sendJson(res, 200, await this.capabilities())
      } else if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req, MAX_BODY_BYTES)).toString('utf8')) as { assetId?: unknown; name?: unknown; to?: unknown }
        if (typeof body.assetId !== 'string' || typeof body.name !== 'string') throw new HttpError(400, 'assetId and name are required')
        if (body.to !== 'markdown' && body.to !== 'table') throw new HttpError(400, 'to must be markdown or table')
        sendJson(res, 200, await this.convert(body.assetId, body.name, body.to))
      } else {
        sendJson(res, 405, { error: 'method not allowed' })
      }
    } catch (error) {
      if (error instanceof HttpError) sendJson(res, error.status, { error: error.message })
      else if (error instanceof SyntaxError) sendJson(res, 400, { error: 'invalid JSON' })
      else {
        console.error('file conversion failed', error)
        sendJson(res, 500, { error: error instanceof Error ? error.message : 'internal error' })
      }
    }
    return true
  }

  async capabilities(): Promise<ConvertCapabilities> {
    return { markdown: MARKDOWN_SOURCES, table: TABLE_SOURCES, pandoc: await this.checkPandoc() }
  }

  // Asset（ファイルのカードの原本）を、文書の写しにする。name は元のファイルの名前（拡張子で種類を決め、拡張子を除いたものを文書の名前にする）
  async convert(assetId: string, name: string, to: ConvertTarget): Promise<ConvertResult> {
    const ext = extensionOf(name)
    const sources = to === 'markdown' ? MARKDOWN_SOURCES : TABLE_SOURCES
    if (!sources.includes(ext)) throw new HttpError(415, `${to === 'markdown' ? 'Markdown' : '表'}に変換できるのは ${sources.map((s) => `.${s}`).join('・')} だけです`)
    const hash = assetId.startsWith('asset:') ? assetId.slice('asset:'.length) : ''
    const input = await this.assets.originalPath(hash)
    if (!input) throw new HttpError(404, '元のファイルがサーバーにありません（まだ送っている途中か、片付けられました）')
    const title = titleOf(name)
    return this.queued(() => (to === 'markdown' ? this.docxToMarkdown(input, title) : this.xlsxToTables(input, title)))
  }

  private async docxToMarkdown(input: string, title: string): Promise<ConvertResult> {
    const pandoc = await this.checkPandoc()
    if (!pandoc.available) throw new HttpError(503, pandoc.reason ?? PANDOC_MISSING)
    const dir = await mkdtemp(join(tmpdir(), 'canvcode-docx-'))
    try {
      // 取り出した画像のパスは「<token>/media/…」になる。文書の文字に出てこない名前にしておき、あとで Asset のパスに置き換える
      const token = `cc-media-${randomBytes(8).toString('hex')}`
      const args = ['--sandbox', '-f', 'docx', '-t', 'gfm', '--wrap=none', `--extract-media=${token}`, input]
      let markdown = await run(this.pandoc, args, dir)
      const warnings: string[] = []
      let hidden = 0
      for (const rel of await listFiles(join(dir, token))) {
        const data = await readFile(join(dir, token, rel))
        const ext = extensionOf(rel)
        const viewable = VIEWABLE_IMAGES[ext]
        const hash = viewable
          ? await this.assets.storeOriginal(data, viewable, ...(await imageSize(data)))
          : await this.assets.storeFile(data, OTHER_MEDIA[ext] ?? 'application/octet-stream', ext)
        if (!viewable) hidden++
        const stored = await this.assets.originalPath(hash)
        if (!stored) continue
        const url = `/.canvcode/assets/${basename(stored)}`
        const from = `${token}/${rel}`
        markdown = markdown.split(from).join(url).split(encodeURI(from)).join(url)
      }
      if (hidden > 0) warnings.push(`画像 ${hidden} 個は、ブラウザで表示できない形式（EMF・WMF・TIFF など）なので、Markdown のカードには出ません`)
      if (markdown.includes(token)) warnings.push('取り出せなかった画像があります')
      checkSize(markdown, `${title}.md`)
      const file = await this.files.create('markdown', title, markdown, { announce: true })
      return { files: [file], warnings }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  private async xlsxToTables(input: string, title: string): Promise<ConvertResult> {
    let sheets
    try {
      sheets = await readXlsxFile(input)
    } catch (error) {
      throw new HttpError(422, `xlsx を読めませんでした：${error instanceof Error ? error.message : String(error)}`)
    }
    const warnings: string[] = []
    const tables: { title: string; csv: string }[] = []
    for (const { sheet, data } of sheets) {
      const csv = sheetToCsv(data as unknown[][])
      if (!csv) {
        warnings.push(`シート「${sheet}」は空なので、表にしませんでした`)
        continue
      }
      const name = sheets.length === 1 ? title : `${title} - ${sheet}`
      if (Buffer.byteLength(csv) > MAX_DOCUMENT_BYTES) {
        warnings.push(`シート「${sheet}」は大きすぎる（${MAX_DOCUMENT_BYTES / 1024 / 1024} MB を超える）ので、表にしませんでした`)
        continue
      }
      tables.push({ title: name, csv })
    }
    if (tables.length === 0) throw new HttpError(422, warnings.length > 0 ? warnings.join('\n') : 'xlsx にシートがありません')
    const files: FileInfo[] = []
    for (const table of tables) files.push(await this.files.create('table', table.title, table.csv, { announce: true }))
    return { files, warnings }
  }

  // pandoc があるか（一度だけ確かめる）
  private checkPandoc(): Promise<{ available: boolean; reason?: string }> {
    this.pandocCheck ??= run(this.pandoc, ['--version'], tmpdir()).then(
      () => ({ available: true }),
      (error: unknown) => {
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
        return { available: false, reason: missing ? PANDOC_MISSING : `pandoc を動かせません：${error instanceof Error ? error.message : String(error)}` }
      },
    )
    return this.pandocCheck
  }

  private async queued<T>(task: () => Promise<T>): Promise<T> {
    while (this.running >= MAX_RUNNING) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.running++
    try {
      return await task()
    } finally {
      this.running--
      this.waiting.shift()?.()
    }
  }
}

// 表の行を CSV にする。末尾の空の行と、どの行でも空の右端の列は落とす。全部が空なら ''
export function sheetToCsv(rows: unknown[][]): string {
  const cells = rows.map((row) => row.map(cellText))
  while (cells.length > 0 && cells[cells.length - 1].every((cell) => cell === '')) cells.pop()
  const width = cells.reduce((max, row) => Math.max(max, row.findLastIndex((cell) => cell !== '') + 1), 0)
  if (width === 0) return ''
  return cells.map((row) => Array.from({ length: width }, (_, i) => csvField(row[i] ?? '')).join(',')).join('\n') + '\n'
}

// セルの値を文字にする。日付は年月日（時刻があれば時:分、秒があれば :秒も）。時刻だけのセル（Excel の 1899-12-30 の日付）は時刻だけ
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return ''
    const pad = (n: number) => String(n).padStart(2, '0')
    const date = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`
    const h = value.getUTCHours()
    const m = value.getUTCMinutes()
    const s = value.getUTCSeconds()
    const time = h || m || s ? `${pad(h)}:${pad(m)}${s ? `:${pad(s)}` : ''}` : ''
    if (value.getUTCFullYear() < 1900) return time || '00:00'
    return time ? `${date} ${time}` : date
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  return String(value)
}

function csvField(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

// 拡張子を除いた名前。空なら「無題」
function titleOf(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  return (dot > 0 ? base.slice(0, dot) : base).trim() || '無題'
}

function checkSize(text: string, name: string): void {
  if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) throw new HttpError(413, `${name} が大きすぎます（${MAX_DOCUMENT_BYTES / 1024 / 1024} MB まで）`)
}

// 画像の大きさ（画素）。読めなければ 0×0
async function imageSize(data: Buffer): Promise<[number, number]> {
  try {
    const { loadImage } = await import('@napi-rs/canvas')
    const image = await loadImage(data)
    return [image.width, image.height]
  } catch {
    return [0, 0]
  }
}

// フォルダの中のファイル（下のフォルダも。区切りは /）。フォルダがなければ空
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: string[] = []
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...(await listFiles(join(dir, entry.name), rel)))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

// コマンドを動かし、標準出力を返す。終わりの値が 0 でなければ、標準エラーを付けて失敗にする
function run(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let size = 0
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new HttpError(504, `${basename(command)} が ${TIMEOUT_MS / 1000} 秒で終わりませんでした`))
    }, TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_DOCUMENT_BYTES) {
        child.kill('SIGKILL')
        reject(new HttpError(413, `変換した文書が大きすぎます（${MAX_DOCUMENT_BYTES / 1024 / 1024} MB まで）`))
        return
      }
      out.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (err.reduce((n, c) => n + c.length, 0) < 64 * 1024) err.push(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'))
      else reject(new HttpError(422, `${basename(command)} が失敗しました：${Buffer.concat(err).toString('utf8').trim().slice(0, 500) || `終了コード ${code}`}`))
    })
  })
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > limit) throw new HttpError(413, 'too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
