import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { writeViaTemp } from './writeAtomic.ts'

// PDF のページの画像（Issue #26、docs/pdf-page-images-plan.md の「1」）。
// - PDF を取り込んだあと、裏で全ページを poppler（pdftoppm）で描き、2 通りの画像を作って Asset の隣に置く
//   1. 長辺 256px の縮小画像を、幅・高さ 4096px までのシートに並べたもの（全体表示で使う）
//   2. 長辺 1024px のページごとの画像（中くらいの倍率と、PDF.js で描くまでの仮の表示で使う）。
//      PDF 1 MB あたり 0.8 MB ほど（1 ページ 75 KB ほど）と容量が大きいので、既定では作らない（mid。サーバーは CANVCODE_PDF_PREVIEW_MID=1 で作る）
// - サーバーの PDF.js ではなく poppler を使うのは、埋め込まれていない日本語フォント（EDINET の書類など）の文字を
//   OS のフォントで描けるため。別のプロセスで動くので、サーバーのイベントループも止めない
// - pdftoppm がなければ（起動したときに pdftoppm -v で確かめる）一度だけログに出し、何も作らない（画面は今までどおり PDF.js で描く）
// - nice -n 10 で動かし、1 度に 1 つの PDF だけ扱う。1 つの PDF に PREVIEW_TIMEOUT_MS 以上かかったら止める
// - ファイルは <ハッシュ>.preview-v<版>.json（マニフェスト）・<ハッシュ>.preview-v<版>.sheet<N>.webp・<ハッシュ>.preview-v<版>.p<ページ>.webp。
//   <ハッシュ>. で始まるので、Asset の片付け（assetGc.ts）が原本と一緒に消す。作り直せるので、バックアップには入れない（isPdfPreviewFile）
// - 描き方を変えて作り直すときは PREVIEW_VERSION を上げる。古い版のファイルは、起動したとき（init）に消す
//   （版 2：ページの大きさ（pdfinfo・PDF.js）と同じ CropBox で描く。版 1 は MediaBox で描いていて、裁ち落としの外まで写っていた）
// - 同じ版でも、作り直すとシートの並びが変わりうる（poppler の版で縮小画像の大きさが 1px 違うなど）。画像の URL は長く
//   キャッシュさせるので、作るたびに rev を変え、画面は URL に付けて読む（バックアップから戻したあとなどに、古いシートを切り出さない）

export const PREVIEW_VERSION = 2
export const PREVIEW_THUMB_SIZE = 256
export const PREVIEW_MID_SIZE = 1024
const SHEET_MAX = 4096
const WEBP_QUALITY = 80
const PREVIEW_TIMEOUT_MS = 10 * 60_000
const WORK_DIR_PREFIX = 'canvcode-preview-work-'
const HASH_PATTERN = /^[0-9a-f]{64}$/
const PREVIEW_FILE = /^[0-9a-f]{64}\.preview-v(\d+)\./

export interface PdfPreviewManifest {
  version: number
  // ページの大きさ（ポイント、回転したあと）。thumbs と同じ順番
  pages: { w: number; h: number }[]
  sheets: { width: number; height: number }[]
  thumbs: { sheet: number; x: number; y: number; w: number; h: number }[]
  // 段 2（長辺 1024px のページごとの画像）ができていれば付ける
  mid?: { size: number }
  // 作るたびに変わる印。画像の URL に付ける
  rev: string
}

export type PdfPreviewStatus = { status: 'ready'; manifest: PdfPreviewManifest } | { status: 'pending' } | { status: 'unavailable' }

export interface PdfPreviewOptions {
  pdftoppm?: string
  pdfinfo?: string
  // nice -n 10 で動かすか（既定は動かす）
  nice?: boolean
  // 段 2（長辺 1024px のページごとの画像）を作るか（既定は作らない）。作らないときは、作ってあるものも使わせない
  mid?: boolean
  log?: (message: string, error?: unknown) => void
}

