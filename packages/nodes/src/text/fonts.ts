// テキストと付箋のフォント（書体。MAI-75）。
// データ（props.fontFamily・run の書式の fontFamily）には、フォントの名前（family）を 1 つだけ持つ。
// - 'sans-serif'・'serif'・'monospace' は CSS の generic family と同じ名前の「ゴシック・明朝・等幅」。
//   実際には、日本語の代表的なフォントを並べた候補（下の GENERIC_FONT_STACKS）で描く。'sans-serif' が既定で、
//   fontFamily を持たない古いノードもこれ（今までと同じ TEXT_FONT_FAMILY）で描く
// - それ以外はフォントの名前そのもの（同梱のフォント、端末のフォントなど）。その後ろに既定の候補を付けて描く
//   （端末にないフォントや、日本語の字を持たないフォントでも、文字は既定のフォントで出る）
// - 同梱のフォント（BUNDLED_FONTS）は Web フォントとして配るので、どの端末でも同じ字形・同じ幅になる。
//   ゴシック・明朝の既定と、端末にないフォントの代わりも、同梱の Noto Sans JP・Noto Serif JP を先頭にする（端末によって変わらない）。
//   データにはフォントの名前（'Noto Sans JP' など）を持ち、描くときに同梱の @font-face の名前（cssFamily）にする
// Canvas の描画と編集用の DOM で同じフォントになるよう、どちらもここの fontFamilyCss で CSS の font-family にする。
//
// Web フォント（同梱の M PLUS 1p）は、使うまで読み込まれない。Canvas の文字は DOM と違って読み込みを始めないので、
// 測るときに読み込みを頼み（requestFontLoad）、読み込み終えたら、測った幅を捨ててレイアウトし直す
// （resetTextMetrics。キャンバスでは document.fonts の loadingdone で呼ぶ）

// 既定（ゴシック）。DOM（編集用の要素）と Canvas で同じフォントになるよう、フォント名を明示する（MAI-21）
export const TEXT_FONT_FAMILY =
  "'Noto Sans JP', 'Noto Sans CJK JP', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic UI', 'Meiryo', sans-serif"

// 既定のフォント（fontFamily を持たないノード・run はこれ）
export const DEFAULT_FONT_FAMILY = 'sans-serif'

// 同梱の日本語フォント（apps/web が @fontsource/m-plus-1p で読み込む。スライドと同じ）
export const BUNDLED_FONT_FAMILY = 'M PLUS 1p'

// 同梱のフォント（apps/web の main.tsx が @fontsource で @font-face を宣言する。使うまで読み込まない）。
// cssFamily は @font-face の名前がフォントの名前と違うもの（可変フォントの @fontsource-variable は「… Variable」）
export interface BundledFont {
  family: string
  label: string
  cssFamily?: string
}

export const BUNDLED_FONTS: readonly BundledFont[] = [
  { family: 'Noto Sans JP', label: 'Noto Sans JP', cssFamily: 'Noto Sans JP Variable' },
  { family: 'Noto Serif JP', label: 'Noto Serif JP', cssFamily: 'Noto Serif JP Variable' },
  { family: BUNDLED_FONT_FAMILY, label: BUNDLED_FONT_FAMILY },
  { family: 'BIZ UDPGothic', label: 'BIZ UDPゴシック' },
  { family: 'BIZ UDPMincho', label: 'BIZ UDP明朝' },
  { family: 'Zen Maru Gothic', label: 'Zen Maru Gothic（丸ゴシック）' },
  { family: 'Klee One', label: 'Klee One（教科書体）' },
  { family: 'Yomogi', label: 'Yomogi（手書き）' },
  { family: 'Dela Gothic One', label: 'Dela Gothic One（極太）' },
  { family: 'M PLUS 1 Code', label: 'M PLUS 1 Code（等幅）', cssFamily: 'M PLUS 1 Code Variable' },
]

// 同梱のゴシック・明朝（可変フォント。100〜900 の太さを持つ）
const BUNDLED_SANS = "'Noto Sans JP Variable'"
const BUNDLED_SERIF = "'Noto Serif JP Variable'"

// ゴシックの既定。同梱の Noto Sans JP を先頭にし、読み込めないとき（ネットワークなど）は端末のゴシック
const SANS_STACK = `${BUNDLED_SANS}, ${TEXT_FONT_FAMILY}`

const GENERIC_FONT_STACKS: Record<string, string> = {
  'sans-serif': SANS_STACK,
  serif: `${BUNDLED_SERIF}, 'Noto Serif JP', 'Noto Serif CJK JP', 'Hiragino Mincho ProN', 'Yu Mincho', 'YuMincho', 'BIZ UDPMincho', 'MS PMincho', serif`,
  monospace: "ui-monospace, 'SFMono-Regular', Menlo, 'DejaVu Sans Mono', 'Noto Sans Mono CJK JP', 'BIZ UDGothic', monospace",
}

export type FontCategory = 'generic' | 'bundled' | 'system'

export interface FontOption {
  family: string
  label: string
  category: FontCategory
}

// いつも選べるフォント（デザインパネルの一覧の先頭）
export const FONT_PRESETS: readonly FontOption[] = [
  { family: 'sans-serif', label: 'ゴシック（標準）', category: 'generic' },
  { family: 'serif', label: '明朝', category: 'generic' },
  { family: 'monospace', label: '等幅', category: 'generic' },
  ...BUNDLED_FONTS.map(({ family, label }): FontOption => ({ family, label, category: 'bundled' })),
]

