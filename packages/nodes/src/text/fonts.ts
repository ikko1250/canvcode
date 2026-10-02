// テキストと付箋のフォント（書体。MAI-75）。
// データ（props.fontFamily・run の書式の fontFamily）には、フォントの名前（family）を 1 つだけ持つ。
// - 'sans-serif'・'serif'・'monospace' は CSS の generic family と同じ名前の「ゴシック・明朝・等幅」。
//   実際には、日本語の代表的なフォントを並べた候補（下の GENERIC_FONT_STACKS）で描く。'sans-serif' が既定で、
//   fontFamily を持たない古いノードもこれ（今までと同じ TEXT_FONT_FAMILY）で描く
// - それ以外はフォントの名前そのもの（同梱の M PLUS 1p、端末のフォントなど）。その後ろに既定の候補を付けて描く
//   （端末にないフォントや、日本語の字を持たないフォントでも、文字は既定のフォントで出る）
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

const GENERIC_FONT_STACKS: Record<string, string> = {
  'sans-serif': TEXT_FONT_FAMILY,
  serif: "'Noto Serif JP', 'Noto Serif CJK JP', 'Hiragino Mincho ProN', 'Yu Mincho', 'YuMincho', 'BIZ UDPMincho', 'MS PMincho', serif",
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
  { family: BUNDLED_FONT_FAMILY, label: BUNDLED_FONT_FAMILY, category: 'bundled' },
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

// 一覧に出す名前
export function fontLabel(family: string): string {
  return FONT_PRESETS.find((option) => option.family === family)?.label ?? family
}

// フォントの名前 → CSS の font-family
export function fontFamilyCss(family: string | undefined): string {
  const name = fontFamilyOf(family)
  return GENERIC_FONT_STACKS[name] ?? `${quoteFamily(name)}, ${TEXT_FONT_FAMILY}`
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
  return first ? first : undefined
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
  if (isGenericFontFamily(fontFamilyOf(family))) return
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
