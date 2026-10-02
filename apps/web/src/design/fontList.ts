import { FONT_PRESETS, SYSTEM_FONT_CANDIDATES, fontLabel, isGenericFontFamily, type FontOption } from '@canvcode/nodes'

// デザインパネルのフォントの一覧（MAI-75）。
// - いつも出す：ゴシック・明朝・等幅（CSS の generic family）と、同梱の M PLUS 1p（@fontsource/m-plus-1p）
// - 端末にあれば出す：代表的な日本語のフォント・欧文のフォントの候補（SYSTEM_FONT_CANDIDATES）。
//   あるかどうかは、代わりのフォント（generic family）と幅が違うかで見る
// - Local Font Access API（queryLocalFonts）が使えるブラウザでは、頼まれたら端末のフォントをすべて足す（権限を聞かれる）

const PROBE_TEXT = 'mmmmmmmmmmlli WwQq 0123 永あア漢字'
const PROBE_FONT_SIZE = 32
const FALLBACKS = ['monospace', 'serif', 'sans-serif']

let systemFonts: string[] | null = null
let localFonts: string[] = []

function measureContext(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null
  try {
    return document.createElement('canvas').getContext('2d')
  } catch {
    return null
  }
}

// family が端末にあるか（どの代わりのフォントとも幅が違えば、ある）
export function isFontInstalled(family: string, ctx: CanvasRenderingContext2D | null = measureContext()): boolean {
  if (!ctx) return false
  const width = (font: string) => {
    ctx.font = `${PROBE_FONT_SIZE}px ${font}`
    return ctx.measureText(PROBE_TEXT).width
  }
  const quoted = `"${family.replace(/["\\]/g, '')}"`
  return FALLBACKS.some((fallback) => width(`${quoted}, ${fallback}`) !== width(fallback))
}

// 端末にある候補のフォント（一度だけ調べる）
export function installedSystemFonts(): string[] {
  if (!systemFonts) {
    const ctx = measureContext()
    systemFonts = ctx ? SYSTEM_FONT_CANDIDATES.filter((family) => isFontInstalled(family, ctx)) : []
  }
  return systemFonts
}

export function canQueryLocalFonts(): boolean {
  return typeof window !== 'undefined' && typeof (window as WindowWithLocalFonts).queryLocalFonts === 'function'
}

interface WindowWithLocalFonts extends Window {
  queryLocalFonts?: () => Promise<{ family: string }[]>
}

// 端末のフォントをすべて読む（Local Font Access API。権限を断られたら、今までの一覧のまま）
export async function loadLocalFonts(): Promise<string[]> {
  const query = (window as WindowWithLocalFonts).queryLocalFonts
  if (!query) return localFonts
  try {
    const fonts = await query.call(window)
    localFonts = [...new Set(fonts.map((font) => font.family))].sort((a, b) => a.localeCompare(b))
  } catch (error) {
    console.warn('Failed to query local fonts', error)
  }
  return localFonts
}

// 一覧（同じ名前は 1 つ）。current（選んでいるフォント）が一覧になければ、端末のフォントとして足す（ほかの端末で選んだフォントなど）
export function fontOptions(current: readonly string[] = []): FontOption[] {
  const out: FontOption[] = [...FONT_PRESETS]
  const seen = new Set(out.map((option) => option.family))
  const add = (family: string) => {
    if (seen.has(family) || isGenericFontFamily(family)) return
    seen.add(family)
    out.push({ family, label: fontLabel(family), category: 'system' })
  }
  for (const family of installedSystemFonts()) add(family)
  for (const family of localFonts) add(family)
  for (const family of current) add(family)
  return out
}
