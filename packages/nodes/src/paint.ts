import type { Box } from '@canvcode/core'

// 塗り（MAI-81）。図形（geo）の塗りの形と、Canvas への描き方。
// 後の課題の、グラデーション（MAI-82）・画像（MAI-83）・ボーダー（MAI-85）・ブロック矢印（MAI-87）も同じ形を使う。
// - Paint は「種類（type）＋中身」。今は単色（solid）だけ。種類を足すときは、union に足して paintStyle・paintColors を対応させる
// - opacity は塗りの不透明度（0〜1）。種類によらず持つ（Figma と同じ）。ノードの不透明度（NodeRecord.opacity）とは別で、掛け合わせて描く
// - 塗りなしは null（Fill）。Figma のような塗りの配列（重ね塗り）にはしない：パネルで 1 つの塗りを選ぶ UI に合わせ、
//   重ねたくなったら fill を fills: Paint[] に移す版を足す（描くのは fillShape だけなので、移しやすい）

export interface SolidPaint {
  type: 'solid'
  // 色（#rrggbb。古いデータや取り込みでは CSS の色の文字列のこともある）
  color: string
  // 塗りの不透明度（0〜1）
  opacity: number
}

export type Paint = SolidPaint

export type PaintType = Paint['type']

// 塗り。null は塗りなし
export type Fill = Paint | null

export function solidPaint(color: string, opacity = 1): SolidPaint {
  return { type: 'solid', color, opacity: clampOpacity(opacity) }
}

export function clampOpacity(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1
}

export function isPaint(value: unknown): value is Paint {
  if (typeof value !== 'object' || value === null) return false
  const paint = value as Partial<SolidPaint>
  return paint.type === 'solid' && typeof paint.color === 'string'
}

// 塗りとして読む。色の文字列（版 1 の geo の fill）は単色の塗りに、空・'none'・'transparent' は塗りなしにする。
// 読めないもの（知らない種類など）は fallback
export function toFill(value: unknown, fallback: Fill = null): Fill {
  if (value === null) return null
  if (typeof value === 'string') {
    const color = value.trim()
    if (color === '' || color === 'none' || color === 'transparent') return null
    return solidPaint(color)
  }
  if (isPaint(value)) return { ...value, opacity: clampOpacity(typeof value.opacity === 'number' ? value.opacity : 1) }
  return fallback
}

// 今の Canvas のパスを、塗りで塗る（ctx はノードのローカル座標）。box は塗る形の外接の箱（グラデーション・画像の位置に使う）。
// 塗りの不透明度は globalAlpha に掛ける（ノードの不透明度はすでに掛かっている）。パスはそのまま残る（あとで線を描ける）
export function fillShape(ctx: CanvasRenderingContext2D, fill: Fill, box: Box): void {
  if (!fill || fill.opacity <= 0) return
  ctx.save()
  ctx.globalAlpha *= fill.opacity
  ctx.fillStyle = paintStyle(ctx, fill, box)
  ctx.fill()
  ctx.restore()
}

// Canvas の fillStyle（strokeStyle）にする値。不透明度は含めない（fillShape が globalAlpha で掛ける）
export function paintStyle(_ctx: CanvasRenderingContext2D, paint: Paint, _box: Box): string | CanvasGradient | CanvasPattern {
  switch (paint.type) {
    case 'solid':
      return paint.color
  }
}

// 塗りを 1 色で表すとき（ズームアウト時の簡略描画・パネルの見本）の CSS の色。不透明度も入れる。塗りなしは null
export function fillPreviewColor(fill: Fill): string | null {
  if (!fill) return null
  switch (fill.type) {
    case 'solid':
      return colorWithAlpha(fill.color, fill.opacity)
  }
}

// 塗りに使っている色（「このキャンバスで使った色」の一覧に出す。グラデーションなら止め色）
export function paintColors(fill: Fill): string[] {
  if (!fill) return []
  switch (fill.type) {
    case 'solid':
      return [fill.color]
  }
}

// ---- 色 ----

export interface Rgba {
  r: number
  g: number
  b: number
  // 0〜1
  a: number
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

// #rgb・#rgba・#rrggbb・#rrggbbaa を読む。それ以外（rgb() や色の名前）は null
export function parseHexColor(color: string): Rgba | null {
  const match = HEX.exec(color.trim())
  if (!match) return null
  let hex = match[1]
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join('')
  const value = (i: number) => parseInt(hex.slice(i, i + 2), 16)
  return { r: value(0), g: value(2), b: value(4), a: hex.length === 8 ? Math.round((value(6) / 255) * 1000) / 1000 : 1 }
}

// #rrggbb（小文字）。a は入れない
export function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const part = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

// 色の比べ方をそろえる（#ABC → #aabbcc）。16 進で書いていない色は、前後の空白を除いてそのまま
export function normalizeColor(color: string): string {
  const rgba = parseHexColor(color)
  if (!rgba) return color.trim()
  return rgba.a < 1 ? `${rgbToHex(rgba)}${Math.round(rgba.a * 255).toString(16).padStart(2, '0')}` : rgbToHex(rgba)
}

// 色に不透明度を掛けた CSS の色。16 進で読めない色で 1 未満なら、そのまま返す（呼ぶ側で globalAlpha を使う）
export function colorWithAlpha(color: string, alpha: number): string {
  if (alpha >= 1) return color
  const rgba = parseHexColor(color)
  if (!rgba) return color
  return `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${Math.round(rgba.a * clampOpacity(alpha) * 1000) / 1000})`
}
