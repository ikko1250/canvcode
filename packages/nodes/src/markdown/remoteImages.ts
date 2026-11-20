import { Marked, type Token } from 'marked'

// AI の答えの Markdown を、キャンバスや付箋に写すときに、外を読み込むものを除く（docs/question-canvas-tools-plan.md の「レビューで見つかったこと」の B）。
// - 画像（![説明](URL)、参照形式の ![説明][名前]、説明に角かっこを含むもの）は、「画像「説明」（URL）」の文字にする（data: の画像は、長いので「画像「説明」」だけ）
// - 生の HTML（AI の答えには HTML を使わせていない）は、タグの < > を全角の ＜ ＞ にして、ただの文字にする。ただし、属性のないタグ
//   （<br>・<b>・<sub>、Vec<T> の <T> など。safeTag）はそのまま残す（属性がなければ外のものを読み込まない。中身を CSS や別の文書として読む
//   style・iframe・svg などは除く）。ただし HTML の塊（行の頭から始まるもの。中は Markdown として読まれない）は、タグをすべて文字にする
//   （中の画像を、次の回で見つけられるように）。HTML のコメントは消す（描いても見えないもの）
// - 見つけるのは marked の字句解析（描くときと同じ読み方）。コード（``` の塊と `…`）の中は、そのまま
// - 生の HTML の塊の中は Markdown として読まれないので、文字にしたあとで中の画像が出てくる。変わらなくなるまで繰り返す（MAX_PASSES 回まで）
// - 最後にもう一度読み、画像か、残してよいもののほかの HTML がまだあれば（引用・リストの中の 2 行にわたる画像など、元の文で場所を見つけられないもの）、
//   コードのほかの < を ＜ に、![ を ！[ にする（最後の守り。ふつうの答えでは起きない）。それでも残れば、コードの中も含めて置き換える
// 写した先（キャンバスのテキスト・付箋に添える答えの写し）は画像を読み込まないが、写しを利用者の文書として描いたときに読み込まないように、写すときに外す
export function withoutRemoteImages(markdown: string): string {
  let out = markdown.replace(/\r\n?/g, '\n')
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next = rebuild(out, onePass)
    if (next === out) break
    out = next
  }
  if (!hasRemote(out)) return out
  const guarded = rebuild(out, (raw) => lastResort(raw))
  return hasRemote(guarded) ? lastResort(guarded) : guarded
}

const MAX_PASSES = 8

// そのまま残すタグ：属性のないタグ。ただし、中身を CSS・スクリプト・別の文書として読むもの、何かを読み込む・埋め込むものは除く
const PLAIN_TAG = /^<\/?([A-Za-z][A-Za-z0-9-]*)\s*\/?>$/
const UNSAFE_ELEMENTS = new Set([
  'applet', 'audio', 'base', 'embed', 'frame', 'frameset', 'iframe', 'image', 'img', 'input', 'link', 'math', 'meta', 'noembed', 'noframes',
  'noscript', 'object', 'picture', 'plaintext', 'portal', 'script', 'source', 'style', 'svg', 'template', 'textarea', 'title', 'track', 'video', 'xmp',
])

function safeTag(tag: string): boolean {
  const name = PLAIN_TAG.exec(tag)?.[1]?.toLowerCase()
  return name !== undefined && !UNSAFE_ELEMENTS.has(name)
}

function lexer(): Marked {
  return new Marked({ gfm: true, breaks: false })
}

// 上の段の字句ごとに組み直す（字句の raw をつなぐと、元の文に戻る）。``` の塊はそのまま残し、ほかは change に渡す（`…` の中は change に見せない）
function rebuild(markdown: string, change: (raw: string, token: Token) => string): string {
  return lexer()
    .lexer(markdown)
    .map((token) => (token.type === 'code' ? token.raw : withCodeSpansKept(token, (raw) => change(raw, token))))
    .join('')
}

// 1 回の置き換え：生の HTML の塊はタグを文字にし、ほかの字句は、中の画像と生の HTML を置き換える
function onePass(raw: string, token: Token): string {
  if (token.type === 'html') return htmlAsText(raw, true)
  const replacements = new Map<string, string>()
  lexer().walkTokens([token], (inner: Token) => {
    if (inner.type === 'image') replacements.set(inner.raw, imageText(inner.text, inner.href))
    else if (inner.type === 'html') replacements.set(inner.raw, htmlAsText(inner.raw, inner.block))
  })
  let out = raw
  // 長いものから置き換える（画像を含む生の HTML などで、短いものが先に一部を変えないように）
  for (const [from, to] of [...replacements].sort((a, b) => b[0].length - a[0].length)) if (from) out = out.split(from).join(to)
  return out
}

// `…`（コードの字句）を目印に置き換えてから change に渡し、戻す（コードの中は変えない）
function withCodeSpansKept(token: Token, change: (raw: string) => string): string {
  const spans: string[] = []
  lexer().walkTokens([token], (inner: Token) => {
    if (inner.type === 'codespan' && inner.raw && token.raw.includes(inner.raw)) spans.push(inner.raw)
  })
  let raw = token.raw
  spans.forEach((span, i) => (raw = raw.split(span).join(`\u0000${i}\u0000`)))
  let out = change(raw)
  spans.forEach((span, i) => (out = out.split(`\u0000${i}\u0000`).join(span)))
  return out
}

// 生の HTML を文字にする：コメントは消し、< > を全角にする。文の中のもの（block でない）は、残してよいタグをそのまま残す
function htmlAsText(raw: string, block: boolean): string {
  return raw.replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/<[^<>]*>?/g, (tag) => (!block && safeTag(tag) ? tag : tag.replace(/</g, '＜').replace(/>/g, '＞')))
}

// 画像か、残してよいもののほかの生の HTML が残っているか（入れ子の字句もすべて見る）
function hasRemote(markdown: string): boolean {
  const marked = lexer()
  let found = false
  marked.walkTokens(marked.lexer(markdown), (token: Token) => {
    if (token.type === 'image') found = true
    else if (token.type === 'html' && (htmlAsText(token.raw, token.block).includes('＜') || /<!--/.test(token.raw))) found = true
  })
  return found
}

// 最後の守り：< を ＜ に、![ を ！[ にする（残してよいタグも含めて）
function lastResort(raw: string): string {
  return raw.replace(/</g, '＜').replace(/!\[/g, '！[')
}

function imageText(alt: string, url: string): string {
  const label = alt.trim() ? `画像「${alt.trim()}」` : '画像'
  return url && !/^data:/i.test(url.trim()) ? `${label}（${url.trim()}）` : label
}
