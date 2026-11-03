import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HttpError, type FileInfo } from './files.ts'

// Markdown の File を PDF にする（md2pdf：https://github.com/ikko1250/md2pdf）。
// - POST /api/files/<id>/pdf で、pandoc + LuaLaTeX で作った PDF をそのまま返す（ワークスペースには書かない）
// - 見た目（テンプレート・フィルタ・空行の前処理）は apps/server/md2pdf/ に写した md2pdf のもの。
//   CANVCODE_MD2PDF に md2pdf を clone したフォルダを渡すと、そちらを使う
// - LuaLaTeX は重く、1 枚目のフォントのキャッシュ作りに時間がかかるので、1 つずつ順に作る。キャッシュは .canvcode/texmf に置く
// - 本文の生の LaTeX はそのまま通す（md2pdf と同じ）。ワークスペースを書く人を信頼している前提

const BUNDLED_MD2PDF = fileURLToPath(new URL('../md2pdf/', import.meta.url))
const CANVCODE_FILTER = join(BUNDLED_MD2PDF, 'canvcode-images.lua')
export const CANVCODE_ALIGN_FILTER = join(BUNDLED_MD2PDF, 'canvcode-align.lua')
export const CANVCODE_FOOTNOTES_FILTER = join(BUNDLED_MD2PDF, 'canvcode-footnotes.lua')
const TIMEOUT_MS = 180_000
const MAX_OUTPUT = 64 * 1024 * 1024

export const PANDOC_MISSING =
  'PDF を作るための pandoc か LuaLaTeX がサーバーにありません（apps/server/md2pdf/README.md を見てください）'

export interface MarkdownPdfSource {
  getInfo(id: string): FileInfo
  read(id: string): Promise<{ text: string }>
}

export interface MarkdownPdfOptions {
  // md2pdf のフォルダ（pandoc-lualatex-mplus.tex と filters/ があるところ）
  md2pdfDir?: string
  pandoc?: string
  python?: string
}

export class MarkdownPdf {
  private readonly files: MarkdownPdfSource
  private readonly workspace: string
  private readonly dataDir: string
  private readonly md2pdfDir: string
  private readonly pandoc: string
  private readonly python: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(files: MarkdownPdfSource, workspace: string, dataDir: string, options: MarkdownPdfOptions = {}) {
    this.files = files
    this.workspace = workspace
    this.dataDir = dataDir
    this.md2pdfDir = resolve(options.md2pdfDir ?? process.env.CANVCODE_MD2PDF ?? BUNDLED_MD2PDF)
    this.pandoc = options.pandoc ?? process.env.CANVCODE_PANDOC ?? 'pandoc'
    this.python = options.python ?? process.env.CANVCODE_PYTHON ?? 'python3'
  }

  // POST /api/files/<id>/pdf を扱う。扱わないパスなら false を返す
  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    const parts = path.split('/').filter(Boolean)
    if (parts.length !== 4 || parts[0] !== 'api' || parts[1] !== 'files' || parts[3] !== 'pdf') return false
    try {
      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed')
      const info = this.files.getInfo(safeDecode(parts[2]))
      if (info.kind !== 'markdown') throw new HttpError(400, 'Markdown の File だけを PDF にできます')
      const run = this.queue.then(() => this.build(info))
      this.queue = run.catch(() => {})
      const started = Date.now()
      const data = await run
      const name = `${safeFilename(info.title)}.pdf`
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': data.length,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'x-canvcode-export-name': encodeURIComponent(name),
        'x-canvcode-export-ms': String(Date.now() - started),
      })
      res.end(data)
    } catch (error) {
      if (error instanceof HttpError) sendJson(res, error.status, { error: error.message, ...error.extra })
      else {
        console.error('markdown pdf failed', error)
        sendJson(res, 500, { error: 'internal error' })
      }
    }
    return true
  }

  async build(info: FileInfo): Promise<Buffer> {
    const { text } = await this.files.read(info.id)
    const header = join(this.md2pdfDir, 'pandoc-lualatex-mplus.tex')
    if (!existsSync(header)) throw new HttpError(503, `md2pdf が見つかりません：${this.md2pdfDir}`)
    const filterDir = join(this.md2pdfDir, 'filters')
    const filters = (await readdir(filterDir).catch(() => []))
      .filter((name) => name.toLowerCase().endsWith('.lua'))
      .sort()
      .map((name) => join(filterDir, name))
    const texmf = join(this.dataDir, 'texmf')
    await mkdir(texmf, { recursive: true })
    const work = await mkdtemp(join(tmpdir(), 'canvcode-pdf-'))
    try {
      const source = join(work, 'source.md')
      const input = join(work, 'input.md')
      const output = join(work, 'output.pdf')
      await writeFile(source, text)
      const preprocessed = await run(this.python, [join(filterDir, 'preserve-extra-blank-lines.py'), source], { cwd: work })
      await writeFile(input, preprocessed.stdout)
      const docDir = dirname(info.path) === '.' ? '' : dirname(info.path)
      await run(
        this.pandoc,
        [
          '--from=markdown+autolink_bare_uris',
          // LaTeX のソースの改行は、Markdown に書いたとおりにする（pandoc で折り返さない）。
          // 和文の直後の改行は LuaTeX-ja が空白なしとして扱うので、段落の途中の和文の改行は空きにならず、
          // pandoc が折り返すと消えていた、書いた空白も残る
          '--wrap=preserve',
          '--pdf-engine=lualatex',
          '-V',
          'indent',
          '--metadata=lang:und',
          `--metadata=canvcode-workspace:${this.workspace}`,
          `--metadata=canvcode-docdir:${docDir}`,
          `--resource-path=${[join(this.workspace, docDir), this.workspace].join(delimiter)}`,
          `--include-in-header=${header}`,
          // 画像のパスと <p align> の寄せを先に直し、同じ脚注をまとめてから、md2pdf のフィルタに渡す
          '--lua-filter',
          CANVCODE_FILTER,
          '--lua-filter',
          CANVCODE_ALIGN_FILTER,
          '--lua-filter',
          CANVCODE_FOOTNOTES_FILTER,
          ...filters.flatMap((filter) => ['--lua-filter', filter]),
          input,
          '-o',
          output,
        ],
        { cwd: work, env: { ...process.env, TEXMFVAR: texmf, TEXMFCACHE: texmf } },
      )
      const data = await readFile(output).catch(() => null)
      if (!data || data.length === 0) throw new HttpError(500, 'PDF ができませんでした')
      return data
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { ...options, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (!error) return resolvePromise({ stdout, stderr })
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reject(new HttpError(503, `${PANDOC_MISSING}（${command}）`))
      if (error.killed) return reject(new HttpError(504, 'PDF を作るのに時間がかかりすぎました'))
      reject(new HttpError(422, `PDF を作れませんでした：${latexError(stderr) || error.message}`))
    })
  })
}

// pandoc / LuaLaTeX のエラー出力から、要る行だけを取り出す（「! 」で始まる LaTeX のエラーと、その次の数行）
export function latexError(stderr: string): string {
  const lines = stderr.split(/\r?\n/)
  const at = lines.findIndex((line) => line.startsWith('! '))
  if (at >= 0) return lines.slice(at, at + 3).join('\n').trim()
  return lines.filter((line) => line.trim()).slice(-3).join('\n').trim()
}

function safeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|\p{Cc}]/gu, '-').replace(/\s+/g, ' ').trim() || 'document'
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
