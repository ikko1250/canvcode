import { readFile, readdir, stat, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { zipSync } from 'fflate'
import { chromium, type Browser, type Page } from 'playwright'
import { assignSlideNames, lintDeck, lintSlide, normalizeDeckData, parseMarkdownDeck, pickAdjust, serializeDeck, slideKey, slideLabel } from '@canvcode/slides'
import type { DeckData, RenderSlideData, SlideData } from '@canvcode/slides'
import { SLIDE_HEIGHT, SLIDE_WIDTH } from '@canvcode/slides/core/slide-layout-spec'
import { FileStore, HttpError, type FileInfo } from './files.ts'

const MAX_DECK_BYTES = 10 * 1024 * 1024
const MAX_JSON_REQUEST_BYTES = 24 * 1024 * 1024
const MAX_ASSET_BYTES = 20 * 1024 * 1024
// 開発時の Vite（apps/web/vite.config.ts の port、strictPort）。出力時はここからプレビューを開く
const DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1):5173$/
const CHROMIUM_MISSING = 'PDF / PNG の出力とキャンバスのスライド画像には Chromium が必要です。サーバーで `npx playwright install chromium` を実行してください。'
// キャンバスに並べるスライドの画像（.canvcode/slide-pages/<ハッシュ>.png）。描き方を変えたら版を上げて作り直させる
const PAGE_RENDER_VERSION = '2'
const PAGE_HASH = /^[a-f0-9]{32}$/
// キャンバスの画像の横幅（画素）。1920×1080 のスライドを縮めて撮る
const PAGE_IMAGE_WIDTH = 1280
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
  // Chromium を同時にいくつも起動しないよう、出力は 1 件ずつ順に行う
  private exportQueue: Promise<unknown> = Promise.resolve()
  private readonly pagesDir: string
  // デッキごとの、スライドの画像を作る処理（1 デッキに 1 つだけ）と、最後に失敗した理由。
  // 失敗したときと同じ画像を頼まれても作り直さない（Chromium が無いときに、読み直しのたびに起動し直さないように）
  private readonly pageJobs = new Map<string, Promise<void>>()
  private readonly pageErrors = new Map<string, { message: string; hashes: string }>()

  constructor(files: FileStore, workspace: string, port: number, dataDir: string) {
    this.files = files
    this.workspace = workspace
    this.port = port
    this.pagesDir = join(dataDir, 'slide-pages')
  }

  async handle(req: IncomingMessage, res: ServerResponse, pathname: string, search: URLSearchParams): Promise<boolean> {
    const parts = pathname.split('/').filter(Boolean)
    if (parts[0] === 'api' && parts[1] === 'slide-pages' && parts.length === 3 && req.method === 'GET') {
      await this.sendPage(res, parts[2] ?? '')
      return true
    }
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
        const initial: DeckData = assignSlideNames({ slides: [{ layout: 'title', title: 'タイトル' }] })
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
        let target = deck
        let didRewrite = false
        if (assetNames.size > 0) {
          // ブラウザで選んだ画像はファイル名しか分からないので、ファイル名で対応付ける。
          // 同じファイル名を別の場所から参照していると、どれに当たるか決められないので断る
          const referenced = new Map<string, Set<string>>()
          for (const slide of deck.slides) {
            for (const path of [slide.image?.path, ...(slide.images ?? []).map((image) => image.path)]) {
              if (path === undefined) continue
              const sourceName = basenameOf(path)
              if (!assetNames.has(sourceName)) continue
              const paths = referenced.get(sourceName) ?? new Set<string>()
              paths.add(path.replaceAll('\\', '/'))
              referenced.set(sourceName, paths)
            }
          }
          for (const [sourceName, paths] of referenced) {
            if (paths.size > 1) throw new HttpError(400, `${sourceName} が複数の場所から参照されています（${[...paths].join(', ')}）。画像の名前を変えてから読み込んでください`)
          }
          const rewritten: DeckData = {
            ...deck,
            slides: deck.slides.map((slide) => {
              const imagePath = (path: string) => {
                const sourceName = basenameOf(path)
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
          if (didRewrite) target = rewritten
        }
        // スライドに id を振って保存する。Markdown で書き戻せない内容なら、元の文字のまま取り込む（id はあとで保存したときに振る）
        const named = assignSlideNames(target)
        if (named !== target || didRewrite) {
          const fileName = format === 'json' ? 'deck.slide.json' : 'deck.slide.md'
          try {
            content = serializeDeck(named, fileName)
          } catch (error) {
            if (!didRewrite) content = body.text
            else throw new HttpError(400, `画像のパスを書き換えて保存できません: ${errorMessage(error)}`)
          }
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
          // id（name）の無いスライドには id を振る（エディタは振ってから送るので、API を直接使ったときの保険）
          text = serializeDeck(assignSlideNames(normalizeDeckData(body.deck, info.path)), info.path)
        } catch (error) {
          throw new HttpError(400, errorMessage(error))
        }
        if (Buffer.byteLength(text, 'utf8') > MAX_DECK_BYTES) throw new HttpError(413, '保存後のデッキファイルが大きすぎます')
        const saved = await this.files.write(info.id, text, current.hash)
        const deck = parseDeck(saved, text)
        sendJson(res, 200, { mtimeMs: saved.mtime, text, warnings: lintDeck(deck).warnings })
        // 開いているキャンバスに知らせ、スライドの画像を先に作り始める
        this.files.announce(saved.id)
        void this.pages(saved, previewBaseOf(req, this.port)).catch((error: unknown) => console.error('slide pages failed', error))
      } else if (parts.length === 4 && parts[3] === 'pages' && req.method === 'GET') {
        const info = this.requireDeck(decodePart(parts[2]))
        sendJson(res, 200, await this.pages(info, previewBaseOf(req, this.port)))
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
        const previewBase = previewBaseOf(req, this.port)
        const format = body.format
        const run = this.exportQueue.then(() => this.export(info, format, body.scale, previewBase))
        this.exportQueue = run.catch(() => {})
        const result = await run
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

  // ---- AI（MCP）から使う操作 ----

  // デッキを読み、構造と lint の警告を添える。読めないデッキは error に理由を入れる
  async inspectDeck(id: string): Promise<{ info: FileInfo; text: string; hash: string; deck?: DeckData; warnings: string[]; error?: string }> {
    const info = this.requireDeck(id)
    const { text, hash } = await this.files.read(info.id)
    try {
      const deck = parseDeck(info, text)
      return { info, text, hash, deck, warnings: lintDeck(deck).warnings }
    } catch (error) {
      return { info, text, hash, warnings: [], error: errorMessage(error) }
    }
  }

  // Markdown / JSON のデッキを検証して新しいファイルにする。読めないデッキは 400 で断る
  async createDeck(title: string, text: string, format: 'md' | 'json'): Promise<{ info: FileInfo; deck: DeckData; warnings: string[] }> {
    const extension = format === 'json' ? '.slide.json' : '.slide.md'
    const { content, deck } = prepareDeck(text, `deck${extension}`)
    const info = await this.files.create('slides', title.trim() || deck.deckTitle || '新しいデッキ', content, { extension, announce: true })
    this.renderPagesSoon(info)
    return { info, deck, warnings: lintDeck(deck).warnings }
  }

  // デッキの中身を丸ごと置き換える。expectedHash が今のハッシュと違えば 409。読めないデッキは 400 で断る
  async replaceDeck(id: string, text: string, expectedHash: string): Promise<{ info: FileInfo; deck: DeckData; warnings: string[] }> {
    const info = this.requireDeck(id)
    const { content, deck } = prepareDeck(text, info.path)
    const saved = await this.files.write(info.id, content, expectedHash, { announce: true })
    this.renderPagesSoon(saved)
    return { info: saved, deck, warnings: lintDeck(deck).warnings }
  }

  // 書き込む前に、デッキとして読めるか確かめる（MCP の edit_document など、デッキを文字列として直すとき）
  checkDeckText(id: string, text: string): void {
    const info = this.requireDeck(id)
    try {
      parseDeck(info, text)
    } catch (error) {
      throw new HttpError(400, `デッキとして読めません: ${errorMessage(error)}`)
    }
  }

  // 保存したデッキのスライドの画像を先に作り始める（キャンバスの画像と、AI の確認用）
  renderPagesSoon(info: FileInfo): void {
    void this.pages(info, `http://127.0.0.1:${this.port}`).catch((error: unknown) => console.error('slide pages failed', error))
  }

  // スライドの画像（PNG）。indices は 0 始まり。キャンバスと同じ画像を使い、無ければ作るのを待つ
  async slideImages(id: string, indices?: number[]): Promise<{ images: { index: number; name?: string; title: string; png: Buffer }[]; warnings: string[] }> {
    const info = this.requireDeck(id)
    const deck = await this.readDeck(info)
    const wanted = indices ?? deck.slides.map((_, index) => index)
    for (const index of wanted) {
      if (!Number.isInteger(index) || index < 0 || index >= deck.slides.length) {
        throw new HttpError(400, `スライド ${index + 1} はありません（全 ${deck.slides.length} 枚）`)
      }
    }
    const previewBase = `http://127.0.0.1:${this.port}`
    let state = await this.pages(info, previewBase)
    // 作っている途中なら終わるのを待つ。待つ間に中身が変わると、もう一度作り始めるので、何度か見直す
    for (let round = 0; round < 3 && state.pending; round += 1) {
      await this.pageJobs.get(info.id)
      state = await this.pages(info, previewBase)
    }
    const images = []
    for (const index of wanted) {
      const page = state.pages[index]
      const slide = deck.slides[index]
      if (!page?.ready || !slide) throw new HttpError(503, state.error ?? `スライド ${index + 1} の画像を作れませんでした`)
      images.push({ index, ...(slide.name ? { name: slide.name } : {}), title: slide.title, png: await readFile(this.pagePath(page.hash)) })
    }
    return { images, warnings: lintDeck(deck).warnings }
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
    const deck = await this.readDeck(info)
    const warnings = lintDeck(deck).warnings
    const scale = Math.max(1, Math.min(4, Math.round(requestedScale ?? 1)))
    const { browser, page } = await openPreview(previewBase, format === 'png' ? scale : 1)
    try {
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
        files[`slide-${String(index + 1).padStart(2, '0')}.png`] = new Uint8Array(await screenshotSlide(page, slide))
      }
      const data = Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, bytes]))))
      return { data, name: `${safeFilename(info.title)}-png.zip`, warnings, elapsedMs: Date.now() - started }
    } finally {
      await browser.close()
    }
  }

  private async readDeck(info: FileInfo): Promise<DeckData> {
    const { text } = await this.files.read(info.id)
    try {
      return parseDeck(info, text)
    } catch (error) {
      throw new HttpError(400, `デッキを読み込めません: ${errorMessage(error)}`)
    }
  }

  // ---- キャンバスに並べるスライドの画像 ----

  // スライドごとの画像のハッシュと、できているか。できていない画像があれば、裏で作り始める（pending）
  private async pages(info: FileInfo, previewBase: string): Promise<{ pages: SlidePage[]; pending: boolean; error?: string }> {
    let deck: DeckData
    try {
      deck = await this.readDeck(info)
    } catch (error) {
      return { pages: [], pending: false, error: errorMessage(error) }
    }
    const entries = await Promise.all(deck.slides.map(async (slide, index) => {
      const key = slideKey(slide, index)
      try {
        const render = await this.toRenderSlide(info, slide, index)
        const hash = createHash('sha256').update(PAGE_RENDER_VERSION).update('\0').update(JSON.stringify(render)).digest('hex').slice(0, 32)
        const ready = await stat(this.pagePath(hash)).then((s) => s.isFile(), () => false)
        return { key, hash, ready, render }
      } catch (error) {
        // 画像が見つからないスライドなど。そのスライドだけ画像なしにする
        return { key, hash: '', ready: false, error: `${slideLabel(slide, index)}: ${errorMessage(error)}` }
      }
    }))
    const missing = entries.flatMap((entry) => (entry.render && !entry.ready ? [{ hash: entry.hash, render: entry.render }] : []))
    const failed = this.pageErrors.get(info.id)
    if (missing.length > 0 && failed?.hashes !== hashesOf(missing)) this.renderPages(info.id, missing, previewBase)
    const error = this.pageErrors.get(info.id)?.message ?? entries.find((entry) => entry.error)?.error
    return {
      pages: entries.map(({ key, hash, ready }) => ({ key, hash, ready })),
      pending: this.pageJobs.has(info.id),
      ...(error ? { error } : {}),
    }
  }

  // 足りない画像を作る。Chromium は出力と同じ列に並べ、1 つずつ起動する
  private renderPages(fileId: string, items: { hash: string; render: RenderSlideData }[], previewBase: string): void {
    if (this.pageJobs.has(fileId)) return
    const job = this.exportQueue
      .then(async () => {
        await mkdir(this.pagesDir, { recursive: true })
        const { browser, page } = await openPreview(previewBase, PAGE_IMAGE_WIDTH / SLIDE_WIDTH)
        try {
          for (const item of items) {
            const path = this.pagePath(item.hash)
            if (await stat(path).then(() => true, () => false)) continue
            const png = await screenshotSlide(page, item.render)
            const temporary = `${path}.${randomUUID()}.tmp`
            await writeFile(temporary, png)
            await rename(temporary, path)
          }
        } finally {
          await browser.close()
        }
      })
      .then(
        () => { this.pageErrors.delete(fileId) },
        (error: unknown) => {
          this.pageErrors.set(fileId, { message: errorMessage(error), hashes: hashesOf(items) })
          console.error('slide page rendering failed', fileId, error)
        },
      )
      .finally(() => this.pageJobs.delete(fileId))
    this.pageJobs.set(fileId, job)
    this.exportQueue = job
  }

  private pagePath(hash: string): string {
    return join(this.pagesDir, `${hash}.png`)
  }

  private async sendPage(res: ServerResponse, name: string): Promise<void> {
    const hash = name.endsWith('.png') ? name.slice(0, -4) : ''
    const data = PAGE_HASH.test(hash) ? await readFile(this.pagePath(hash)).catch(() => null) : null
    if (!data) {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    // 中身はハッシュで決まるので、ずっとキャッシュしてよい
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': data.length, 'cache-control': 'public, max-age=31536000, immutable' })
    res.end(data)
  }

  private async toRenderSlide(info: FileInfo, slide: SlideData, index: number): Promise<RenderSlideData> {
    const result = { ...slide } as unknown as Record<string, unknown>
    if (slide.image) {
      const image = slide.image
      result.image = { src: await this.imageDataUrl(info, image.path), alt: image.alt, ...pickAdjust(image) }
    }
    if (slide.images) {
      result.images = await Promise.all(slide.images.map(async (image) => ({ src: await this.imageDataUrl(info, image.path), alt: image.alt, title: image.title, ...pickAdjust(image) })))
    }
    const lint = lintSlide(slide, index)
    if (lint.computedRowHeights) result.computedRowHeights = lint.computedRowHeights
    if (lint.computedFullPanel) result.computedFullPanel = true
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

type SlidePage = { key: string; hash: string; ready: boolean }

function hashesOf(items: { hash: string }[]): string {
  return items.map((item) => item.hash).join(',')
}

// 外から渡されたデッキの文字列を検証し、id の無いスライドに id を振って書き出す。
// 振った id を書き戻せない（Markdown で表せない）内容なら、元の文字のまま保存する（読み込みと同じ）
function prepareDeck(text: string, fileName: string): { content: string; deck: DeckData } {
  if (Buffer.byteLength(text, 'utf8') > MAX_DECK_BYTES) throw new HttpError(413, 'デッキファイルが大きすぎます')
  let deck: DeckData
  try {
    deck = normalizeDeckData(fileName.toLowerCase().endsWith('.json') ? JSON.parse(text) : parseMarkdownDeck(text, fileName), fileName)
  } catch (error) {
    throw new HttpError(400, `デッキとして読めません: ${errorMessage(error)}`)
  }
  const named = assignSlideNames(deck)
  if (named === deck) return { content: text, deck }
  try {
    return { content: serializeDeck(named, fileName), deck: named }
  } catch {
    return { content: text, deck }
  }
}

function parseDeck(info: FileInfo, text: string): DeckData {
  return normalizeDeckData(formatOf(info) === 'json' ? JSON.parse(text) : parseMarkdownDeck(text, info.path), info.path)
}

// プレビューのページは、このサーバーか開発時の Vite からだけ開く（ほかの localhost のページにデッキの画像を渡さない）
function previewBaseOf(req: IncomingMessage, port: number): string {
  const origin = req.headers.origin
  return typeof origin === 'string' && DEV_ORIGIN.test(origin) ? origin : `http://127.0.0.1:${port}`
}

async function openPreview(previewBase: string, deviceScaleFactor: number): Promise<{ browser: Browser; page: Page }> {
  const previewUrl = new URL('/slides-preview.html', previewBase)
  previewUrl.hostname = '127.0.0.1'
  // CANVCODE_CHROMIUM：Playwright が入れたものの代わりに使う Chromium（Chrome）の実行ファイル
  const executablePath = process.env.CANVCODE_CHROMIUM || undefined
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }).catch((error: unknown) => {
    if (errorMessage(error).includes("Executable doesn't exist")) throw new HttpError(503, CHROMIUM_MISSING)
    throw error
  })
  try {
    const page = await browser.newPage({ viewport: { width: SLIDE_WIDTH, height: SLIDE_HEIGHT }, deviceScaleFactor })
    await page.goto(previewUrl.toString(), { waitUntil: 'networkidle' })
    return { browser, page }
  } catch (error) {
    await browser.close()
    throw error
  }
}

// 1 枚を描いて、スライドの部分だけを PNG に撮る
async function screenshotSlide(page: Page, slide: RenderSlideData): Promise<Buffer> {
  await page.evaluate(async (data) => {
    const view = window as Window & { renderSlide?: (value: unknown) => Promise<{ ok: boolean; message?: string }>; setExportMode?: (enabled: boolean) => void }
    if (!view.renderSlide || !view.setExportMode) throw new Error('スライド描画機能を読み込めませんでした')
    const result = await view.renderSlide(data)
    if (!result.ok) throw new Error(result.message ?? 'スライドを描画できませんでした')
    await document.fonts.ready
    view.setExportMode(true)
    return true
  }, slide).catch((error: unknown) => { throw new HttpError(400, errorMessage(error)) })
  return page.locator('#slide').screenshot({ type: 'png' })
}

function formatOf(file: FileInfo): 'md' | 'json' {
  return file.path.toLowerCase().endsWith('.json') ? 'json' : 'md'
}

function basenameOf(path: string): string {
  return path.replaceAll('\\', '/').split('/').at(-1) ?? path
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
