import { assetIdFromHash, type AssetRecord } from '@canvcode/core'
import { IMAGE_VARIANT_SIZES, PDF_POINT_SCALE, scaledSize, type AssetResolver, type RasterImage } from '@canvcode/nodes'
import type { PdfTextItem } from './quotes.ts'
import type { PdfSearchResponse } from './pdfSearch.ts'
import { indexedDbPdfPageBackend, pdfPageKey, PdfPageStore } from './pdfPageStore.ts'
import { sha256HexSync } from './sha256.ts'

// 画像の Asset の取り込み・アップロード・読み込み（MAI-10、MAI-14、MAI-26）。
// - 取り込むとき、ブラウザで中身の SHA-256 と縮小版（長辺 256px・1024px）を作り、すぐに使えるようにしてから、
//   裏でサーバーへアップロードする（ノードはアップロードを待たずに置ける）
// - アップロードが済むまでは手元の Blob から、済んだらサーバーから読む
// - レコードはサーバーの <ハッシュ>.json が正本。画面を開いたときに一覧（GET /api/assets）を読む（段階 11）
// - PDF のページは、サーバーが前もって作った画像（長辺 256px のシートと 1024px のページごと。Issue #26）があれば、それも出す
//   （pdfPreviewLevels・loadPdfPreview）。PDF.js で描いた level 1 以上の画像は、読んでいたページの分をブラウザに置いておき
//   （rememberPdfPage・pdfPageStore.ts）、次に同じ解像度を頼まれたら PDF を開かずにそれを返す

export interface AssetManagerOptions {
  // API の場所（既定は /api/assets）
  baseUrl?: string
  // アップロードに失敗したときなどに、画面に知らせる
  notify?: (message: string) => void
  // PDF を開いて描く先（PDF.js。Vite の機能で Worker を読み込むので、アプリ側から渡す。MAI-32）
  pdf?: PdfService
  // 最後に見た PDF のページの画像を置いておく先。既定は IndexedDB（使えなければ置かない）。null なら置かない
  pageStore?: PdfPageStore | null
}

// PDF のページの、サーバーが前もって作った画像の一覧（GET /api/assets/<ハッシュ>/preview。apps/server/src/pdfPreview.ts）
export interface PdfPreviewManifest {
  version: number
  // ページの大きさ（ポイント、回転したあと）
  pages: { w: number; h: number }[]
  sheets: { width: number; height: number }[]
  // 縮小画像の、シートの中の位置（ページの順）
  thumbs: { sheet: number; x: number; y: number; w: number; h: number }[]
  // 長辺 size 画素のページごとの画像があれば付く
  mid?: { size: number }
  // ページごとの画像をまだ作っているところなら付く（できたら付かなくなる）
  pending?: boolean
  // 作るたびに変わる印。画像の URL に付ける（作り直したあとに、キャッシュした古いシートを切り出さない）
  rev?: string
}

// PDF を開いて描く（MAI-5、MAI-32）。大きさはポイント（1/72 インチ）
export interface PdfDocument {
  numPages: number
  pageSize(pageIndex: number): Promise<{ width: number; height: number }>
  // 1 ポイントあたり scale 画素で描く
  render(pageIndex: number, scale: number): Promise<ImageBitmap>
  // ページの文字の断片（位置はポイント、ページの左上が原点。引用に使う。MAI-33）
  textItems(pageIndex: number): Promise<PdfTextItem[]>
  // 閉じて、解析した中身（Worker の側も含む）を捨てる。閉じたあとは使わない（MAI-66）
  destroy(): Promise<void>
}

export interface PdfService {
  open(source: { data: ArrayBuffer } | { url: string }): Promise<PdfDocument>
}

export function isPdf(file: Blob & { name?: string }): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name ?? '')
}

// PDF のページを描くときの、1 辺と画素数の上限（大きすぎる画像を作らないように）
const PDF_MAX_SIDE = 8192
const PDF_MAX_PIXELS = 32 * 1024 * 1024
// 同時に開いておく PDF の数（MAI-66）。1 つの Canvas に並ぶのはふつう 1 つの PDF のページなので、少し余裕を持たせる
const MAX_OPEN_PDFS = 3
// サーバーにまだない（作っている途中・作れない）前もって作った画像を、確かめ直すまでの時間
const PREVIEW_RETRY_MS = 60_000
// 読んでおく縮小画像のシートの数（RESONAC の 1 枚は、展開して 13 MB）
const MAX_PREVIEW_SHEETS = 2
// ブラウザに置いておくページの画像の画質
const STORED_PAGE_QUALITY = 0.92

