import { assetIdFromHash, type AssetRecord } from '@canvcode/core'
import { IMAGE_VARIANT_SIZES, scaledSize, type AssetResolver, type RasterImage } from '@canvcode/nodes'

// 画像の Asset の取り込み・アップロード・読み込み（MAI-10、MAI-14、MAI-26）。
// - 取り込むとき、ブラウザで中身の SHA-256 と縮小版（長辺 256px・1024px）を作り、すぐに使えるようにしてから、
//   裏でサーバーへアップロードする（ノードはアップロードを待たずに置ける）
// - アップロードが済むまでは手元の Blob から、済んだらサーバーから読む
// - 段階 11 で Asset のレコードをサーバーに保存するまでは、レコードはこのタブの中だけにある

export interface AssetManagerOptions {
  // API の場所（既定は /api/assets）
  baseUrl?: string
  // アップロードに失敗したときなどに、画面に知らせる
  notify?: (message: string) => void
}

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

  constructor(options: AssetManagerOptions = {}) {
    this.baseUrl = options.baseUrl ?? '/api/assets'
    this.notify = options.notify ?? ((message) => console.warn(message))
  }

  get(assetId: string): AssetRecord | undefined {
    return this.records.get(assetId)
  }

  // すでにある Asset のレコードを登録する（貼り付けたノードが別のタブの Asset を参照しているときなど）
  register(record: AssetRecord): void {
    if (!this.records.has(record.id)) this.records.set(record.id, record)
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
    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: { 'content-type': record.mime, 'x-canvcode-sha256': record.hash },
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
