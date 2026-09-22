import type { PdfDocument, PdfService, PdfTextItem } from '@canvcode/canvas'
import { GlobalWorkerOptions, Util, getDocument, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

// PDF.js（MAI-5、MAI-32）。解析は Web Worker（pdf.worker）で行い、ページを描くのはメインスレッドの Canvas。
// 描く回数は画像キャッシュが抑える（カメラが止まってから、画面に見えるページを 1 枚ずつ）。
// Vite の機能（?url）で Worker を読み込むので、packages/canvas ではなくここに置いている。
GlobalWorkerOptions.workerSrc = workerUrl

class PdfJsDocument implements PdfDocument {
  private readonly doc: PDFDocumentProxy
  private readonly texts = new Map<number, Promise<PdfTextItem[]>>()

  constructor(doc: PDFDocumentProxy) {
    this.doc = doc
  }

  get numPages(): number {
    return this.doc.numPages
  }

  async pageSize(pageIndex: number): Promise<{ width: number; height: number }> {
    const viewport = (await this.doc.getPage(pageIndex + 1)).getViewport({ scale: 1 })
    return { width: viewport.width, height: viewport.height }
  }

  async render(pageIndex: number, scale: number): Promise<ImageBitmap> {
    const page = await this.doc.getPage(pageIndex + 1)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.ceil(viewport.width))
    canvas.height = Math.max(1, Math.ceil(viewport.height))
    await page.render({ canvas, viewport }).promise
    const bitmap = await createImageBitmap(canvas)
    // 描き終えたら、ページが使っていたメモリを返す
    page.cleanup()
    return bitmap
  }

  // ページの文字の断片（引用に使う。MAI-33）。ページごとに一度だけ読む
  textItems(pageIndex: number): Promise<PdfTextItem[]> {
    let pending = this.texts.get(pageIndex)
    if (!pending) {
      pending = this.readText(pageIndex)
      pending.catch(() => this.texts.delete(pageIndex))
      this.texts.set(pageIndex, pending)
    }
    return pending
  }

  private async readText(pageIndex: number): Promise<PdfTextItem[]> {
    const page = await this.doc.getPage(pageIndex + 1)
    // 大きさ 1 の viewport で、PDF の座標（左下が原点）を、ページの左上が原点のポイントに直す
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const items: PdfTextItem[] = []
    for (const item of content.items) {
      if (!('str' in item) || !item.str) continue
      const m = Util.transform(viewport.transform, item.transform)
      const size = Math.hypot(m[2], m[3])
      if (size <= 0) continue
      // m[5] は文字の並ぶ線（ベースライン）。上端はそこから字の高さの 8 割ほど上
      items.push({ text: item.str, x: m[4], y: m[5] - size * 0.85, w: item.width * viewport.scale, h: size })
    }
    return items
  }
}

export const pdfService: PdfService = {
  async open(source) {
    const task = getDocument('data' in source ? { data: new Uint8Array(source.data) } : { url: source.url })
    return new PdfJsDocument(await task.promise)
  },
}
