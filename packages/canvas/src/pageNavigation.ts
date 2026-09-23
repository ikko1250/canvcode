import type { Box, Camera } from '@canvcode/core'

// PDF のページを 1 枚ずつ読み進める（MAI-57。パイメニュー「操作」の「次のページ」「前のページ」）。
// DOM に依存しない純粋な関数だけを置く。入力はページ番号の順に並んだページのワールド座標の箱と、カメラ・画面の大きさ。
// - 今のページ：画面の中心を含むページ。どのページも含まなければ、中心が画面の中心にいちばん近いページ
// - 次のページ：そのページの左上を、画面の左上に（margin だけ余白を空けて）合わせる。倍率は変えない
// - 前のページ：そのページの右下を、画面の右下に合わせる（ページの終わりから読み戻る）
// - 最後（最初）のページでは次（前）はない（null）

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

// 次・前のページがあるか（メニューに出す項目を決めるため）
export function pageNavigation(pages: readonly Box[], camera: Camera, width: number, height: number): { canNext: boolean; canPrev: boolean } {
  const current = currentPageIndex(pages, camera, width, height)
  return { canNext: current >= 0 && current < pages.length - 1, canPrev: current > 0 }
}