interface PdfPreviewState {
  manifest: PdfPreviewManifest | null
  // サーバーが作れない（poppler がない・壊れた PDF）と答えた。聞き直さない
  unavailable: boolean
  // 最後に確かめ終えた時刻。まだ一度も確かめ終えていなければ null
  checkedAt: number | null
  loading: Promise<void> | null
}

// 取り込める画像の種類。SVG は中にスクリプトを持てるので、初版では受け付けない
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']

export function isSupportedImage(file: Blob): boolean {
  return IMAGE_MIME_TYPES.includes(file.type)
}

// サーバーが原本を保存するときの拡張子（apps/server/src/assets.ts の ORIGINAL_TYPES と同じ）
const ORIGINAL_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
}

// 画像の Asset を Markdown から指す画像のリンク。原本はワークスペースの .canvcode/assets/ にあるので、
// ルートからのパスで書けば、Markdown のカードも PDF の出力もそのまま読める（#33）。画像でなければ null
export function assetMarkdownImage(asset: AssetRecord): string | null {
  const ext = ORIGINAL_EXTENSIONS[asset.mime]
  return ext ? `![](/.canvcode/assets/${asset.hash}.${ext})` : null
}

export class AssetManager implements AssetResolver {
  private readonly records = new Map<string, AssetRecord>()
  // アップロードが済むまで持っておく手元の Blob（長辺の画素数 → Blob）
  private readonly local = new Map<string, Map<number, Blob>>()
  private readonly uploads = new Map<string, Promise<void>>()
  private readonly baseUrl: string
  private readonly notify: (message: string) => void
  private readonly pdf: PdfService | null
  // 開いている PDF。Map の順番は「最近使った順」。MAX_OPEN_PDFS を超えたら、使っていないものから閉じる（MAI-66）
  private readonly pdfDocuments = new Map<string, Promise<PdfDocument>>()
  // 使っている途中（描いている・文字を読んでいる）の数。0 でないものは閉じない
  private readonly pdfInUse = new Map<string, number>()
  // 前もって作った画像の一覧（Asset の id → 状態）と、読んだシート（`${ハッシュ}#${番号}` → 画像。最近使った順）
  private readonly previews = new Map<string, PdfPreviewState>()
  private readonly previewSheets = new Map<string, Promise<ImageBitmap>>()
  private readonly previewListeners = new Set<() => void>()
  private readonly pageStore: PdfPageStore | null
  // このタブでブラウザに置いた（置いてあると分かった）ページの画像のキー。同じものを 2 度書かない
  private readonly storedPages = new Set<string>()

  constructor(options: AssetManagerOptions = {}) {
    this.baseUrl = options.baseUrl ?? '/api/assets'
    this.notify = options.notify ?? ((message) => console.warn(message))
    this.pdf = options.pdf ?? null
    if (options.pageStore !== undefined) {
      this.pageStore = options.pageStore
    } else {
      const backend = indexedDbPdfPageBackend()
      this.pageStore = backend ? new PdfPageStore(backend) : null
    }
  }

  get canOpenPdf(): boolean {
    return this.pdf !== null
  }

  // PDF のファイルを Asset として取り込み、裏でアップロードを始める（MAI-32）。
  // 先に開いてみて、読めない（壊れている）PDF はアップロードしない
  async importPdf(file: Blob): Promise<AssetRecord> {
    if (!this.pdf) throw new Error('PDF is not available')
    const hash = await sha256Hex(file)
    const id = assetIdFromHash(hash)
    const existing = this.records.get(id)
    if (existing) return existing
    const opened = this.pdf.open({ data: await file.arrayBuffer() })
    await opened
    this.pdfDocuments.set(id, opened)
    const record: AssetRecord = { typeName: 'asset', id, mime: 'application/pdf', size: file.size, hash, width: 0, height: 0, variants: [] }
    this.records.set(id, record)
    this.local.set(id, new Map([[0, file]]))
    const upload = this.upload(record, new Map([[0, file]]))
      .then(() => {
        this.local.delete(id)
      })
      .catch((error: unknown) => {
        console.error('Failed to upload a PDF', id, error)
        this.notify('PDF をサーバーに保存できませんでした。このタブを閉じると、PDF は失われます。')
      })
      .finally(() => this.uploads.delete(id))
    this.uploads.set(id, upload)
    return record
  }