// 名前が PDF のページの画像（作り直せるもの）か。バックアップと Drive への写しから外す
export function isPdfPreviewFile(name: string): boolean {
  return PREVIEW_FILE.test(name)
}

export class PdfPreviews {
  private readonly dir: string
  private readonly pdftoppm: string
  private readonly pdfinfo: string
  private readonly nice: boolean
  private readonly mid: boolean
  private readonly log: (message: string, error?: unknown) => void
  private available: Promise<boolean> | null = null
  // 順番待ちのハッシュ（先頭から作る）
  private readonly queue: string[] = []
  private running: string | null = null
  private pump: Promise<void> | null = null
  // 作れなかった PDF（壊れている、パスワードが要る、など）。サーバーを起動し直すまで作り直さない
  private readonly failed = new Set<string>()

  constructor(assetsDir: string, options: PdfPreviewOptions = {}) {
    this.dir = assetsDir
    this.pdftoppm = options.pdftoppm ?? 'pdftoppm'
    this.pdfinfo = options.pdfinfo ?? 'pdfinfo'
    this.nice = options.nice ?? true
    this.mid = options.mid ?? false
    this.log = options.log ?? ((message, error) => (error === undefined ? console.log(message) : console.error(message, error)))
  }

  // pdftoppm があるか（一度だけ確かめる）
  isAvailable(): Promise<boolean> {
    this.available ??= new Promise((resolve) => {
      execFile(this.pdftoppm, ['-v'], { timeout: 10_000 }, (error) => {
        if (error) this.log(`PDF のページの画像を作る pdftoppm（poppler-utils）がないので、作りません（${this.pdftoppm}）`)
        resolve(!error)
      })
    })
    return this.available
  }

  // 起動したときに呼ぶ。古い版のファイルを消し、画像のない（段 2 がまだのものも）PDF をすべて順番待ちに入れる
  async init(): Promise<void> {
    const names = await readdir(this.dir).catch(() => [] as string[])
    const pdfs = new Set(names.filter((name) => name.endsWith('.pdf')))
    const manifests = new Map<string, boolean>()
    for (const name of names) {
      const match = PREVIEW_FILE.exec(name)
      if (match && Number(match[1]) !== PREVIEW_VERSION) await rm(join(this.dir, name), { force: true }).catch(() => {})
    }
    await removeStaleWorkDirs()
    for (const name of names) {
      const match = /^([0-9a-f]{64})\.json$/.exec(name)
      if (!match) continue
      const hash = match[1]
      if (!pdfs.has(`${hash}.pdf`)) continue
      const manifest = await this.readManifest(hash)
      manifests.set(hash, this.mid ? !!manifest?.mid : !!manifest)
    }
    if (![...manifests.values()].some((done) => !done)) return
    if (!(await this.isAvailable())) return
    for (const [hash, done] of manifests) if (!done) this.enqueue(hash)
  }

  // 順番待ちに入れる（front なら先頭に。画面が求めたとき）
  enqueue(hash: string, front = false): void {
    if (!HASH_PATTERN.test(hash) || this.failed.has(hash) || this.running === hash) return
    const at = this.queue.indexOf(hash)
    if (at >= 0) {
      if (!front) return
      this.queue.splice(at, 1)
    }
    if (front) this.queue.unshift(hash)
    else this.queue.push(hash)
    this.startPump()
  }

  private startPump(): void {
    this.pump ??= this.drain().finally(() => {
      this.pump = null
      // drain が終わってから、ここまでの間に入ったもの
      if (this.queue.length > 0) this.startPump()
    })
  }

  // 順番待ちが空になるまで待つ（テスト用）
  async idle(): Promise<void> {
    while (this.pump) await this.pump
  }

