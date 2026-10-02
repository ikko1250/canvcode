import { LINE_HEIGHT_LIMITS, type LineHeight, type LineHeightUnit } from '@canvcode/nodes'

// デザインパネルの入力欄に打った文字の読み取り（MAI-73）

// 数字。後ろの単位（px・%）は無視する。読めなければ null
export function parseNumber(text: string): number | null {
  const trimmed = text.trim().replace(/(px|%)$/i, '').trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

const HEX_COLOR = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i

// 「#abc」「abc」「#aabbcc」を「#aabbcc」にする。読めなければ null
export function normalizeHexColor(text: string): string | null {
  const match = HEX_COLOR.exec(text.trim())
  if (!match) return null
  const hex = match[1].toLowerCase()
  return `#${hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex}`
}

// 行の高さ（MAI-76）。「24px」は px、「150%」は倍率 1.5、単位のない数字は unit（今の単位）として読む。
// 範囲（LINE_HEIGHT_LIMITS）に収め、倍率は 0.01、px は 0.1 の刻みに丸める。読めなければ null
export function parseLineHeight(text: string, unit: LineHeightUnit): LineHeight | null {
  const trimmed = text.trim().toLowerCase()
  const value = parseNumber(trimmed)
  if (value === null) return null
  if (trimmed.endsWith('px')) return clampLineHeight({ unit: 'px', value })
  if (trimmed.endsWith('%')) return clampLineHeight({ unit: 'multiplier', value: value / 100 })
  return clampLineHeight({ unit, value })
}

export function clampLineHeight(lineHeight: LineHeight): LineHeight {
  const { min, max } = LINE_HEIGHT_LIMITS[lineHeight.unit]
  const digits = lineHeight.unit === 'px' ? 1 : 2
  return { unit: lineHeight.unit, value: Number(Math.min(max, Math.max(min, lineHeight.value)).toFixed(digits)) }
}
