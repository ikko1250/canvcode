import type { Box, Camera } from '@canvcode/core'

// PDF のページを 1 枚ずつ読み進める（MAI-57。パイメニュー「操作」の「次のページ」「前のページ」）。
// DOM に依存しない純粋な関数だけを置く。入力はページ番号の順に並んだページのワールド座標の箱と、カメラ・画面の大きさ。
// - 今のページ：画面の中心を含むページ。どのページも含まなければ、中心が画面の中心にいちばん近いページ
// - 次のページ：そのページの左上を、画面の左上に（margin だけ余白を空けて）合わせる。倍率は変えない
// - 前のページ：そのページの右下を、画面の右下に合わせる（ページの終わりから読み戻る）
// - 最後（最初）のページでは次（前）はない（null）
// - 番号のページ（MAI-92）：PDF の中での番号のページを、画面の中心がそのページに入るように置く（下の札の番号と合うように）

export type PageDirection = 'next' | 'prev'

function contains(box: Box, x: number, y: number): boolean {
  return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h
}

// 今のページの番号（pages の添字）。ページがなければ -1
export function currentPageIndex(pages: readonly Box[], camera: Camera, width: number, height: number): number {
  if (pages.length === 0) return -1
  const cx = camera.x + width / 2 / camera.zoom
  const cy = camera.y + height / 2 / camera.zoom
  const containing = pages.findIndex((page) => contains(page, cx, cy))
  if (containing >= 0) return containing
  let best = 0
  let bestDistance = Infinity
  pages.forEach((page, i) => {
    const distance = Math.hypot(page.x + page.w / 2 - cx, page.y + page.h / 2 - cy)
    if (distance < bestDistance) {
      best = i
      bestDistance = distance
    }
  })
  return best
}

// 次（前）のページへ移るカメラ。移る先がなければ null
export function pageNavigationTarget(
  pages: readonly Box[],
  camera: Camera,
  width: number,
  height: number,
  direction: PageDirection,
  margin: number,
): Camera | null {
  const current = currentPageIndex(pages, camera, width, height)
  if (current < 0) return null
  const page = pages[current + (direction === 'next' ? 1 : -1)]
  if (!page) return null
  const { zoom } = camera
  if (direction === 'next') return { x: page.x - margin, y: page.y - margin, zoom }
  return { x: page.x + page.w + margin - width / zoom, y: page.y + page.h + margin - height / zoom, zoom }
}

// 今のページを数えるための、PDF のページ（MAI-92）。pageIndex は PDF の中での番号（0 から）、pageCount は PDF の総ページ数
export interface PdfPageEntry {
  box: Box
  pageIndex: number
  pageCount?: number
}

// この Canvas の PDF のページ（Editor.pdfPages。MAI-92）。box はワールド座標
export interface PdfPage extends PdfPageEntry {
  id: string
}

// 今のページの、PDF の中での番号（1 から）と総ページ数（画面の下の「p.12 / 80」。MAI-92）。ページがなければ null。
// 間のページを消すと pages の添字はページの番号とずれるので、ページが持つ番号（pageIndex）を使う。
// 総ページ数は PDF の File のページ数。分からなければ pages の数
export function currentPdfPage(pages: readonly PdfPageEntry[], camera: Camera, width: number, height: number): { page: number; count: number } | null {
  const current = currentPageIndex(pages.map((page) => page.box), camera, width, height)
  if (current < 0) return null
  const { pageIndex, pageCount } = pages[current]
  return { page: pageIndex + 1, count: pageCount ?? pages.length }
}

// 入れた文字を、PDF の中での番号（1 から）にする（MAI-92）。全角の数字も受け（NFKC）、前後の空白は無視する。
// 1〜count の整数でなければ null
export function parsePageNumber(text: string, count: number): number | null {
  const normalized = text.normalize('NFKC').trim()
  if (!/^\d+$/.test(normalized)) return null
  const pageNumber = Number(normalized)
  return pageNumber >= 1 && pageNumber <= count ? pageNumber : null
}

// 番号のページへ移ったときの、ページのまわりの余白（画面上の px。MAI-92）。
// top は上下：上のバー（☰・パンくずリスト・右上の状態。画面の上から 12px に、高さ 26px ほど）に、ページの頭が重ならないように。
// side は左右
export const PAGE_JUMP_MARGIN_PX = { top: 56, side: 24 }

// PDF の中での番号（1 から）のページへ移るカメラ（MAI-92）。倍率は変えない。横と縦のそれぞれで（placeAlong）、
// ページと両側の余白が画面に収まるなら、ページの中心を画面の中心に合わせる。収まらなければ、ページの左端（上端）を
// 画面の左（上）から余白の所に合わせる（拡大して読むとき、ページの頭と左端から読めるように）。
// どちらでも画面の中心はそのページの中に入るので、今のページ（下の札の番号）は入れた番号と同じになる。
// 「次のページ」のように左上を合わせると、縮小していて何ページも見えるときに、画面の中心が隣のページに入ってしまう。
// ページは添字でなく pageIndex で探す（間のページを消してもずれないように）。そのページがなければ（範囲の外・消した）null
export function pageJumpTarget(
  pages: readonly PdfPageEntry[],
  pageNumber: number,
  camera: Camera,
  width: number,
  height: number,
  margin = PAGE_JUMP_MARGIN_PX,
): Camera | null {
  const page = pages.find((entry) => entry.pageIndex === pageNumber - 1)?.box
  if (!page) return null
  const { zoom } = camera
  return { x: placeAlong(page.x, page.w, width, zoom, margin.side), y: placeAlong(page.y, page.h, height, zoom, margin.top), zoom }
}

// 1 つの向きで、ワールド座標の start から長さ size のページを、長さ screen（px）の画面に置くときの、カメラの位置（ワールド座標）
function placeAlong(start: number, size: number, screen: number, zoom: number, margin: number): number {
  if (size * zoom + margin * 2 <= screen) return start + size / 2 - screen / 2 / zoom
  // 画面がとても小さいときも、画面の中心がページの端より外に出ないよう、余白は画面の長さの半分まで
  return start - Math.min(margin, screen / 2) / zoom
}

// 次・前のページがあるか（メニューに出す項目を決めるため）
export function pageNavigation(pages: readonly Box[], camera: Camera, width: number, height: number): { canNext: boolean; canPrev: boolean } {
  const current = currentPageIndex(pages, camera, width, height)
  return { canNext: current >= 0 && current < pages.length - 1, canPrev: current > 0 }
}
