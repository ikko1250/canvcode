import type { PdfDocument, PdfService } from '@canvcode/canvas'
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

// PDF.js（MAI-5、MAI-32）。解析は Web Worker（pdf.worker）で行い、ページを描くのはメインスレッドの Canvas。
// 描く回数は画像キャッシュが抑える（カメラが止まってから、画面に見えるページを 1 枚ずつ）。
// Vite の機能（?url）で Worker を読み込むので、packages/canvas ではなくここに置いている。
GlobalWorkerOptions.workerSrc = workerUrl

class PdfJsDocument implements PdfDocument {
  private readonly doc: PDFDocumentProxy

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
}

export const pdfService: PdfService = {
  async open(source) {
    const task = getDocument('data' in source ? { data: new Uint8Array(source.data) } : { url: source.url })
    return new PdfJsDocument(await task.promise)
  },
}
