import type { SlidePdfPage } from './slidePdf.ts'

// キャンバスのスライドを PDF に出力する手順（スライド v2。パイメニューの 操作 ›「スライドを PDF に出力」）。
// 描く・通知する・PDF を作るところは渡してもらい、DOM に依存しないようにする（テストで確かめられる）

// 何枚ごとに進み具合を知らせるか。少ない枚数なら、始めと終わりだけ知らせる
const PROGRESS_STEP = 10

export interface SlidePdfJob {
  // キャンバスの名前（PDF の Title とファイル名）
  canvasName: string
  // 表示するスライドの id を順に並べたもの（editor.slideNumbers().order）
  slideIds: string[]
  // 1 枚を描く。消されたなどで描けなければ null
  renderSlide(slideId: string): Promise<SlidePdfPage | null>
  notify(message: string): void
  // 文字があふれている・並べられなかった行があるスライドの番号（PDF のページ番号。editor.slideOverflows から引く）。
  // PDF は作ったうえで、出力し終えたあとに知らせる
  overflowNumbers?: number[]
}

// あふれのあるスライドを知らせる文（「3・5 枚目の文字があふれています」）。なければ null
export function slideOverflowNotice(numbers: readonly number[]): string | null {
  if (numbers.length === 0) return null
  return `${[...numbers].sort((a, b) => a - b).join('・')} 枚目の文字があふれています`
}

// PDF を作ってダウンロードするところ（slidePdf.ts）。pdf-lib はメインのチャンクに入れないよう、使うときに読む
export type SlidePdfLibrary = Pick<typeof import('./slidePdf.ts'), 'buildSlidePdf' | 'slidePdfFileName' | 'downloadSlidePdf'>

const loadSlidePdf = (): Promise<SlidePdfLibrary> => import('./slidePdf.ts')

// スライドを PDF に出力する関数を作る。作っている途中にもう一度頼まれたら、重ねて始めない（md2pdf と同じ）
export function createSlidePdfExporter(load: () => Promise<SlidePdfLibrary> = loadSlidePdf): (job: SlidePdfJob) => Promise<void> {
  let running = false
  return async (job) => {
    if (running) return
    const { slideIds, notify } = job
    if (slideIds.length === 0) return notify('PDF に出力するスライドがありません（すべて非表示です）')
    running = true
    notify(`スライドの PDF を作っています…（${slideIds.length} 枚）`)
    try {
      const library = await load()
      const pages: SlidePdfPage[] = []
      for (const [index, slideId] of slideIds.entries()) {
        const page = await job.renderSlide(slideId)
        if (page) pages.push(page)
        const done = index + 1
        if (done % PROGRESS_STEP === 0 && done < slideIds.length) notify(`スライドの PDF を作っています…（${done} / ${slideIds.length} 枚）`)
      }
      if (pages.length === 0) return notify('スライドを PDF に出力できませんでした（スライドを描けませんでした）')
      const data = await library.buildSlidePdf(pages, { title: job.canvasName })
      const fileName = library.slidePdfFileName(job.canvasName)
      library.downloadSlidePdf(data, fileName)
      notify(`${fileName} を出力しました`)
      const overflow = slideOverflowNotice(job.overflowNumbers ?? [])
      if (overflow) notify(overflow)
    } catch (error) {
      notify(`スライドを PDF に出力できませんでした：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      running = false
    }
  }
}