  // PDF を開いて task に渡す。開いた PDF は取っておき、次からはそれを使う。
  // アップロードが済むまでは手元のファイルから、済んだらサーバーから読む。
  // 開いている数が MAX_OPEN_PDFS を超えたら、使っていないものから閉じる（開いたままだと、Canvas を移るたびに
  // 数十 MB ずつ増えていた。MAI-66）。task の途中で閉じられることはない
  async withPdfDocument<T>(assetId: string, task: (doc: PdfDocument) => Promise<T>): Promise<T> {
    this.pdfInUse.set(assetId, (this.pdfInUse.get(assetId) ?? 0) + 1)
    try {
      return await task(await this.openPdf(assetId))
    } finally {
      const count = (this.pdfInUse.get(assetId) ?? 1) - 1
      if (count > 0) this.pdfInUse.set(assetId, count)
      else this.pdfInUse.delete(assetId)
      this.closeUnusedPdfs()
    }
  }

  private openPdf(assetId: string): Promise<PdfDocument> {
    let pending = this.pdfDocuments.get(assetId)
    if (pending) {
      // 最近使ったものとして、後ろに付け直す
      this.pdfDocuments.delete(assetId)
      this.pdfDocuments.set(assetId, pending)
      return pending
    }
    const pdf = this.pdf
    const record = this.records.get(assetId)
    if (!pdf || !record) return Promise.reject(new Error(`Cannot open the PDF: ${assetId}`))
    const local = this.local.get(assetId)?.get(0)
    pending = local ? local.arrayBuffer().then((data) => pdf.open({ data })) : pdf.open({ url: `${this.baseUrl}/${record.hash}` })
    const opened = pending
    opened.catch(() => {
      if (this.pdfDocuments.get(assetId) === opened) this.pdfDocuments.delete(assetId)
    })
    this.pdfDocuments.set(assetId, opened)
    return opened
  }

  private closeUnusedPdfs(): void {
    let excess = this.pdfDocuments.size - MAX_OPEN_PDFS
    for (const [assetId, pending] of this.pdfDocuments) {
      if (excess <= 0) return
      if (this.pdfInUse.has(assetId)) continue
      this.pdfDocuments.delete(assetId)
      excess--
      pending.then((doc) => doc.destroy()).catch((error: unknown) => console.warn('Failed to close a PDF', assetId, error))
    }
  }

  async renderPdfPage(assetId: string, pageIndex: number, scale: number): Promise<RasterImage> {
    // 前に読んでいたページなら、ブラウザに置いておいた画像を返す（PDF を開かない）
    const record = this.records.get(assetId)
    if (record && this.pageStore && scale >= 1) {
      const stored = await this.pageStore.load(record.hash, pageIndex, scale)
      if (stored) {
        try {
          const image = await createImageBitmap(stored.blob)
          this.storedPages.add(stored.key)
          return { image, width: image.width, height: image.height, level: scale }
        } catch (error) {
          console.warn('Failed to read a kept PDF page image', stored.key, error)
        }
      }
    }
    return this.withPdfDocument(assetId, async (doc) => {
      const size = await doc.pageSize(pageIndex)
      // ワールド座標の 1 単位あたり scale 画素 → ポイントあたりの画素。大きすぎるときは抑える
      let pointScale = scale * PDF_POINT_SCALE
      pointScale = Math.min(pointScale, PDF_MAX_SIDE / size.width, PDF_MAX_SIDE / size.height, Math.sqrt(PDF_MAX_PIXELS / (size.width * size.height)))
      const image = await doc.render(pageIndex, pointScale)
      return { image, width: image.width, height: image.height, level: scale }
    })
  }

  // PDF.js で描いたページの画像（level 1 以上）を、ブラウザに置いておく（読んでいるページ。View が頼む）。
  // このタブで置いたものは、もう一度は書かない
  async rememberPdfPage(assetId: string, pageIndex: number, raster: RasterImage): Promise<void> {
    const record = this.records.get(assetId)
    if (!record || !this.pageStore || raster.level < 1) return
    const key = pdfPageKey(record.hash, pageIndex, raster.level)
    if (this.storedPages.has(key)) return
    this.storedPages.add(key)
    const blob = await encodeImage(raster).catch(() => null)
    if (!blob) {
      this.storedPages.delete(key)
      return
    }
    await this.pageStore.save({ hash: record.hash, pageIndex, level: raster.level, width: raster.width, height: raster.height, blob })
  }

