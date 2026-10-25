import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, readFile, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizePlotSpec, plotTable, plotUsesX, type PlotSpec } from '@canvcode/nodes'
import { HttpError, type FileStore } from './files.ts'

// CSV から作るグラフ（matplotlib）。apps/server/plot/plot.py を子プロセスで動かして PNG にする。
// - 表の File をここで読み、選んだ列の文字の並びにして plot.py に渡す（数への読み替え・軸の種類は plot.py が決める）
// - スタイルはワークスペースの直下の style.py。なければ、初めて使うときに同梱の style.py を写す（そこから先はユーザーのもの。
//   普通の .py なので、画面のカード・全画面のエディタや Neovim で直せる）
// - style.py は Python のコードとして読む。画面を開ける人は Claude のパネルからシェルも動かせるので、新しい権限ではない
// - python3 と matplotlib が要る（CANVCODE_PYTHON で python の場所を変える）。なければ、そのことを知らせる
// - GET /api/plot/styles：スタイルの一覧。POST /api/plot：作り方（PlotSpec）を描いた PNG を返す（画面はそれを画像として取り込む）
// - MCP の plot_csv は render を呼び、Asset に保存して画像のノードを置く（mcp.ts）

const PLOT_DIR = fileURLToPath(new URL('../plot/', import.meta.url))
export const PLOT_SCRIPT = join(PLOT_DIR, 'plot.py')
export const DEFAULT_STYLE_FILE = join(PLOT_DIR, 'style.py')
export const STYLE_FILE_NAME = 'style.py'
const TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 1024 * 1024
// 一度に動かす python の数（プレビューを続けて頼まれても、詰まらないように）
const MAX_RUNNING = 2
// 渡す行の数の上限（それより多い行は使わない）
export const PLOT_MAX_ROWS = 200_000
const MAX_BODY_BYTES = 64 * 1024

export interface PlotStyle {
  name: string
  description: string
  colors: string[]
}

export interface RenderedPlot {
  png: Buffer
  width: number
  height: number
  warnings: string[]
}

export class PlotError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export interface PlotterOptions {
  workspace: string
  files: FileStore
  python?: string
}

export class Plotter {
  private readonly workspace: string
  private readonly files: FileStore
  private readonly python: string
  private running = 0
  private readonly waiting: (() => void)[] = []

  constructor(options: PlotterOptions) {
    this.workspace = options.workspace
    this.files = options.files
    this.python = options.python ?? 'python3'
  }

  get stylePath(): string {
    return join(this.workspace, STYLE_FILE_NAME)
  }

