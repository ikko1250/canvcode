import type { Box } from '@canvcode/core'

// 画像にしたカードの上で、リンクを押せるようにするための位置の記録（MAI-21）。
// 画像そのものからはリンクの位置が分からないので、同じ HTML を見えない DOM に置いてレイアウトし、
// <a> の位置をカードのローカル座標（CSS ピクセル）で取り出す。
// フォント名を明示しているので（cardHtml.ts）、画像と同じ位置で改行される。
// レイアウトは倍率によらないので、中身かカードの幅が変わったときだけ測り直せばよい。

export interface LinkRegion {
  href: string
  // 折り返したリンクは、行ごとに複数の矩形になる
  rects: Box[]
}

export interface MeasureOptions {
  html: string
  // フォントの @font-face を含まない CSS。フォントはページ側で読み込んだものを使う
  css: string
  width: number
  height: number
}

// CSS の解析に時間がかかるので（KaTeX の CSS は大きい）、計測用の DOM は 1 つを使い回す
let measureHost: { host: HTMLDivElement; style: HTMLStyleElement; root: HTMLDivElement; css: string } | null = null

function getMeasureHost(css: string) {
  if (!measureHost || !measureHost.host.isConnected) {
    const host = document.createElement('div')
    Object.assign(host.style, {
      position: 'fixed',
      left: '-100000px',
      top: '0',
      visibility: 'hidden',
      pointerEvents: 'none',
      contain: 'strict',
      width: '0',
      height: '0',
      overflow: 'hidden',
    })
    // ページの CSS が混ざらないよう、Shadow DOM の中でレイアウトする
    const shadow = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    const root = document.createElement('div')
    shadow.append(style, root)
    document.body.appendChild(host)
    measureHost = { host, style, root, css: '' }
  }
  if (measureHost.css !== css) {
    measureHost.style.textContent = css
    measureHost.css = css
  }
  return measureHost
}

export function measureLinks(options: MeasureOptions): LinkRegion[] {
  const { root } = getMeasureHost(options.css)
  root.style.width = `${options.width}px`
  root.style.height = `${options.height}px`
  root.innerHTML = options.html
  try {
    const origin = root.getBoundingClientRect()
    const regions: LinkRegion[] = []
    for (const anchor of root.querySelectorAll('a[href]')) {
      const rects = [...anchor.getClientRects()]
        .map((r) => ({ x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height }))
        // カードの外（下にはみ出して見えない部分）にあるものは押せない
        .filter((r) => r.w > 0 && r.h > 0 && r.y < options.height && r.x < options.width)
      if (rects.length > 0) regions.push({ href: anchor.getAttribute('href')!, rects })
    }
    return regions
  } finally {
    root.innerHTML = ''
  }
}

export function hitLink(regions: LinkRegion[], x: number, y: number): LinkRegion | null {
  for (const region of regions) {
    for (const r of region.rects) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return region
    }
  }
  return null
}