  async status(hash: string): Promise<PdfPreviewStatus> {
    const manifest = await this.readManifest(hash)
    if (manifest) {
      // 段 2 がまだなら、先に作ってもらう
      if (this.mid && !manifest.mid && !this.failed.has(hash) && (await this.isAvailable())) this.enqueue(hash, true)
      return { status: 'ready', manifest }
    }
    if (this.failed.has(hash) || !(await this.isAvailable())) return { status: 'unavailable' }
    const pdf = await stat(join(this.dir, `${hash}.pdf`)).catch(() => null)
    if (!pdf) return { status: 'unavailable' }
    this.enqueue(hash, true)
    return { status: 'pending' }
  }

  // GET /api/assets/<ハッシュ>/preview 以下。rest は preview の後ろ（[] か ['v1', 'sheet' | 'page', '<番号>']）
  async handle(req: IncomingMessage, res: ServerResponse, hash: string, rest: string[]): Promise<void> {
    if (!HASH_PATTERN.test(hash)) return sendJson(res, 404, { error: 'not found' })
    if (rest.length === 0) {
      const result = await this.status(hash)
      if (result.status !== 'ready') return sendJson(res, 404, { status: result.status }, 'no-cache')
      // 段 2 があとで足されるので、毎回確かめさせる。まだ作っているなら pending を付けて、聞き直させる（作れなかったものには付けない）
      const pending = this.mid && !result.manifest.mid && !this.failed.has(hash)
      return sendJson(res, 200, pending ? { ...result.manifest, pending: true } : result.manifest, 'no-cache')
    }
    const [version, kind, index] = rest
    if (rest.length !== 3 || version !== `v${PREVIEW_VERSION}` || !/^\d+$/.test(index) || (kind !== 'sheet' && (kind !== 'page' || !this.mid))) {
      return sendJson(res, 404, { error: 'not found' })
    }
    const path = join(this.dir, `${hash}.preview-v${PREVIEW_VERSION}.${kind === 'sheet' ? 'sheet' : 'p'}${Number(index)}.webp`)
    const info = await stat(path).catch(() => null)
    if (!info) return sendJson(res, 404, { error: 'not found' })
    res.writeHead(200, {
      'content-type': 'image/webp',
      'content-length': info.size,
      // URL に版が入っていて、同じ版のうちは中身が変わらない
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    // stat のあとに消えていたら（Asset の片付けなど）、応答を途中で切る（サーバーは落とさない）
    await pipeline(createReadStream(path), res).catch(() => res.destroy())
  }

  async readManifest(hash: string): Promise<PdfPreviewManifest | null> {
    if (!HASH_PATTERN.test(hash)) return null
    try {
      const { mid, ...manifest } = JSON.parse(await readFile(this.file(hash, 'json'), 'utf8')) as PdfPreviewManifest
      if (manifest.version !== PREVIEW_VERSION) return null
      return this.mid && mid ? { ...manifest, mid } : manifest
    } catch {
      return null
    }
  }

  private file(hash: string, suffix: string): string {
    return join(this.dir, `${hash}.preview-v${PREVIEW_VERSION}.${suffix}`)
  }

  private async drain(): Promise<void> {
    if (!(await this.isAvailable())) {
      this.queue.length = 0
      return
    }
    for (let hash = this.queue.shift(); hash !== undefined; hash = this.queue.shift()) {
      this.running = hash
      try {
        await this.generate(hash)
      } catch (error) {
        this.failed.add(hash)
        this.log(`PDF のページの画像を作れませんでした（${hash}）`, error)
      } finally {
        this.running = null
      }
    }
  }

  // 1 つの PDF の画像を作る。段 1 ができたらマニフェストを書き、段 2 ができたら mid を足して書き直す
  async generate(hash: string): Promise<void> {
    const pdf = join(this.dir, `${hash}.pdf`)
    if (!(await stat(pdf).catch(() => null))) return
    let manifest = await this.readManifest(hash)
    if (manifest?.mid || (manifest && !this.mid)) return
    const deadline = Date.now() + PREVIEW_TIMEOUT_MS
    const { createCanvas, loadImage } = await import('@napi-rs/canvas')
    const work = await mkdtemp(join(tmpdir(), WORK_DIR_PREFIX))
    try {
      if (!manifest) {
        const pages = await this.pageSizes(pdf, deadline)
        const thumbs = await this.renderPages(pdf, PREVIEW_THUMB_SIZE, join(work, 't'), deadline)
        if (thumbs.length !== pages.length) throw new Error(`pdftoppm made ${thumbs.length} pages, but the PDF has ${pages.length}`)
        // 大きさは PNG の頭から読み、展開するのは 1 枚のシートに載る分だけにする（ページの多い PDF でメモリーを使いすぎない）
        const layout = packSheets(await Promise.all(thumbs.map(pngSize)))
        for (const [index, sheet] of layout.sheets.entries()) {
          const canvas = createCanvas(sheet.width, sheet.height)
          const ctx = canvas.getContext('2d')
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(0, 0, sheet.width, sheet.height)
          for (const [i, thumb] of layout.thumbs.entries()) {
            if (thumb.sheet === index) ctx.drawImage(await loadImage(await readFile(thumbs[i])), thumb.x, thumb.y)
          }
          await this.write(this.file(hash, `sheet${index}.webp`), await canvas.encode('webp', WEBP_QUALITY))
        }
        manifest = { version: PREVIEW_VERSION, pages, sheets: layout.sheets, thumbs: layout.thumbs, rev: randomUUID().slice(0, 8) }
        await this.write(this.file(hash, 'json'), Buffer.from(JSON.stringify(manifest)))
        await rm(join(work, 't'), { recursive: true, force: true })
      }
      if (!this.mid) return
      const mids = await this.renderPages(pdf, PREVIEW_MID_SIZE, join(work, 'm'), deadline)
      if (mids.length !== manifest.pages.length) throw new Error(`pdftoppm made ${mids.length} pages, but the PDF has ${manifest.pages.length}`)
      for (const [i, path] of mids.entries()) {
        const image = await loadImage(await readFile(path))
        const canvas = createCanvas(image.width, image.height)
        canvas.getContext('2d').drawImage(image, 0, 0)
        await this.write(this.file(hash, `p${i}.webp`), await canvas.encode('webp', WEBP_QUALITY))
      }
      await this.write(this.file(hash, 'json'), Buffer.from(JSON.stringify({ ...manifest, mid: { size: PREVIEW_MID_SIZE } })))
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }

  // ページの大きさ（ポイント、回転したあと）
  private async pageSizes(pdf: string, deadline: number): Promise<{ w: number; h: number }[]> {
    // -l にページ数より大きい数を渡すと、最後のページまでになる
    const out = await this.run(this.pdfinfo, ['-f', '1', '-l', '1000000', pdf], deadline)
    return parsePageSizes(out)
  }

  // 全ページを長辺 size 画素の PNG にして、ページの順に並べたパスを返す。
  // pdftoppm は既定では MediaBox を描くので、ページの大きさ（pdfinfo・PDF.js）と同じ CropBox で描かせる
  private async renderPages(pdf: string, size: number, dir: string, deadline: number): Promise<string[]> {
    await mkdir(dir, { recursive: true })
    await this.run(this.pdftoppm, ['-cropbox', '-scale-to', String(size), '-png', pdf, join(dir, 'p')], deadline)
    const pages = (await readdir(dir))
      .map((name) => ({ name, page: Number(/-(\d+)\.png$/.exec(name)?.[1]) }))
      .filter(({ page }) => Number.isInteger(page))
      .sort((a, b) => a.page - b.page)
    return pages.map(({ name }) => join(dir, name))
  }

  private run(command: string, args: string[], deadline: number): Promise<string> {
    const timeout = deadline - Date.now()
    if (timeout <= 0) return Promise.reject(new Error('timed out'))
    const [bin, argv] = this.nice ? ['nice', ['-n', '10', command, ...args]] : [command, args]
    return new Promise((resolve, reject) => {
      execFile(bin, argv, { timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (!error) return resolve(stdout)
        reject(new Error(`${command} failed${error.killed ? ' (timed out)' : ''}: ${stderr.trim().split('\n').slice(-3).join(' ') || error.message}`))
      })
    })
  }

  private async write(path: string, data: Buffer): Promise<void> {
    await writeViaTemp(`${path}.${process.pid}.${Date.now()}.tmp`, path, data)
  }
}

// PNG の幅と高さ（IHDR）
async function pngSize(path: string): Promise<{ w: number; h: number }> {
  const file = await open(path, 'r')
  try {
    const head = Buffer.alloc(24)
    await file.read(head, 0, 24, 0)
    return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) }
  } finally {
    await file.close()
  }
}

// 落ちたり止められたりしたサーバーが残した作業用のフォルダを消す。ほかのサーバー（別のワークスペース）が
// 使っているかもしれないので、1 つの PDF にかけてよい時間の 2 倍より古いものだけ
async function removeStaleWorkDirs(): Promise<void> {
  const names = await readdir(tmpdir()).catch(() => [] as string[])
  for (const name of names) {
    if (!name.startsWith(WORK_DIR_PREFIX)) continue
    const path = join(tmpdir(), name)
    const info = await stat(path).catch(() => null)
    if (info?.isDirectory() && Date.now() - info.mtimeMs > PREVIEW_TIMEOUT_MS * 2) await rm(path, { recursive: true, force: true }).catch(() => {})
  }
}

// pdfinfo -f 1 -l <n> の出力から、ページの大きさ（ポイント、回転したあと）を読む
export function parsePageSizes(out: string): { w: number; h: number }[] {
  const sizes = new Map<number, { w: number; h: number }>()
  const rotations = new Map<number, number>()
  for (const line of out.split('\n')) {
    const size = /^Page\s+(\d+)\s+size:\s+([\d.]+)\s+x\s+([\d.]+)/.exec(line)
    if (size) sizes.set(Number(size[1]), { w: Number(size[2]), h: Number(size[3]) })
    const rot = /^Page\s+(\d+)\s+rot:\s+(-?\d+)/.exec(line)
    if (rot) rotations.set(Number(rot[1]), Number(rot[2]))
  }
  const pages: { w: number; h: number }[] = []
  for (let page = 1; sizes.has(page); page++) {
    const { w, h } = sizes.get(page)!
    const quarter = (((rotations.get(page) ?? 0) / 90) % 4 + 4) % 4
    pages.push(quarter % 2 === 1 ? { w: h, h: w } : { w, h })
  }
  if (pages.length === 0 || pages.length !== sizes.size) throw new Error('pdfinfo returned no page sizes')
  return pages
}

// 縮小画像を、幅・高さ SHEET_MAX までのシートに、左上から行ごとに並べる。行の高さはその行でいちばん高い画像
export function packSheets(sizes: { w: number; h: number }[], max = SHEET_MAX): Pick<PdfPreviewManifest, 'sheets' | 'thumbs'> {
  const sheets: PdfPreviewManifest['sheets'] = []
  const thumbs: PdfPreviewManifest['thumbs'] = []
  let x = 0
  let y = 0
  let rowHeight = 0
  for (const { w, h } of sizes) {
    if (sheets.length === 0) sheets.push({ width: 0, height: 0 })
    if (x > 0 && x + w > max) {
      y += rowHeight
      x = 0
      rowHeight = 0
    }
    if (y > 0 && y + h > max) {
      sheets.push({ width: 0, height: 0 })
      x = 0
      y = 0
      rowHeight = 0
    }
    const sheet = sheets.length - 1
    thumbs.push({ sheet, x, y, w, h })
    x += w
    rowHeight = Math.max(rowHeight, h)
    sheets[sheet] = { width: Math.max(sheets[sheet].width, x), height: Math.max(sheets[sheet].height, y + h) }
  }
  return { sheets, thumbs }
}

function sendJson(res: ServerResponse, status: number, body: unknown, cache?: string): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...(cache ? { 'cache-control': cache } : {}) })
  res.end(JSON.stringify(body))
}
