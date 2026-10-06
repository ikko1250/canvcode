import { PDFDocument } from 'pdf-lib'

// キャンバスのスライドを PDF にする（スライド v2）。各スライドはブラウザで PNG に描いてあり、ここでは 1 枚 1 ページに貼ってまとめる

// ワールド単位 1 を PDF の何ポイントにするか。16:9 のスライド（1920×1080）が、PowerPoint などの一般的なスライドの大きさ
// （13.333in × 7.5in = 960×540pt）になるよう 0.5 倍にする。4:3（1440×1080）は 720×540pt（10in × 7.5in）になる。
// 画像は 2 倍の PNG なので、1pt あたり 4 ピクセル（288dpi 相当）で、拡大しても粗くなりにくい
export const SLIDE_PDF_POINTS_PER_UNIT = 0.5

export interface SlidePdfPage {
  // そのスライドを描いた PNG
  png: Blob | Uint8Array
  // スライドの大きさ（ワールド単位）
  width: number
  height: number
}

export interface SlidePdfOptions {
  // PDF のメタデータの Title（キャンバスの名前）
  title: string
  // 1 ページ貼るごとに、何枚目まで貼ったか（1 から）と全体の枚数を伝える
  onProgress?: (done: number, total: number) => void
}

// ページの列から PDF を作る。ページの大きさはスライドごとに合わせ、画像はページいっぱいに貼る
export async function buildSlidePdf(pages: SlidePdfPage[], options: SlidePdfOptions): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(options.title, { showInWindowTitleBar: true })
  pdf.setCreator('CanvCode')
  for (const [index, page] of pages.entries()) {
    const bytes = page.png instanceof Uint8Array ? page.png : new Uint8Array(await page.png.arrayBuffer())
    const image = await pdf.embedPng(bytes)
    const width = page.width * SLIDE_PDF_POINTS_PER_UNIT
    const height = page.height * SLIDE_PDF_POINTS_PER_UNIT
    pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height })
    options.onProgress?.(index + 1, pages.length)
  }
  return pdf.save()
}

// キャンバスの名前から PDF のファイル名を作る。ファイル名に使えない文字は「-」に置き換え、空なら slides にする
// （サーバーの md2pdf・スライドの書き出しの safeFilename と同じ置き換え）
export function slidePdfFileName(canvasName: string): string {
  const name = canvasName.replace(/[\\/:*?"<>|\p{Cc}]/gu, '-').replace(/\s+/g, ' ').trim() || 'slides'
  return `${name}.pdf`
}

// 作った PDF をダウンロードする
export function downloadSlidePdf(data: Uint8Array, fileName: string): void {
  const url = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
