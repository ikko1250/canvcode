import type { Box } from '@canvcode/core'
import type { LinkRegion } from './layout.ts'
import { drawHtmlTile, loadHtmlImage } from './rasterize.ts'

// 画像にしたカードのリンクの位置を、画像そのものから読む。
// layout.ts の measureLinks は、同じ HTML をページの DOM でレイアウトして測るが、端末によっては
// DOM と SVG の画像とでフォントや文字の幅が揃わず、行の数が変わって、下のリンクほど当たり判定が上にずれた。
// そこで、描いた画像と同じ HTML と CSS の SVG で、文字や罫線を透明にしてリンクだけを色で塗り分けた画像を作り、
// 画素の色からリンクの矩形を求める。描いた画像と同じレイアウトなので、端末によらず描いたところに当たる。
// 画素を読めない（Canvas が汚染される）ブラウザでは null を返すので、DOM で測った位置を使う

// リンクを塗る色の段階。1 つのチャンネルを 8 段階にするので、塗り分けられるのは 512 個まで
const LEVELS = 8
const STEP = 256 / LEVELS
// 色の誤差の許し。段階の半分より小さくして、2 色が混ざった縁の画素を別のリンクと読まないようにする
const TOLERANCE = 8
export const LINK_MAP_MAX_LINKS = LEVELS ** 3

// リンクの画像の解像度（CSS ピクセルあたりの画素）。本文の 1 行が 13 画素ほどになる
const LINK_MAP_SCALE = 0.5
// 1 度に画素を読む帯の高さ（CSS ピクセル）。LINK_MAP_SCALE 倍して整数になるようにする
const STRIP_HEIGHT = 1024

// リンクだけを塗った画像にする CSS。色・背景・線・画像を消すだけで、レイアウトは変えない
export const LINK_MAP_CSS = `
.md-card, .md-card * {
  color: transparent !important;
  -webkit-text-fill-color: transparent !important;
  background: transparent !important;
  border-color: transparent !important;
  outline-color: transparent !important;
  box-shadow: none !important;
  text-shadow: none !important;
  text-decoration-color: transparent !important;
}
.md-card img, .md-card svg, .md-card *::before, .md-card *::after { visibility: hidden !important; }
`

// index 番目のリンクを塗る色
export function linkMapColor(index: number): [number, number, number] {
  const level = (n: number) => (Math.floor(n) % LEVELS) * STEP + STEP / 2
  return [level(index / (LEVELS * LEVELS)), level(index / LEVELS), level(index)]
}

// 画素の色が何番目のリンクの色か。どのリンクの色でもなければ -1
export function linkMapIndex(r: number, g: number, b: number, a: number): number {
  // 半透明の画素は、リンクの縁（背景と混ざっている）
  if (a < 250) return -1
  let index = 0
  for (const value of [r, g, b]) {
    const level = Math.round((value - STEP / 2) / STEP)
    if (level < 0 || level >= LEVELS || Math.abs(value - (level * STEP + STEP / 2)) > TOLERANCE) return -1
    index = index * LEVELS + level
  }
  return index
}

// html の <a href> に、それぞれの色の背景を付ける。リンクが多すぎて塗り分けられなければ null
export function markLinks(html: string): { html: string; hrefs: string[] } | null {
  const template = document.createElement('template')
  template.innerHTML = html
  const anchors = [...template.content.querySelectorAll<HTMLAnchorElement>('a[href]')]
  if (anchors.length > LINK_MAP_MAX_LINKS) return null
  anchors.forEach((anchor, i) => {
    // style 属性の !important は、LINK_MAP_CSS の !important よりも強い
    anchor.style.setProperty('background-color', `rgb(${linkMapColor(i).join(',')})`, 'important')
  })
  return { html: template.innerHTML, hrefs: anchors.map((anchor) => anchor.getAttribute('href')!) }
}

interface OpenRect {
  index: number
  x0: number
  x1: number
  top: number
  bottom: number
}

// 帯ごとに読んだ画素から、リンクの矩形を集める。
// 1 行の画素で同じ色が続くところを 1 つの区間にし、すぐ下の行に同じ色・ほぼ同じ横の範囲の区間があればつなぐ。
// 折り返したリンクは、行ごとに横の範囲が違うので、行ごとの矩形になる
export class LinkRectCollector {
  private open: OpenRect[] = []
  private closed: OpenRect[] = []
  private readonly scaleX: number
  private readonly scaleY: number

