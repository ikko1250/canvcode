// HTML を画像に変換する（MAI-5、MAI-21 の検証）。
// SVG の foreignObject に HTML と CSS を入れて <img> として読み込み、Canvas に描いて画像にする。
// SVG を画像として読み込むときは外部の資源（フォント・画像）を読めないので、すべて data: URL で埋め込む。

export interface RasterizeOptions {
  // XHTML として書き出せる HTML 文字列
  html: string
  // SVG に埋め込む CSS（フォントを含む）
  css: string
  // CSS ピクセルでの大きさ
  width: number
  height: number
  // 画像の解像度の倍率（表示倍率 × devicePixelRatio）
  scale: number
  // SVG を読み込ませる方法。ブラウザによって Canvas の汚染の扱いが違うので、両方を試せるようにしている
  urlMode?: 'data' | 'blob'
  // 'canvas'：Canvas に描いて返す / 'bitmap'：createImageBitmap で直接作る（メインスレッドを止める時間が短い見込み。MAI-22）
  output?: 'canvas' | 'bitmap'
}

export interface RasterizeTimings {
  inlineImagesMs: number
  serializeMs: number
  decodeMs: number
  drawMs: number
  totalMs: number
}

export interface RasterizeResult {
  // output: 'bitmap' のときは ImageBitmap（作れなかった場合は Canvas に戻す）
  canvas: HTMLCanvasElement | ImageBitmap
  // 実際に使った倍率（大きすぎる場合は上限で抑える）
  scale: number
  timings: RasterizeTimings
  svgBytes: number
  // Canvas が汚染されて画素を読めなくなったか（サムネイルや書き出しに影響する）
  tainted: boolean
}

// 1 辺の上限と画素数の上限。これを超える倍率は抑える
const MAX_SIDE = 8192
const MAX_PIXELS = 32 * 1024 * 1024

export function clampScale(width: number, height: number, scale: number): number {
  let s = scale
  s = Math.min(s, MAX_SIDE / width, MAX_SIDE / height)
  s = Math.min(s, Math.sqrt(MAX_PIXELS / (width * height)))
  return Math.max(s, 0.05)
}

// どの方法で画像を作れたかの回数（MAI-22 の比較用）
export const rasterizeCounters = { bitmap: 0, canvas: 0, bitmapFallback: 0 }

// 直近に作った画像の大きさと時間の内訳（端末での性能の記録に使う。新しいものから RASTERIZE_LOG_LIMIT 件）
export interface RasterizeLogEntry extends RasterizeTimings {
  kind: 'full' | 'tile-source' | 'tile'
  width: number
  height: number
  scale: number
  svgBytes: number
}
export const rasterizeLog: RasterizeLogEntry[] = []
const RASTERIZE_LOG_LIMIT = 64
function logRasterize(entry: RasterizeLogEntry): void {
  rasterizeLog.unshift(entry)
  if (rasterizeLog.length > RASTERIZE_LOG_LIMIT) rasterizeLog.length = RASTERIZE_LOG_LIMIT
}

// Markdown の中の画像（src → data URL）。Map の順番は「最近使った順」で、MAX_INLINE_IMAGES を超えたら古いものから捨てる（MAI-66）
const imageCache = new Map<string, Promise<string | null>>()
// 読み終えた data URL の長さ（メモリーのベンチマーク用。MAI-67）
const imageCacheChars = new Map<string, number>()
const MAX_INLINE_IMAGES = 32

// Markdown の中の画像のキャッシュの件数と、data URL の合計の文字数
export function rasterizeImageCacheStats(): { entries: number; chars: number } {
  let chars = 0
  for (const length of imageCacheChars.values()) chars += length
  return { entries: imageCache.size, chars }
}

async function toDataUrl(src: string): Promise<string | null> {
  if (src.startsWith('data:')) return src
  let cached = imageCache.get(src)
  if (cached) {
    imageCache.delete(src)
    imageCache.set(src, cached)
  } else {
    cached = (async () => {
      try {
        const response = await fetch(src)
        if (!response.ok) return null
        const blob = await response.blob()
        return await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(reader.error)
          reader.readAsDataURL(blob)
        })
      } catch {
        return null
      }
    })()
    imageCache.set(src, cached)
    const pending = cached
    void pending.then((url) => {
      if (url && imageCache.get(src) === pending) imageCacheChars.set(src, url.length)
    })
    for (const key of imageCache.keys()) {
      if (imageCache.size <= MAX_INLINE_IMAGES) break
      imageCache.delete(key)
      imageCacheChars.delete(key)
    }
  }
  return cached
}

