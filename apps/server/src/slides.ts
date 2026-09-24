import { readFile, readdir, stat, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { zipSync } from 'fflate'
import { chromium } from 'playwright'
import { lintDeck, lintSlide, normalizeDeckData, parseMarkdownDeck, serializeDeck } from '@canvcode/slides'
import type { DeckData, RenderSlideData, SlideData } from '@canvcode/slides'
import { SLIDE_HEIGHT, SLIDE_WIDTH } from '@canvcode/slides/core/slide-layout-spec'
import { FileStore, HttpError, type FileInfo } from './files.ts'

const MAX_DECK_BYTES = 10 * 1024 * 1024
const MAX_JSON_REQUEST_BYTES = 24 * 1024 * 1024
const MAX_ASSET_BYTES = 20 * 1024 * 1024
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

export class SlidesApi {
  // Node の型除去（strip-only）はコンストラクタ引数のプロパティ宣言を扱えないので、フィールドとして宣言する
  private readonly files: FileStore
  private readonly workspace: string
  private readonly port: number

  constructor(files: FileStore, workspace: string, port: number) {
    this.files = files
    this.workspace = workspace
    this.port = port
  }

  async handle(req: IncomingMessage, res: ServerResponse, pathname: string, search: URLSearchParams): Promise<boolean> {
    const parts = pathname.split('/').filter(Boolean)
    if (parts[0] !== 'api' || parts[1] !== 'slides') return false
    try {
      if (parts.length === 2 && req.method === 'GET') {
        const decks = this.files.list().filter((file) => file.kind === 'slides' && !file.missing).map((file) => ({
          file: file.id,
          format: formatOf(file),
          mtimeMs: file.mtime,
          size: file.size,
          title: file.title,
        }))
        sendJson(res, 200, { decks })
      } else if (parts.length === 2 && req.method === 'POST') {
        const body = await jsonBody<{ file?: string }>(req)
        if (body.file !== undefined && typeof body.file !== 'string') throw new HttpError(400, 'ファイル名が不正です')
        const requested = (body.file ?? 'new-deck.md').trim()
        if (!requested || requested.includes('/') || requested.includes('\\')) throw new HttpError(400, 'ファイル名を指定してください')
        const format = requested.toLowerCase().endsWith('.json') ? 'json' : 'md'
        const title = requested.replace(/\.slide\.(?:md|json)$/i, '').replace(/\.(?:md|json)$/i, '')
        const extension = format === 'json' ? '.slide.json' : '.slide.md'
        const initial: DeckData = { slides: [{ layout: 'title', title: 'タイトル' }] }
        const content = serializeDeck(initial, `new.slide.${format}`)
        const file = await this.files.create('slides', title || '新しいデッキ', content, { extension, announce: true })
        sendJson(res, 201, { file: file.id, format, mtimeMs: file.mtime })
      } else if (parts.length === 3 && parts[2] === 'import' && req.method === 'POST') {
        const body = await jsonBody<{ fileName?: string; text?: string; assets?: { sourceName: string; name: string }[] }>(req)
        if (body.fileName !== undefined && typeof body.fileName !== 'string') throw new HttpError(400, 'ファイル名が不正です')
        if (body.assets !== undefined && !Array.isArray(body.assets)) throw new HttpError(400, '画像一覧が不正です')
        const name = (body.fileName ?? '').trim()
        if (!name || name.includes('/') || name.includes('\\') || !/\.(?:slide\.)?(?:md|json)$/i.test(name)) {
          throw new HttpError(400, 'Markdown または JSON のデッキファイルを指定してください')
        }
        if (typeof body.text !== 'string' || !body.text.trim()) throw new HttpError(400, 'デッキの内容がありません')
        if (Buffer.byteLength(body.text, 'utf8') > MAX_DECK_BYTES) throw new HttpError(413, 'デッキファイルが大きすぎます')
        const format = name.toLowerCase().endsWith('.json') ? 'json' : 'md'
        let deck: DeckData
        try {
          deck = normalizeDeckData(format === 'json' ? JSON.parse(body.text) : parseMarkdownDeck(body.text, name), name)
        } catch (error) {
          throw new HttpError(400, `デッキを読み込めません: ${errorMessage(error)}`)
        }
        const assetNames = new Map<string, string>()
        for (const asset of body.assets ?? []) {
          if (!asset || typeof asset.sourceName !== 'string' || typeof asset.name !== 'string' ||
            !/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,78}[A-Za-z0-9])?\.(?:png|jpe?g|webp|svg)$/i.test(asset.name)) {
            throw new HttpError(400, '取り込む画像名が不正です')
          }
          assetNames.set(asset.sourceName, asset.name)
        }
        let content = body.text
        if (assetNames.size > 0) {
          let didRewrite = false
          const rewritten: DeckData = {
            ...deck,
            slides: deck.slides.map((slide) => {
              const imagePath = (path: string) => {
                const sourceName = path.replaceAll('\\', '/').split('/').at(-1) ?? path
                const targetName = assetNames.get(sourceName)
                if (targetName) didRewrite = true
                return targetName ? `assets/${targetName}` : path
              }
              return {
                ...slide,
                ...(slide.image ? { image: { ...slide.image, path: imagePath(slide.image.path) } } : {}),
                ...(slide.images ? { images: slide.images.map((image) => ({ ...image, path: imagePath(image.path) })) } : {}),
              }
            }),
          }
          if (didRewrite) content = serializeDeck(rewritten, format === 'json' ? 'deck.slide.json' : 'deck.slide.md')
        }
        const title = name.replace(/\.slide\.(?:md|json)$/i, '').replace(/\.(?:md|json)$/i, '')
        const extension = format === 'json' ? '.slide.json' : '.slide.md'
        const file = await this.files.create('slides', title || deck.deckTitle || 'インポート', content, { extension, announce: true })
        sendJson(res, 201, { file: file.id, format, mtimeMs: file.mtime })
      } else if (parts.length === 3 && req.method === 'GET') {
        const info = this.requireDeck(decodePart(parts[2]))
        const { text } = await this.files.read(info.id)
        const format = formatOf(info)
        const eol = text.includes('\r\n') ? 'crlf' : 'lf'
        try {
          const parsed = format === 'json' ? JSON.parse(text) as unknown : parseMarkdownDeck(text, info.path)
          const deck = normalizeDeckData(parsed, info.path)
          const canonical = serializeDeck(deck, info.path) === text
          sendJson(res, 200, { file: info.id, format, raw: text, mtimeMs: info.mtime, eol, canonical, deck })
        } catch (error) {
          sendJson(res, 200, { file: info.id, format, raw: text, mtimeMs: info.mtime, eol, canonical: false, error: errorMessage(error) })
        }
      } else if (parts.length === 3 && req.method === 'PUT') {
        const info = this.requireDeck(decodePart(parts[2]))
        const body = await jsonBody<{ deck?: unknown; expectedMtimeMs?: number; force?: boolean }>(req)
        const current = await this.files.read(info.id)
        if (typeof body.expectedMtimeMs !== 'number') throw new HttpError(400, 'expectedMtimeMs is required')
        if (body.force !== undefined && typeof body.force !== 'boolean') throw new HttpError(400, 'force must be a boolean')
        if (!body.force && body.expectedMtimeMs !== info.mtime) {
          throw new HttpError(409, 'このファイルは外部で変更されています。最新の内容を読み直してください。', { mtimeMs: info.mtime })
        }
        let text: string
        try {
          text = serializeDeck(body.deck, info.path)
        } catch (error) {
          throw new HttpError(400, errorMessage(error))
        }
        if (Buffer.byteLength(text, 'utf8') > MAX_DECK_BYTES) throw new HttpError(413, '保存後のデッキファイルが大きすぎます')
        const saved = await this.files.write(info.id, text, current.hash)
        const deck = normalizeDeckData(formatOf(info) === 'json' ? JSON.parse(text) : parseMarkdownDeck(text, info.path), info.path)
        sendJson(res, 200, { mtimeMs: saved.mtime, text, warnings: lintDeck(deck).warnings })
      } else if (parts.length === 4 && parts[3] === 'assets' && req.method === 'GET') {
        const info = this.requireDeck(decodePart(parts[2]))
        sendJson(res, 200, { assets: await this.listAssets(info) })
      } else if (parts.length === 4 && parts[3] === 'assets' && req.method === 'PUT') {
        const info = this.requireDeck(decodePart(parts[2]))
        const name = search.get('name') ?? ''
        if (!/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,78}[A-Za-z0-9])?\.(?:png|jpe?g|webp|svg)$/i.test(name)) {
          throw new HttpError(400, '画像名は英数字・ハイフン・アンダースコアで指定してください')
        }
        const type = IMAGE_TYPES[extname(name).toLowerCase()]
        if (!type || (req.headers['content-type'] ?? '').split(';')[0] !== type) throw new HttpError(415, '画像形式と Content-Type が一致しません')
        const data = await readBody(req, MAX_ASSET_BYTES)
        if (data.length === 0) throw new HttpError(400, '空の画像ファイルです')
        const assetsDir = this.files.resolveWorkspacePath('assets')
        await mkdir(assetsDir, { recursive: true })
        const { realpath } = await import('node:fs/promises')
        const realAssetsDir = await realpath(assetsDir)
        if (!inside(await this.realWorkspace(), realAssetsDir)) throw new HttpError(400, 'assets フォルダはワークスペース内に置いてください')
        const destination = join(realAssetsDir, name)
        if (search.get('overwrite') !== '1') {
          try { await stat(destination); throw new HttpError(409, `${name} は既にあります`) } catch (error) {
            if (error instanceof HttpError) throw error
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
        const temporary = join(realAssetsDir, `.${name}.${randomUUID()}.tmp`)
        await writeFile(temporary, data, { flag: 'wx' })
        try {
          await rename(temporary, destination)
        } catch (error) {
          await unlink(temporary).catch(() => {})
          throw error
        }
        const filePath = relative(this.files.resolveWorkspacePath('.'), join(assetsDir, name)).split(sep).join('/')
        const path = relative(dirname(info.path), filePath).split(sep).join('/')
        sendJson(res, 201, { name, path, size: data.length })
      } else if (parts.length === 4 && parts[3] === 'asset' && req.method === 'GET') {
        const info = this.requireDeck(decodePart(parts[2]))
        const assetPath = search.get('path') ?? ''
        const file = await this.resolveImage(info, assetPath)
        const data = await readFile(file)
        const type = IMAGE_TYPES[extname(file).toLowerCase()]
        if (!type) throw new HttpError(415, '未対応の画像形式です')
        res.writeHead(200, {
          'content-type': type,
          'content-length': data.length,
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
        })
        res.end(data)
      } else if (parts.length === 4 && parts[3] === 'export' && req.method === 'POST') {
        const info = this.requireDeck(decodePart(parts[2]))
        const body = await jsonBody<{ format?: 'pdf' | 'png'; scale?: number }>(req)
        if (body.format !== 'pdf' && body.format !== 'png') throw new HttpError(400, 'format は pdf または png を指定してください')
        if (body.scale !== undefined && (typeof body.scale !== 'number' || !Number.isFinite(body.scale))) throw new HttpError(400, 'scale は数値で指定してください')
        const origin = req.headers.origin
        const previewBase = typeof origin === 'string' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
          ? origin
          : `http://127.0.0.1:${this.port}`
        const result = await this.export(info, body.format, body.scale, previewBase)
        res.writeHead(200, {
          'content-type': body.format === 'pdf' ? 'application/pdf' : 'application/zip',
          'content-length': result.data.length,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.name)}`,
          'x-canvcode-export-name': encodeURIComponent(result.name),
          'x-canvcode-export-warnings': encodeURIComponent(JSON.stringify(result.warnings)),
          'x-canvcode-export-ms': String(result.elapsedMs),
        })
        res.end(result.data)
      } else {
        sendJson(res, 405, { error: 'method not allowed' })
      }
    } catch (error) {
      if (error instanceof HttpError) sendJson(res, error.status, { error: error.message, ...error.extra })
      else {
        console.error('slide request failed', error)
        sendJson(res, 500, { error: errorMessage(error) })
      }
    }
    return true
  }

  private requireDeck(id: string): FileInfo {
    const info = this.files.getInfo(id)
    if (info.kind !== 'slides' || info.missing) throw new HttpError(404, 'スライドデッキが見つかりません')
    return info
  }

  private async listAssets(info: FileInfo): Promise<{ name: string; path: string; size: number; mtimeMs: number }[]> {
    const root = this.files.resolveWorkspacePath('assets')
    const { realpath } = await import('node:fs/promises')
    const safeRoot = await realpath(root).catch(() => null)
    if (!safeRoot || !inside(await this.realWorkspace(), safeRoot)) return []
    const entries = await readdir(safeRoot, { withFileTypes: true }).catch(() => [])
    const output = []
    for (const entry of entries) {
      if (!entry.isFile() || !IMAGE_TYPES[extname(entry.name).toLowerCase()]) continue
      const absolute = join(safeRoot, entry.name)
      const metadata = await stat(absolute).catch(() => null)
      if (!metadata) continue
      const workspaceRelative = relative(this.workspace, absolute)
      output.push({ name: entry.name, path: relative(dirname(info.path), workspaceRelative).split(sep).join('/'), size: metadata.size, mtimeMs: metadata.mtimeMs })
    }
    return output.sort((a, b) => a.name.localeCompare(b.name))
  }

  private async resolveImage(info: FileInfo, assetPath: string): Promise<string> {
    if (!assetPath || assetPath.includes('\0') || isAbsolute(assetPath) || /^[a-z][a-z0-9+.-]*:/i.test(assetPath)) throw new HttpError(400, '画像パスが不正です')
    // info.path はワークスペースからの相対パス。resolve() だとプロセスのカレントディレクトリが基準になるので、相対のまま join する
    const candidate = this.files.resolveWorkspacePath(join(dirname(info.path), assetPath))
    if (!inside(this.files.resolveWorkspacePath('.'), candidate)) throw new HttpError(400, 'ワークスペース外の画像は使えません')
    if (!IMAGE_TYPES[extname(candidate).toLowerCase()]) throw new HttpError(415, '未対応の画像形式です')
    const { realpath } = await import('node:fs/promises')
    const actual = await realpath(candidate).catch(() => { throw new HttpError(404, '画像ファイルが見つかりません') })
    if (!inside(await this.realWorkspace(), actual)) throw new HttpError(400, 'ワークスペース外の画像は使えません')
    return actual
  }

  private async realWorkspace(): Promise<string> {
    const { realpath } = await import('node:fs/promises')
    return realpath(this.workspace)
  }

  private async export(info: FileInfo, format: 'pdf' | 'png', requestedScale: number | undefined, previewBase: string): Promise<{ data: Buffer; name: string; warnings: string[]; elapsedMs: number }> {
    const started = Date.now()
    const { text } = await this.files.read(info.id)
    let deck: DeckData
    try {
      deck = normalizeDeckData(formatOf(info) === 'json' ? JSON.parse(text) : parseMarkdownDeck(text, info.path), info.path)
    } catch (error) {
      throw new HttpError(400, `デッキを読み込めません: ${errorMessage(error)}`)
    }
    const warnings = lintDeck(deck).warnings
    const previewUrl = new URL('/slides-preview.html', previewBase)
    previewUrl.hostname = '127.0.0.1'
    const browser = await chromium.launch({ headless: true })
    try {
      const scale = Math.max(1, Math.min(4, Math.round(requestedScale ?? 1)))
      const page = await browser.newPage({ viewport: { width: SLIDE_WIDTH, height: SLIDE_HEIGHT }, deviceScaleFactor: format === 'png' ? scale : 1 })
      await page.goto(previewUrl.toString(), { waitUntil: 'networkidle' })
      const rendered: RenderSlideData[] = await Promise.all(deck.slides.map((slide, index) => this.toRenderSlide(info, slide, index)))
      if (format === 'pdf') {
        await page.evaluate(async (slides) => {
          const view = window as Window & { renderDeck?: (value: unknown) => Promise<{ ok: boolean; message?: string }>; setDeckExportMode?: (enabled: boolean) => void }
          if (!view.renderDeck || !view.setDeckExportMode) throw new Error('スライド描画機能を読み込めませんでした')
          const outcome = await view.renderDeck(slides)
          if (!outcome.ok) throw new Error(outcome.message ?? 'スライドを描画できませんでした')
          await document.fonts.ready
          view.setDeckExportMode(true)
          return true
        }, rendered).catch((error: unknown) => { throw new HttpError(400, errorMessage(error)) })
        await page.emulateMedia({ media: 'print' })
        const data = Buffer.from(await page.pdf({ printBackground: true, preferCSSPageSize: true }))
        return { data, name: `${safeFilename(info.title)}.pdf`, warnings, elapsedMs: Date.now() - started }
      }
      const files: Record<string, Uint8Array> = {}
      for (let index = 0; index < rendered.length; index += 1) {
        const slide = rendered[index]
        if (!slide) continue
        const outcome = await page.evaluate(async (data) => {
          const view = window as Window & { renderSlide?: (value: unknown) => Promise<{ ok: boolean; message?: string }>; setExportMode?: (enabled: boolean) => void }
          if (!view.renderSlide || !view.setExportMode) throw new Error('スライド描画機能を読み込めませんでした')
          const result = await view.renderSlide(data)
          if (!result.ok) throw new Error(result.message ?? 'スライドを描画できませんでした')
          await document.fonts.ready
          view.setExportMode(true)
          return true
        }, slide).catch((error: unknown) => { throw new HttpError(400, errorMessage(error)) })
        void outcome
        const png = await page.locator('#slide').screenshot({ type: 'png' })
        files[`slide-${String(index + 1).padStart(2, '0')}.png`] = new Uint8Array(png)
      }
      const data = Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, bytes]))))
      return { data, name: `${safeFilename(info.title)}-png.zip`, warnings, elapsedMs: Date.now() - started }
    } finally {
      await browser.close()
    }
  }

  private async toRenderSlide(info: FileInfo, slide: SlideData, index: number): Promise<RenderSlideData> {
    const result = { ...slide } as unknown as Record<string, unknown>
    if (slide.image) {
      const image = slide.image as { path: string; alt: string }
      result.image = { src: await this.imageDataUrl(info, image.path), alt: image.alt }
    }
    if (slide.images) {
      result.images = await Promise.all(slide.images.map(async (image) => ({ src: await this.imageDataUrl(info, image.path), alt: image.alt, title: image.title })))
    }
    const rowHeights = lintSlide(slide, index).computedRowHeights
    if (rowHeights) result.computedRowHeights = rowHeights
    return result as unknown as RenderSlideData
  }

  private async imageDataUrl(info: FileInfo, assetPath: string): Promise<string> {
    const path = await this.resolveImage(info, assetPath)
    const data = await readFile(path)
    if (data.length > MAX_ASSET_BYTES) throw new HttpError(413, `画像が大きすぎます: ${assetPath}`)
    const type = IMAGE_TYPES[extname(path).toLowerCase()]
    return `data:${type};base64,${data.toString('base64')}`
  }
}

function formatOf(file: FileInfo): 'md' | 'json' {
  return file.path.toLowerCase().endsWith('.json') ? 'json' : 'md'
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep)
}

function safeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim() || 'slides'
}

function decodePart(value: string): string {
  try { return decodeURIComponent(value) } catch { return value }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function jsonBody<T>(req: IncomingMessage): Promise<T> {
  let data: Buffer
  try { data = await readBody(req, MAX_JSON_REQUEST_BYTES) } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'リクエスト本文を読み込めません')
  }
  try {
    const value: unknown = JSON.parse(data.toString('utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'JSON オブジェクトを指定してください')
    return value as T
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'JSON が不正です')
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const bytes = chunk as Buffer
    total += bytes.length
    if (total > limit) throw new HttpError(413, 'ファイルが大きすぎます')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
