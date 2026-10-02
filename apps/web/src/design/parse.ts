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