// <img> の src を data: URL に置き換える。読めない画像は代わりの文字にする
async function inlineImages(root: Element): Promise<void> {
  const images = [...root.querySelectorAll('img')]
  await Promise.all(
    images.map(async (img) => {
      const dataUrl = await toDataUrl(img.getAttribute('src') ?? '')
      if (dataUrl) {
        img.setAttribute('src', dataUrl)
        img.removeAttribute('loading')
      } else {
        img.replaceWith(root.ownerDocument.createTextNode(img.getAttribute('alt') ?? ''))
      }
    }),
  )
}

// SVG の画像の中では、ブラウザはフォームの部品（チェックボックスなど）を描かない。
// CSS で描ける代わりの要素に置き換える（見た目は RASTER_SUBSTITUTE_CSS）
function replaceFormControls(root: Element): void {
  for (const input of root.querySelectorAll('input[type="checkbox"]')) {
    const box = root.ownerDocument.createElement('span')
    box.className = input.hasAttribute('checked') ? 'raster-checkbox raster-checkbox-checked' : 'raster-checkbox'
    input.replaceWith(box)
  }
}

export const RASTER_SUBSTITUTE_CSS = `
.raster-checkbox {
  display: inline-block;
  box-sizing: border-box;
  width: 13px;
  height: 13px;
  margin: 0 0.45em 0 0;
  vertical-align: middle;
  border: 1px solid #8f8f9d;
  border-radius: 2px;
  background: #ffffff;
}
.raster-checkbox-checked {
  background: #767676 url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 6.2l2.3 2.3 4.7-5' fill='none' stroke='white' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 100% no-repeat;
  border-color: #767676;
}
`

function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image()
  img.decoding = 'async'
  img.src = url
  return img.decode().then(() => img)
}

// HTML を、SVG の画像の中で描ける形にする（フォームの部品を置き換え、画像を data: URL で埋め込む）
async function prepareBody(html: string): Promise<Element> {
  const doc = document.implementation.createHTMLDocument('')
  const container = doc.createElement('div')
  container.innerHTML = html
  replaceFormControls(container)
  await inlineImages(container)
  return container
}

// foreignObject に HTML を入れた SVG。中身は width × height（CSS ピクセル）、画像の大きさは pixelW × pixelH。
// 拡大は viewBox ではなく、中身の CSS の transform で行う。WebKit（Safari）は、foreignObject の中の層を作る要素
// （position: relative・isolation など。KaTeX の数式も使う）には viewBox の拡大を効かせず、倍率 2 なら半分の大きさで描くため、
// ズームすると本文の文字だけが小さくなった。transform なら、Chromium・Firefox でも同じ画素になる
function svgOf(container: Element, css: string, width: number, height: number, pixelW: number, pixelH: number): string {
  // XMLSerializer は、HTML の要素を XHTML の名前空間付きで書き出す
  const serializer = new XMLSerializer()
  const body = [...container.childNodes].map((node) => serializer.serializeToString(node)).join('')
  const styleText = (css + RASTER_SUBSTITUTE_CSS).replaceAll(']]>', ']]]]><![CDATA[>')
  const sx = pixelW / width
  const sy = pixelH / height
  const transform = sx === 1 && sy === 1 ? '' : `;transform:scale(${sx},${sy});transform-origin:0 0`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelW}" height="${pixelH}" viewBox="0 0 ${pixelW} ${pixelH}">` +
    `<foreignObject x="0" y="0" width="${pixelW}" height="${pixelH}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px${transform}">` +
    `<style><![CDATA[${styleText}]]></style>${body}</div>` +
    `</foreignObject></svg>`
  )
}

