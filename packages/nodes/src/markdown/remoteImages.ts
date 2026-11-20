// AI の答えの Markdown を、キャンバスや付箋に写すときに、外の画像を除く（docs/question-canvas-tools-plan.md の「レビューで見つかったこと」の B）。
// 画像（![説明](URL) と生の HTML の <img>）を、「画像「説明」（URL）」の文字にする（data: の画像は、長いので「画像「説明」」だけ）。
// 写した先（キャンバスのテキスト・付箋に添える答えの写し）は画像を読み込まないが、写しをまた Markdown として描いたときに読み込まないように、写すときにも外す

const MARKDOWN_IMAGE = /!\[([^\]\n]*)\]\(\s*<?([^\s)>]*)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g
const HTML_IMAGE = /<img\b[^>]*>/gi

export function withoutRemoteImages(markdown: string): string {
  return markdown.replace(MARKDOWN_IMAGE, (_, alt: string, url: string) => imageText(alt, url)).replace(HTML_IMAGE, (tag) => imageText(attribute(tag, 'alt'), attribute(tag, 'src')))
}

function imageText(alt: string, url: string): string {
  const label = alt.trim() ? `画像「${alt.trim()}」` : '画像'
  return url && !/^data:/i.test(url.trim()) ? `${label}（${url.trim()}）` : label
}

function attribute(tag: string, name: string): string {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : ''
}
