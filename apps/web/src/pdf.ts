import type { PdfService } from '@canvcode/canvas'

// PDF を開く（MAI-5、MAI-32）。PDF.js は大きいので、最初に PDF を開くときに読み込む（pdfjs.ts）。
// 開いた直後の画面に要るコードを減らし、遅い端末（iPad など）で画面が出るまでを短くするため
let pdfjs: Promise<typeof import('./pdfjs.ts')> | null = null
const loadPdfJs = () => (pdfjs ??= import('./pdfjs.ts'))

export const pdfService: PdfService = {
  async open(source) {
    const { openPdfDocument } = await loadPdfJs()
    return openPdfDocument(source)
  },
}

// 画面を出したあとに、PDF.js を先に読み込んでおく（PDF のページのある Canvas で、ページが出るのが遅れないように）
export function preloadPdfJs(): void {
  void loadPdfJs().catch(() => {
    pdfjs = null
  })
}