  // 前もって作った画像の解像度（renderPdfPage の scale と同じ単位）。小さい順。ないなら []、まだ確かめているところなら null。
  // 初めて聞かれたら、裏でサーバーに一覧を聞く。確かめ終えたら（変わったら）onPdfPreviewChange で知らせる。
  // サーバーにまだない（作っているところ）・段 2 を作っているところ（pending）なら、PREVIEW_RETRY_MS 経ったら聞き直す
  pdfPreviewLevels(assetId: string, pageIndex: number): number[] | null {
    const record = this.records.get(assetId)
    // Asset の一覧（loadList）を読み終えるまでは、PDF.js で描き始めないよう、確かめているところとして扱う
    if (!record) return null
    // アップロードが済むまでは、サーバーにはまだない
    if (record.mime !== 'application/pdf' || this.local.has(assetId) || typeof fetch === 'undefined') return []
    let state = this.previews.get(assetId)
    if (!state) {
      state = { manifest: null, unavailable: false, checkedAt: null, loading: null }
      this.previews.set(assetId, state)
      this.fetchPreview(record, state)
    } else if (!state.loading && !state.unavailable && (!state.manifest || state.manifest.pending) && state.checkedAt !== null && Date.now() - state.checkedAt >= PREVIEW_RETRY_MS) {
      this.fetchPreview(record, state)
    }
    if (state.checkedAt === null) return null
    return state.manifest ? previewLevels(state.manifest, pageIndex) : []
  }

  // 前もって作った画像があるかを確かめ終えるまで待つ（書き出しの前に。確かめている間は、ページを描かないので）
  async preparePdfPreview(assetId: string): Promise<void> {
    if (this.pdfPreviewLevels(assetId, 0) === null) await this.previews.get(assetId)?.loading
  }

  // 前もって作った画像の一覧が届いた・変わったときに呼ぶ関数を登録する。戻り値で外す
  onPdfPreviewChange(listener: () => void): () => void {
    this.previewListeners.add(listener)
    return () => this.previewListeners.delete(listener)
  }

  async loadPdfPreview(assetId: string, pageIndex: number, level: number): Promise<RasterImage> {
    const record = this.records.get(assetId)
    const manifest = this.previews.get(assetId)?.manifest
    const thumb = manifest?.thumbs[pageIndex]
    if (!record || !manifest || !thumb) throw new Error(`No preview of the PDF page: ${assetId}#${pageIndex}`)
    let image: ImageBitmap
    if (manifest.mid && level === previewLevels(manifest, pageIndex)[1]) {
      const response = await fetch(`${this.baseUrl}/${record.hash}/preview/v${manifest.version}/page/${pageIndex}${revQuery(manifest)}`)
      if (!response.ok) throw new Error(`Failed to load the preview of ${assetId}#${pageIndex}: ${response.status}`)
      image = await createImageBitmap(await response.blob())
    } else {
      const sheet = await this.previewSheet(record.hash, manifest, thumb.sheet)
      image = await createImageBitmap(sheet, thumb.x, thumb.y, thumb.w, thumb.h)
    }
    return { image, width: image.width, height: image.height, level }
  }

  private fetchPreview(record: AssetRecord, state: PdfPreviewState): void {
    state.loading = (async () => {
      const before = state.manifest
      try {
        const response = await fetch(`${this.baseUrl}/${record.hash}/preview`)
        // 404 は、まだ作っていない（pending）・作れない（unavailable）
        if (response.ok) state.manifest = (await response.json()) as PdfPreviewManifest
        else if (response.status === 404) state.unavailable = ((await response.json().catch(() => null)) as { status?: string } | null)?.status === 'unavailable'
      } catch (error) {
        console.warn('Failed to read the preview of a PDF', record.id, error)
      }
      const first = state.checkedAt === null
      state.checkedAt = Date.now()
      state.loading = null
      if (first || state.manifest !== before) for (const listener of this.previewListeners) listener()
    })()
  }