  // scaleX・scaleY は、画像の CSS ピクセルあたりの画素
  constructor(scaleX: number, scaleY: number) {
    this.scaleX = scaleX
    this.scaleY = scaleY
  }

  // data は帯の画素（RGBA）。帯の上端は、画像全体の row 行目（画素）
  addStrip(data: ArrayLike<number>, width: number, height: number, row: number): void {
    for (let y = 0; y < height; y++) {
      const runs: Array<{ index: number; x0: number; x1: number }> = []
      let x = 0
      while (x < width) {
        const i = (y * width + x) * 4
        const index = linkMapIndex(data[i], data[i + 1], data[i + 2], data[i + 3])
        let end = x + 1
        if (index >= 0) {
          while (end < width) {
            const j = (y * width + end) * 4
            if (linkMapIndex(data[j], data[j + 1], data[j + 2], data[j + 3]) !== index) break
            end++
          }
          // 1 画素だけの区間は、2 つのリンクの境目で色が混ざったもの
          if (end - x >= 2) runs.push({ index, x0: x, x1: end })
        }
        x = end
      }
      this.addRow(row + y, runs)
    }
  }

  private addRow(row: number, runs: Array<{ index: number; x0: number; x1: number }>): void {
    const next: OpenRect[] = []
    for (const run of runs) {
      const k = this.open.findIndex(
        (r) => r.index === run.index && r.bottom === row && Math.abs(r.x0 - run.x0) <= 1 && Math.abs(r.x1 - run.x1) <= 1,
      )
      if (k >= 0) {
        const rect = this.open.splice(k, 1)[0]
        rect.x0 = Math.min(rect.x0, run.x0)
        rect.x1 = Math.max(rect.x1, run.x1)
        rect.bottom = row + 1
        next.push(rect)
      } else {
        next.push({ ...run, top: row, bottom: row + 1 })
      }
    }
    this.closed.push(...this.open)
    this.open = next
  }

  // 集めた矩形を、CSS ピクセルのリンクの位置にする。縁の半透明の画素は読まないので、1 画素ずつ広げる
  regions(hrefs: string[], width: number, height: number): LinkRegion[] {
    const byIndex = new Map<number, Box[]>()
    for (const r of [...this.closed, ...this.open]) {
      const x = Math.max(0, (r.x0 - 1) / this.scaleX)
      const y = Math.max(0, (r.top - 1) / this.scaleY)
      const rect = { x, y, w: Math.min(width, (r.x1 + 1) / this.scaleX) - x, h: Math.min(height, (r.bottom + 1) / this.scaleY) - y }
      const rects = byIndex.get(r.index) ?? []
      rects.push(rect)
      byIndex.set(r.index, rects)
    }
    return [...byIndex.entries()]
      .filter(([index]) => index < hrefs.length)
      .sort(([a], [b]) => a - b)
      .map(([index, rects]) => ({ href: hrefs[index], rects: rects.sort((a, b) => a.y - b.y || a.x - b.x) }))
  }
}

// css は画像を描くときと同じもの（フォントを埋め込んだ CSS と MARKDOWN_CARD_CSS）。
// 画素を読めないときや、リンクが多すぎて塗り分けられないときは null
export async function measureLinksInImage(options: { html: string; css: string; width: number; height: number }): Promise<LinkRegion[] | null> {
  const { width, height } = options
  const marked = markLinks(options.html)
  if (!marked) return null
  if (marked.hrefs.length === 0) return []
  const image = await loadHtmlImage({ html: marked.html, css: options.css + LINK_MAP_CSS, width, height })
  // 帯の画像の幅は、drawHtmlTile で丸めた画素数
  const collector = new LinkRectCollector(Math.max(1, Math.round(width * LINK_MAP_SCALE)) / width, LINK_MAP_SCALE)
  for (let y = 0; y < height; y += STRIP_HEIGHT) {
    const rect = { x: 0, y, w: width, h: Math.min(STRIP_HEIGHT, height - y) }
    const canvas = drawHtmlTile(image, rect, LINK_MAP_SCALE)
    let data: ImageData
    try {
      data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)
    } catch {
      // Canvas が汚染されて、画素を読めない
      return null
    }
    collector.addStrip(data.data, canvas.width, canvas.height, Math.round(y * LINK_MAP_SCALE))
    // 長いカードでも、画面を長く止めないよう、帯ごとに手を離す
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return collector.regions(marked.hrefs, width, height)
}
