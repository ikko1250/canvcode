import katexCss from 'katex/dist/katex.min.css?raw'

// SVG に埋め込むための KaTeX の CSS（MAI-21）。
// SVG を画像として読み込むと外部のフォントを読めないので、woff2 を data: URL にして @font-face に埋め込む。
// Vite の機能（?raw、import.meta.glob）を使うので、packages/nodes ではなくここに置いている。

const fontUrls = import.meta.glob('../../../../node_modules/katex/dist/fonts/*.woff2', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>

interface FontFile {
  family: string
  weight: 'normal' | 'bold'
  style: 'normal' | 'italic'
  url: string
  // 'KaTeX_Main-Bold' など
  name: string
}

const FONT_FILES: FontFile[] = Object.entries(fontUrls).map(([path, url]) => {
  const name = path.split('/').pop()!.replace('.woff2', '')
  const [family, variant] = name.split('-')
  return {
    family,
    weight: variant.includes('Bold') ? 'bold' : 'normal',
    style: variant.includes('Italic') ? 'italic' : 'normal',
    url,
    name,
  }
})

// KaTeX の CSS から、外部のフォントを読みに行く @font-face を取り除いたもの
export const KATEX_BASE_CSS = katexCss.replace(/@font-face\{[^}]*\}/g, '')

// HTML に含まれる KaTeX のクラスから、必要なフォントを推測する
const CLASS_TO_FONTS: [RegExp, string[]][] = [
  [/class="[^"]*\bkatex\b/, ['KaTeX_Main-Regular', 'KaTeX_Math-Italic']],
  [/\b(mathbf|textbf)\b/, ['KaTeX_Main-Bold']],
  [/\bboldsymbol\b/, ['KaTeX_Math-BoldItalic', 'KaTeX_Main-Bold']],
  [/\b(mathit|textit)\b/, ['KaTeX_Main-Italic']],
  [/\bamsrm\b/, ['KaTeX_AMS-Regular']],
  [/\bmathcal\b/, ['KaTeX_Caligraphic-Regular']],
  [/\b(mathfrak|textfrak)\b/, ['KaTeX_Fraktur-Regular']],
  [/\b(mathscr|textscr)\b/, ['KaTeX_Script-Regular']],
  [/\b(mathsf|textsf)\b/, ['KaTeX_SansSerif-Regular']],
  [/\b(mathtt|texttt)\b/, ['KaTeX_Typewriter-Regular']],
  [
    /\b(delimsizing|op-symbol|delimcenter|sqrt|stretchy)\b/,
    ['KaTeX_Size1-Regular', 'KaTeX_Size2-Regular', 'KaTeX_Size3-Regular', 'KaTeX_Size4-Regular'],
  ],
]

export type FontMode = 'auto' | 'all' | 'none'

export function pickFonts(html: string, mode: FontMode): FontFile[] {
  if (mode === 'none') return []
  if (mode === 'all') return FONT_FILES
  const names = new Set<string>()
  for (const [pattern, fonts] of CLASS_TO_FONTS) {
    if (pattern.test(html)) for (const font of fonts) names.add(font)
  }
  return FONT_FILES.filter((font) => names.has(font.name))
}

const dataUrlCache = new Map<string, Promise<string>>()

function fontDataUrl(url: string): Promise<string> {
  let cached = dataUrlCache.get(url)
  if (!cached) {
    cached = fetch(url)
      .then((response) => response.blob())
      .then(
        (blob) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result))
            reader.onerror = () => reject(reader.error)
            reader.readAsDataURL(new Blob([blob], { type: 'font/woff2' }))
          }),
      )
    dataUrlCache.set(url, cached)
  }
  return cached
}

export interface EmbeddedCss {
  css: string
  fonts: string[]
  fontBytes: number
}

export async function buildEmbeddedKatexCss(html: string, mode: FontMode): Promise<EmbeddedCss> {
  const fonts = pickFonts(html, mode)
  const faces = await Promise.all(
    fonts.map(async (font) => {
      const dataUrl = await fontDataUrl(font.url)
      return {
        bytes: dataUrl.length,
        css: `@font-face{font-family:${font.family};src:url(${dataUrl}) format("woff2");font-weight:${font.weight};font-style:${font.style}}`,
      }
    }),
  )
  return {
    css: faces.map((face) => face.css).join('') + KATEX_BASE_CSS,
    fonts: fonts.map((font) => font.name),
    fontBytes: faces.reduce((sum, face) => sum + face.bytes, 0),
  }
}