  // ワークスペースに style.py がなければ、同梱のものを写す（あれば何もしない）。写したら true
  async ensureStyleFile(): Promise<boolean> {
    try {
      await copyFile(DEFAULT_STYLE_FILE, this.stylePath, constants.COPYFILE_EXCL)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
  }

  async styles(): Promise<PlotStyle[]> {
    await this.ensureStyleFile()
    const { stdout } = await this.run(['styles', this.stylePath], '')
    return JSON.parse(stdout) as PlotStyle[]
  }

  // 作り方どおりに描く。表の File を読めない・列がない・描けないときは PlotError
  async render(spec: PlotSpec): Promise<RenderedPlot> {
    let info
    let text
    try {
      info = this.files.getInfo(spec.fileId)
      text = (await this.files.read(spec.fileId)).text
    } catch (error) {
      if (error instanceof HttpError) throw new PlotError(`表のファイルを読めません（${spec.fileId}：${error.message}）`, error.status === 404 ? 404 : 400)
      throw error
    }
    if (info.kind !== 'table') throw new PlotError(`${info.path} は表（CSV）ではありません`)
    const table = plotTable(text, info.path, spec.header)
    const column = (index: number) => {
      const found = table.columns[index]
      if (!found) throw new PlotError(`列 ${index + 1} は ${info.path} にありません（${table.columns.length} 列）`)
      const rows = table.rows.length > PLOT_MAX_ROWS ? table.rows.slice(0, PLOT_MAX_ROWS) : table.rows
      return { name: found.name, values: rows.map((row) => row[index] ?? '') }
    }
    const input = {
      kind: spec.kind,
      style: spec.style || undefined,
      title: spec.title,
      xlabel: spec.xlabel,
      ylabel: spec.ylabel,
      legend: spec.legend,
      x: plotUsesX(spec.kind) && spec.x !== null ? column(spec.x) : null,
      series: spec.y.map(column),
      width: spec.width,
      height: spec.height,
      dpi: 200,
    }
    await this.ensureStyleFile()
    const out = join(tmpdir(), `canvcode-plot-${randomBytes(8).toString('hex')}.png`)
    try {
      const { stdout } = await this.run(['render', this.stylePath, out], JSON.stringify(input))
      const result = JSON.parse(stdout) as { width: number; height: number; warnings: string[] }
      if (table.rows.length > PLOT_MAX_ROWS) result.warnings.push(`行が多いので、先頭の ${PLOT_MAX_ROWS} 行だけを描きました`)
      return { png: await readFile(out), ...result }
    } finally {
      await rm(out, { force: true })
    }
  }

  // plot.py を動かす。使う人の誤り（終了コード 2）は PlotError、python や matplotlib がないときもそう知らせる
  private async run(args: string[], stdin: string): Promise<{ stdout: string }> {
    await this.acquire()
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(this.python, [PLOT_SCRIPT, ...args], { cwd: this.workspace, stdio: ['pipe', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new PlotError(`グラフを ${TIMEOUT_MS / 1000} 秒で描き終えられませんでした`, 504))
        }, TIMEOUT_MS)
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
          if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk
        })
        child.stderr.on('data', (chunk: string) => {
          if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk
        })
        child.on('error', (error: NodeJS.ErrnoException) => {
          clearTimeout(timer)
          reject(
            error.code === 'ENOENT'
              ? new PlotError(`${this.python} が見つかりません。グラフを作るには Python 3 と matplotlib が要ります（CANVCODE_PYTHON で場所を変えられます）`, 503)
              : error,
          )
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          if (code === 0) return resolve({ stdout })
          reject(describeFailure(code, stderr))
        })
        child.stdin.on('error', () => {})
        child.stdin.end(stdin)
      })
    } finally {
      this.release()
    }
  }

  private async acquire(): Promise<void> {
    if (this.running < MAX_RUNNING) {
      this.running++
      return
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve))
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next) next()
    else this.running--
  }

  // /api/plot 以下を扱う。扱わないパスなら false を返す
  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (path !== '/api/plot' && path !== '/api/plot/styles') return false
    try {
      if (path === '/api/plot/styles' && req.method === 'GET') {
        sendJson(res, 200, { styles: await this.styles(), path: STYLE_FILE_NAME })
      } else if (path === '/api/plot' && req.method === 'POST') {
        const spec = normalizePlotSpec(JSON.parse((await readBody(req)).toString('utf8') || 'null'))
        if (!spec) throw new PlotError('グラフの作り方（fileId と値の列 y）がありません')
        const plot = await this.render(spec)
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': plot.png.length,
          'cache-control': 'no-store',
          'x-canvcode-width': String(plot.width),
          'x-canvcode-height': String(plot.height),
          // 日本語を含むので、ヘッダーに入るよう URL の形にする
          'x-canvcode-warnings': encodeURIComponent(JSON.stringify(plot.warnings)),
        })
        res.end(plot.png)
      } else {
        sendJson(res, 405, { error: 'method not allowed' })
      }
    } catch (error) {
      if (error instanceof PlotError) sendJson(res, error.status, { error: error.message })
      else if (error instanceof SyntaxError) sendJson(res, 400, { error: 'JSON を読めません' })
      else {
        console.error('plot request failed', error)
        sendJson(res, 500, { error: 'internal error' })
      }
    }
    return true
  }
}

// plot.py が失敗したときのメッセージ。使う人の誤り（終了コード 2）はそのまま、ほかは標準エラーの最後の行を添える
export function describeFailure(code: number | null, stderr: string): PlotError {
  const lines = stderr.trim().split('\n').filter((line) => line.trim() && !line.startsWith('findfont:'))
  if (code === 2) return new PlotError(lines.join('\n') || 'グラフを描けませんでした')
  if (/No module named '(matplotlib|cycler)'/.test(stderr)) {
    return new PlotError('matplotlib が入っていません。サーバーで pip install matplotlib（Ubuntu なら sudo apt install python3-matplotlib）を実行してください', 503)
  }
  return new PlotError(`グラフを描けませんでした：${lines.at(-1) ?? `終了コード ${code}`}`, 500)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new PlotError('要求が大きすぎます', 413)
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}
