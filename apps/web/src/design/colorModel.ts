import type { SharedValue } from '@canvcode/canvas'
import { normalizeColor, paintCss, parseHexColor, rgbToHex, type Fill, type PaintType } from '@canvcode/nodes'
import { normalizeHexColor } from './parse.ts'

// カラーピッカーの色の計算（MAI-81）。ピッカーは HSV（色相・彩度・明度）で動かし、ノードには #rrggbb で入れる

export interface Hsv {
  // 色相（0〜360）
  h: number
  // 彩度・明度（0〜1）
  s: number
  v: number
}

export function hexToHsv(hex: string): Hsv | null {
  const rgb = parseHexColor(hex)
  if (!rgb) return null
  const r = rgb.r / 255
  const g = rgb.g / 255
  const b = rgb.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const c = v * s
  const hh = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hh % 2) - 1))
  const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x]
  const m = v - c
  return rgbToHex({ r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 })
}

// 今の HSV（ピッカーが持っている値）が hex と同じ色なら、そのまま使う。
// 灰色（彩度 0）や黒（明度 0）は色相が決まらないので、外から同じ色が来ても、ピッカーの色相を動かさない
export function syncHsv(current: Hsv | null, hex: string): Hsv | null {
  if (current && hsvToHex(current) === hex.toLowerCase()) return current
  const next = hexToHsv(hex)
  if (!next) return current
  if (current && (next.s === 0 || next.v === 0)) return { ...next, h: current.h, s: next.v === 0 ? current.s : next.s }
  return next
}

// スポイト（EyeDropper API）で取った色（Chromium は #rrggbb。rgb() のこともある）を #rrggbb にする
export function eyeDropperColor(value: string): string | null {
  const hex = normalizeHexColor(value)
  if (hex) return hex
  const match = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(value.trim())
  if (!match) return null
  return rgbToHex({ r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) })
}

// 選んでいるノードの塗りから、パネルに出す値（色・不透明度・種類は、すべて同じときだけ。違えば null）。
// preview は見本の CSS の background（グラデーションなら CSS のグラデーション）
export function paintSummary(value: SharedValue<Fill>) {
  const fills = value.kind === 'same' ? [value.value] : value.values
  const first = fills[0]
  const allNone = fills.every((fill) => fill === null)
  const anyNone = fills.some((fill) => fill === null)
  const color = !anyNone && first?.type === 'solid' && fills.every((fill) => fill?.type === 'solid' && normalizeColor(fill.color) === normalizeColor(first.color)) ? first.color : null
  const opacity = !anyNone && first && fills.every((fill) => fill?.opacity === first.opacity) ? first.opacity : null
  const type: PaintType | null = !anyNone && first && fills.every((fill) => fill?.type === first.type) ? first.type : null
  return { allNone, anyNone, color, opacity, type, preview: value.kind === 'same' ? paintCss(value.value) : null }
}