  // 縮小画像のシートを読む。最近使った MAX_PREVIEW_SHEETS 枚まで持っておく
  private previewSheet(hash: string, manifest: PdfPreviewManifest, index: number): Promise<ImageBitmap> {
    const key = `${hash}#${manifest.version}#${manifest.rev ?? ''}#${index}`
    let pending = this.previewSheets.get(key)
    if (pending) {
      this.previewSheets.delete(key)
      this.previewSheets.set(key, pending)
      return pending
    }
    pending = fetch(`${this.baseUrl}/${hash}/preview/v${manifest.version}/sheet/${index}${revQuery(manifest)}`).then(async (response) => {
      if (!response.ok) throw new Error(`Failed to load a preview sheet of ${hash}: ${response.status}`)
      return createImageBitmap(await response.blob())
    })
    const loading = pending
    loading.catch(() => {
      if (this.previewSheets.get(key) === loading) this.previewSheets.delete(key)
    })
    this.previewSheets.set(key, loading)
    for (const [oldKey, old] of this.previewSheets) {
      if (this.previewSheets.size <= MAX_PREVIEW_SHEETS) break
      this.previewSheets.delete(oldKey)
      old.then((sheet) => sheet.close()).catch(() => {})
    }
    return loading
  }

  get(assetId: string): AssetRecord | undefined {
    return this.records.get(assetId)
  }

  // 取り込んだ画像・PDF を、まだサーバーに送っている途中か（送り終えるまでは、サーバーの URL では読めない）
  isUploading(assetId: string): boolean {
    return this.uploads.has(assetId)
  }

  // 画像の Asset（PDF を除く）。新しく取り込んだもの・あとで登録したものほど後ろ（画像の塗りを選ぶ一覧。MAI-83）
  images(): AssetRecord[] {
    return [...this.records.values()].filter((record) => record.mime.startsWith('image/'))
  }

  // すでにある Asset のレコードを登録する（貼り付けたノードが別のタブの Asset を参照しているときなど）
  register(record: AssetRecord): void {
    if (!this.records.has(record.id)) this.records.set(record.id, record)
  }

  // サーバーにある Asset の一覧を読んで登録する（画面を開いたとき）
  async loadList(): Promise<void> {
    const response = await fetch(this.baseUrl)
    if (!response.ok) throw new Error(`Failed to list assets: ${response.status}`)
    const { assets } = (await response.json()) as { assets: Omit<AssetRecord, 'typeName' | 'id'>[] }
    for (const asset of assets) this.register({ typeName: 'asset', id: assetIdFromHash(asset.hash), ...asset })
  }

  // 手元に持っているもの（メモリーのベンチマーク用。MAI-67）
  get stats(): { records: number; pdfDocuments: number; localAssets: number; uploads: number } {
    return { records: this.records.size, pdfDocuments: this.pdfDocuments.size, localAssets: this.local.size, uploads: this.uploads.size }
  }

  // すべてのアップロードが終わるまで待つ（テスト用）
  async settled(): Promise<void> {
    await Promise.allSettled([...this.uploads.values()])
  }

  // 画像のファイルを取り込む。縮小版を作ってレコードを登録し、裏でアップロードを始める
  async importImage(file: Blob): Promise<AssetRecord> {
    if (!isSupportedImage(file)) throw new Error(`Unsupported image type: ${file.type || 'unknown'}`)
    const hash = await sha256Hex(file)
    const id = assetIdFromHash(hash)
    const existing = this.records.get(id)
    if (existing) return existing

    const bitmap = await createImageBitmap(file)
    const { width, height } = bitmap
    const longSide = Math.max(width, height)
    const blobs = new Map<number, Blob>([[longSide, file]])
    const variants: number[] = []
    try {
      for (const size of IMAGE_VARIANT_SIZES) {
        if (size >= longSide) continue
        blobs.set(size, await makeVariant(bitmap, size))
        variants.push(size)
      }
    } finally {
      bitmap.close()
    }
    const record: AssetRecord = { typeName: 'asset', id, mime: file.type, size: file.size, hash, width, height, variants }
    this.records.set(id, record)
    this.local.set(id, blobs)
    const upload = this.upload(record, blobs)
      .then(() => {
        this.local.delete(id)
      })
      .catch((error: unknown) => {
        console.error('Failed to upload asset', id, error)
        this.notify('画像をサーバーに保存できませんでした。このタブを閉じると、画像は失われます。')
      })
      .finally(() => this.uploads.delete(id))
    this.uploads.set(id, upload)
    return record
  }

  // PDF の中の単語を探す（サーバーが、取り出しておいたテキストで探す。PDF の単語検索の試作）。
  // アップロードが済んでいなければ、サーバーにはまだテキストがないので 'pending'
  async searchPdf(assetId: string, query: string, signal?: AbortSignal): Promise<PdfSearchResponse> {
    const record = this.records.get(assetId)
    if (!record || this.uploads.has(assetId)) return { status: 'pending', total: 0, pages: [] }
    const response = await fetch(`${this.baseUrl}/${record.hash}/search?q=${encodeURIComponent(query)}`, { signal })
    if (!response.ok) throw new Error(`search failed: ${response.status}`)
    return (await response.json()) as PdfSearchResponse
  }