// 端末にあれば一覧に出すフォント（代表的な日本語のフォントと、よく使う欧文のフォント）
export const SYSTEM_FONT_CANDIDATES: readonly string[] = [
  'Noto Sans JP',
  'Noto Serif JP',
  'Noto Sans CJK JP',
  'Noto Serif CJK JP',
  'Hiragino Sans',
  'Hiragino Kaku Gothic ProN',
  'Hiragino Mincho ProN',
  'Hiragino Maru Gothic ProN',
  'Yu Gothic',
  'Yu Mincho',
  'Meiryo',
  'BIZ UDPGothic',
  'BIZ UDPMincho',
  'MS PGothic',
  'MS PMincho',
  'IPAexGothic',
  'IPAexMincho',
  'Arial',
  'Helvetica',
  'Times New Roman',
  'Georgia',
  'Verdana',
  'Courier New',
]

// props や書式の値を、フォントの名前として読む（なければ・壊れていれば既定）
export function fontFamilyOf(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value : DEFAULT_FONT_FAMILY
}

export function isGenericFontFamily(family: string): boolean {
  return Object.hasOwn(GENERIC_FONT_STACKS, family)
}

// 同梱のフォントか（どの端末でも同じに描ける）
export function isBundledFontFamily(family: string): boolean {
  return BUNDLED_FONTS.some((font) => font.family === family)
}

// 一覧に出す名前
export function fontLabel(family: string): string {
  return FONT_PRESETS.find((option) => option.family === family)?.label ?? family
}

// フォントの名前 → CSS の font-family
export function fontFamilyCss(family: string | undefined): string {
  const name = fontFamilyOf(family)
  const generic = GENERIC_FONT_STACKS[name]
  if (generic) return generic
  // 同梱のフォントは @font-face の名前で（端末に同じ名前のフォントがあっても、同梱のものを使う）
  const css = BUNDLED_FONTS.find((font) => font.family === name)?.cssFamily
  return `${css ? quoteFamily(css) : quoteFamily(name)}, ${SANS_STACK}`
}

function quoteFamily(name: string): string {
  return `"${name.replace(/["\\]/g, '')}"`
}

// CSS の font-family → フォントの名前（ブラウザが編集用の DOM に入れた style を読むときに使う）。
// fontFamilyCss で作ったものはその名前に、そうでなければ先頭のフォントにする
export function fontFamilyFromCss(css: string): string | undefined {
  const normalized = normalizeCss(css)
  if (normalized === '') return undefined
  for (const [family, stack] of Object.entries(GENERIC_FONT_STACKS)) if (normalizeCss(stack) === normalized) return family
  const first = css.split(',')[0]?.trim().replace(/^["']|["']$/g, '')
  // 同梱のフォントの @font-face の名前は、フォントの名前に戻す
  return first ? (BUNDLED_FONTS.find((font) => font.cssFamily === first)?.family ?? first) : undefined
}

function normalizeCss(css: string): string {
  return css
    .split(',')
    .map((part) => part.trim().replace(/^["']|["']$/g, ''))
    .filter((part) => part !== '')
    .join(',')
}

// ---- 読み込みと、測り直し ----

const cacheResets = new Set<() => void>()
let generation = 0
// 頼んだ読み込みが終わり、測った幅が古くなっている
let stale = false
const pendingLoads = new Set<Promise<void>>()

function fontFaceSet(): FontFaceSet | undefined {
  return typeof document !== 'undefined' && document.fonts && typeof document.fonts.check === 'function' ? document.fonts : undefined
}

// 文字の幅などのキャッシュを登録する（resetTextMetrics で捨てる）
export function registerTextMetricsCache(reset: () => void): void {
  cacheResets.add(reset)
}

// レイアウトの世代。resetTextMetrics のたびに増える（ノードの型が props ごとに持つレイアウトのキャッシュは、これで古さを見る）
export function textMetricsGeneration(): number {
  return generation
}

// フォントを読み込み終えたら呼ぶ：測った幅・高さを捨て、レイアウトをやり直させる
export function resetTextMetrics(): void {
  for (const reset of cacheResets) reset()
  generation++
  stale = false
}

// family のフォントで text を描く前に、読み込みを頼む（Web フォントでなければ、何もしない）。
// font は CSS の font（cssFont の値）
export function requestFontLoad(family: string | undefined, font: string, text: string): void {
  // 等幅は Web フォントを持たない（ゴシック・明朝は同梱の Noto を先頭にしているので、読み込みを頼む）
  if (fontFamilyOf(family) === 'monospace') return
  const fonts = fontFaceSet()
  if (!fonts) return
  try {
    if (fonts.check(font, text)) return
    const load: Promise<void> = fonts.load(font, text).then(
      (faces) => {
        if (faces.length > 0) stale = true
      },
      () => {},
    )
    pendingLoads.add(load)
    void load.finally(() => pendingLoads.delete(load))
  } catch {
    // font の書き方が読めないときなど。読み込まずに、代わりのフォントで描く
  }
}

// 頼んだ読み込みがすべて終わるのを待つ（スライドの図・PNG・サムネイルを描く前）。
// 読み込んだフォントがあって、まだ測り直していなければ true（呼んだ側で resetTextMetrics とレイアウトのやり直しをする）
// （document.fonts.ready は待たない。ほかの用途のフォント（数式など）の読み込みで、Canvas の移動を待たせないように）
export async function fontsSettled(): Promise<boolean> {
  while (pendingLoads.size > 0) await Promise.all([...pendingLoads])
  return stale
}
