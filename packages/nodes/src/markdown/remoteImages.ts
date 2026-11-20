import { Marked, type Token } from 'marked'

// AI の答えの Markdown を、キャンバスや付箋に写すときに、外を読み込むものを除く（docs/question-canvas-tools-plan.md の「レビューで見つかったこと」の B）。
// - 画像（![説明](URL)、参照形式の ![説明][名前]、説明に角かっこを含むもの）は、「画像「説明」（URL）」の文字にする（data: の画像は、長いので「画像「説明」」だけ）
// - 生の HTML（<img>・<input type=image>・<video poster>・<image> など。AI の答えには HTML を使わせていない）は、タグの < > を全角の ＜ ＞ にして、ただの文字にする
// - 見つけるのは marked の字句解析（描くときと同じ読み方）。コードの中のものは、そのまま
// 写した先（キャンバスのテキスト・付箋に添える答えの写し）は画像を読み込まないが、写しを利用者の文書として描いたときに読み込まないように、写すときに外す
export function withoutRemoteImages(markdown: string): string {
  const marked = new Marked({ gfm: true, breaks: false })
  const replacements = new Map<string, string>()
  marked.walkTokens(marked.lexer(markdown), (token: Token) => {
    if (token.type === 'image') replacements.set(token.raw, imageText(token.text, token.href))
    else if (token.type === 'html') replacements.set(token.raw, token.raw.replace(/</g, '＜').replace(/>/g, '＞'))
  })
  let out = markdown
  // 長いものから置き換える（画像を含む生の HTML などで、短いものが先に一部を変えないように）
  for (const [raw, text] of [...replacements].sort((a, b) => b[0].length - a[0].length)) if (raw) out = out.split(raw).join(text)
  return out
}

function imageText(alt: string, url: string): string {
  const label = alt.trim() ? `画像「${alt.trim()}」` : '画像'
  return url && !/^data:/i.test(url.trim()) ? `${label}（${url.trim()}）` : label
}