  async load(assetId: string, size: number): Promise<RasterImage> {
    const record = this.records.get(assetId)
    if (!record) throw new Error(`Unknown asset: ${assetId}`)
    const blob = this.local.get(assetId)?.get(size) ?? (await this.fetchBlob(record, size))
    const image = await createImageBitmap(blob)
    return { image, width: image.width, height: image.height, level: size }
  }

  url(record: AssetRecord, size: number): string {
    const original = Math.max(record.width, record.height)
    return size >= original ? `${this.baseUrl}/${record.hash}` : `${this.baseUrl}/${record.hash}/${size}`
  }

  private async fetchBlob(record: AssetRecord, size: number): Promise<Blob> {
    let response = await fetch(this.url(record, size))
    // 縮小版がなければ（アップロードに失敗したなど）、原本を読む
    if (response.status === 404 && size < Math.max(record.width, record.height)) {
      response = await fetch(`${this.baseUrl}/${record.hash}`)
    }
    if (!response.ok) throw new Error(`Failed to load asset ${record.id}: ${response.status}`)
    return response.blob()
  }

  private async upload(record: AssetRecord, blobs: Map<number, Blob>): Promise<void> {
    const original = blobs.get(Math.max(record.width, record.height))!
    // record.variants が空（PDF など）なら、原本だけを送る
    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'content-type': record.mime,
        'x-canvcode-sha256': record.hash,
        'x-canvcode-width': String(record.width),
        'x-canvcode-height': String(record.height),
      },
      body: original,
    })
    if (!response.ok) throw new Error(`Upload failed: ${response.status} ${await response.text()}`)
    for (const size of record.variants) {
      const blob = blobs.get(size)!
      const variant = await fetch(`${this.baseUrl}/${record.hash}/${size}`, {
        method: 'PUT',
        headers: { 'content-type': blob.type },
        body: blob,
      })
      if (!variant.ok) throw new Error(`Variant upload failed: ${variant.status} ${await variant.text()}`)
    }
  }
}

// 前もって作った画像の解像度（1 単位あたりの画素数）。縮小画像と、あればページごとの画像の順
function previewLevels(manifest: PdfPreviewManifest, pageIndex: number): number[] {
  const page = manifest.pages[pageIndex]
  const thumb = manifest.thumbs[pageIndex]
  if (!page || !thumb || !(page.w > 0) || !(page.h > 0)) return []
  const levels = [thumb.w / (page.w * PDF_POINT_SCALE)]
  if (manifest.mid) levels.push(manifest.mid.size / Math.max(page.w, page.h) / PDF_POINT_SCALE)
  return levels
}

function revQuery(manifest: PdfPreviewManifest): string {
  return manifest.rev ? `?r=${encodeURIComponent(manifest.rev)}` : ''
}

// ページの画像を WebP（できなければ PNG）にする
async function encodeImage(raster: RasterImage): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(raster.width, raster.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(raster.image, 0, 0)
    return canvas.convertToBlob({ type: 'image/webp', quality: STORED_PAGE_QUALITY })
  }
  const canvas = drawScaled(raster.image, raster.width, raster.height)
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', STORED_PAGE_QUALITY))
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const bytes = await blob.arrayBuffer()
  // crypto.subtle は安全な文脈（https か localhost）にしかない。http で開いたときは自前で求める
  if (!globalThis.crypto?.subtle) return sha256HexSync(new Uint8Array(bytes))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// 長辺 size 画素の縮小版を作る。一度に大きく縮めると粗くなるので、半分ずつ縮める
async function makeVariant(bitmap: ImageBitmap, size: number): Promise<Blob> {
  const target = scaledSize(bitmap.width, bitmap.height, size)
  let source: CanvasImageSource = bitmap
  let w = bitmap.width
  let h = bitmap.height
  while (w / 2 >= target.width && h / 2 >= target.height) {
    w = Math.round(w / 2)
    h = Math.round(h / 2)
    source = drawScaled(source, w, h)
  }
  const canvas = drawScaled(source, target.width, target.height)
  // WebP にできないブラウザでは PNG になる（toBlob が対応していない形式を黙って PNG にする）
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/webp', 0.85),
  )
}

function drawScaled(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, width, height)
  return canvas
}
