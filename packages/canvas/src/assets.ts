import { assetIdFromHash, type AssetRecord } from '@canvcode/core'
import { IMAGE_VARIANT_SIZES, PDF_POINT_SCALE, scaledSize, type AssetResolver, type RasterImage } from '@canvcode/nodes'
import type { PdfTextItem } from './quotes.ts'

// 画像の Asset の取り込み・アップロード・読み込み（MAI-10、MAI-14、MAI-26）。
// - 取り込むとき、ブラウザで中身の SHA-256 と縮小版（長辺 256px・1024px）を作り、すぐに使えるようにしてから、
//   裏でサーバーへアップロードする（ノードはアップロードを待たずに置ける）
// - アップロードが済むまでは手元の Blob から、済んだらサーバーから読む
// - レコードはサーバーの <ハッシュ>.json が正本。画面を開いたときに一覧（GET /api/assets）を読む（段階 11）

export interface AssetManagerOptions {
  // API の場所（既定は /api/assets）
  baseUrl?: string
  // アップロードに失敗したときなどに、画面に知らせる
  notify?: (message: string) => void
  // PDF を開いて描く先（PDF.js。Vite の機能で Worker を読み込むので、アプリ側から渡す。MAI-32）
  pdf?: PdfService
}

// PDF を開いて描く（MAI-5、MAI-32）。大きさはポイント（1/72 インチ）
export interface PdfDocument {
  numPages: number
  pageSize(pageIndex: number): Promise<{ width: number; height: number }>
  // 1 ポイントあたり scale 画素で描く
  render(pageIndex: number, scale: number): Promise<ImageBitmap>
  // ページの文字の断片（位置はポイント、ページの左上が原点。引用に使う。MAI-33）
  textItems(pageIndex: number): Promise<PdfTextItem[]>
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

// 取り込める画像の種類。SVG は中にスクリプトを持てるので、初版では受け付けない
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']

export function isSupportedImage(file: Blob): boolean {
  return IMAGE_MIME_TYPES.includes(file.type)
}

export class AssetManager implements AssetResolver {
  private readonly records = new Map<string, AssetRecord>()
  // アップロードが済むまで持っておく手元の Blob（長辺の画素数 → Blob）
  private readonly local = new Map<string, Map<number, Blob>>()
  private readonly uploads = new Map<string, Promise<void>>()
  private readonly baseUrl: string
  private readonly notify: (message: string) => void
  private readonly pdf: PdfService | null
  private readonly pdfDocuments = new Map<string, Promise<PdfDocument>>()

  constructor(options: AssetManagerOptions = {}) {
    this.baseUrl = options.baseUrl ?? '/api/assets'
    this.notify = options.notify ?? ((message) => console.warn(message))
    this.pdf = options.pdf ?? null
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

  // PDF を開く（Asset ごとに一度だけ）。アップロードが済むまでは手元のファイルから、済んだらサーバーから読む
  pdfDocument(assetId: string): Promise<PdfDocument> {
    let pending = this.pdfDocuments.get(assetId)
    if (!pending) {
      const pdf = this.pdf
      const record = this.records.get(assetId)
      if (!pdf || !record) return Promise.reject(new Error(`Cannot open the PDF: ${assetId}`))
      const local = this.local.get(assetId)?.get(0)
      pending = local ? local.arrayBuffer().then((data) => pdf.open({ data })) : pdf.open({ url: `${this.baseUrl}/${record.hash}` })
      pending.catch(() => this.pdfDocuments.delete(assetId))
      this.pdfDocuments.set(assetId, pending)
    }
    return pending
  }

  async renderPdfPage(assetId: string, pageIndex: number, scale: number): Promise<RasterImage> {
    const doc = await this.pdfDocument(assetId)
    const size = await doc.pageSize(pageIndex)
    // ワールド座標の 1 単位あたり scale 画素 → ポイントあたりの画素。大きすぎるときは抑える
    let pointScale = scale * PDF_POINT_SCALE
    pointScale = Math.min(pointScale, PDF_MAX_SIDE / size.width, PDF_MAX_SIDE / size.height, Math.sqrt(PDF_MAX_PIXELS / (size.width * size.height)))
    const image = await doc.render(pageIndex, pointScale)
    return { image, width: image.width, height: image.height, level: scale }
  }

  get(assetId: string): AssetRecord | undefined {
    return this.records.get(assetId)
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

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
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