export async function rasterizeHtml(options: RasterizeOptions): Promise<RasterizeResult> {
  const start = performance.now()
  const { width, height, css } = options
  const scale = clampScale(width, height, options.scale)

  const container = await prepareBody(options.html)
  const afterInline = performance.now()

  const pixelW = Math.round(width * scale)
  const pixelH = Math.round(height * scale)
  const svg = svgOf(container, css, width, height, pixelW, pixelH)
  const afterSerialize = performance.now()

  let url: string
  let revoke: (() => void) | null = null
  if (options.urlMode === 'blob') {
    url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
    revoke = () => URL.revokeObjectURL(url)
  } else {
    url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  }
  let img: HTMLImageElement
  try {
    img = await loadImage(url)
  } finally {
    revoke?.()
  }
  const afterDecode = performance.now()

  let output: HTMLCanvasElement | ImageBitmap | null = null
  let tainted = false
  if (options.output === 'bitmap') {
    try {
      const bitmap = await createImageBitmap(img, { resizeWidth: pixelW, resizeHeight: pixelH, resizeQuality: 'high' })
      // 汚染されていないかを、1 画素だけ描いて確かめる
      const probe = document.createElement('canvas')
      probe.width = probe.height = 1
      const probeCtx = probe.getContext('2d')!
      probeCtx.drawImage(bitmap, 0, 0, 1, 1)
      probeCtx.getImageData(0, 0, 1, 1)
      output = bitmap
      rasterizeCounters.bitmap++
    } catch {
      // 作れない・汚染される場合は、Canvas に描く方法に戻す
      output = null
      rasterizeCounters.bitmapFallback++
    }
  }
  if (!output) {
    const canvas = document.createElement('canvas')
    canvas.width = pixelW
    canvas.height = pixelH
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas2D is not available')
    ctx.drawImage(img, 0, 0, pixelW, pixelH)
    try {
      ctx.getImageData(0, 0, 1, 1)
    } catch {
      tainted = true
    }
    output = canvas
    rasterizeCounters.canvas++
  }
  const end = performance.now()
  const timings = {
    inlineImagesMs: afterInline - start,
    serializeMs: afterSerialize - afterInline,
    decodeMs: afterDecode - afterSerialize,
    drawMs: end - afterDecode,
    totalMs: end - start,
  }
  logRasterize({ kind: 'full', width, height, scale, svgBytes: svg.length, ...timings })

  return { canvas: output, scale, svgBytes: svg.length, tainted, timings }
}

// ---- 長いカードのタイル（tiles.ts） ----
// タイルごとに SVG を作り直すと、そのたびに HTML 全体のレイアウトをやり直すことになる。
// そこで SVG は等倍の大きさで 1 度だけ読み込み、タイルは drawImage の元の範囲で切り出して描く。
// SVG は描き先の倍率で描き直されるので、切り出して拡大してもぼやけない（Chromium と Firefox で、タイルごとに作った SVG と同じ画素になることを確かめた）

export interface HtmlImage {
  image: HTMLImageElement
  width: number
  height: number
}

// HTML を SVG の画像として読み込む（等倍の大きさ）
export async function loadHtmlImage(options: { html: string; css: string; width: number; height: number }): Promise<HtmlImage> {
  const start = performance.now()
  const { width, height } = options
  const body = await prepareBody(options.html)
  const afterInline = performance.now()
  const svg = svgOf(body, options.css, width, height, width, height)
  const afterSerialize = performance.now()
  // カード全体の画像（rasterizeHtml の既定）と同じく data: URL で読む（blob: だと Canvas を汚染するブラウザがある）
  const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
  const end = performance.now()
  logRasterize({
    kind: 'tile-source', width, height, scale: 1, svgBytes: svg.length,
    inlineImagesMs: afterInline - start, serializeMs: afterSerialize - afterInline, decodeMs: end - afterSerialize, drawMs: 0, totalMs: end - start,
  })
  return { image, width, height }
}

// 読み込んだ HTML の画像のうち、rect（CSS ピクセル）を scale 倍の解像度で描いた Canvas
export function drawHtmlTile(source: HtmlImage, rect: { x: number; y: number; w: number; h: number }, scale: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(rect.w * scale))
  canvas.height = Math.max(1, Math.round(rect.h * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas2D is not available')
  const start = performance.now()
  ctx.drawImage(source.image, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height)
  const drawMs = performance.now() - start
  logRasterize({ kind: 'tile', width: rect.w, height: rect.h, scale, svgBytes: 0, inlineImagesMs: 0, serializeMs: 0, decodeMs: 0, drawMs, totalMs: drawMs })
  return canvas
}
