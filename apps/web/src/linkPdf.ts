// リンクのカードの PDF を取ってくる（サーバーの /api/link-preview/pdf。apps/server/src/linkPreview.ts）。
// ブラウザからはほかのサイトの PDF を CORS で読めないので、サーバーが代わりに取ってくる

// URL のパスが .pdf で終わるものを、PDF の URL とみなす（「PDF ポータルを作成」を出す）
export function isPdfUrl(url: string): boolean {
  try {
    return /\.pdf$/i.test(new URL(url).pathname)
  } catch {
    return false
  }
}

// PDF をダウンロードして File にする。失敗したら、知らせる文を投げる
export async function downloadLinkPdf(url: string): Promise<File> {
  const response = await fetch(`/api/link-preview/pdf?url=${encodeURIComponent(url)}`)
  if (!response.ok) {
    if (response.status === 413) throw new Error('PDF が大きすぎるので、取り込めません（100MB まで）')
    if (response.status === 415) throw new Error('リンク先は PDF ではありませんでした')
    const result = (await response.json().catch(() => ({}))) as { error?: unknown }
    throw new Error(`PDF をダウンロードできませんでした${typeof result.error === 'string' ? `：${result.error}` : `（エラー ${response.status}）`}`)
  }
  const blob = await response.blob()
  const encodedName = response.headers.get('x-canvcode-filename')
  const name = encodedName ? decodeURIComponent(encodedName) : 'PDF'
  return new File([blob], `${name}.pdf`, { type: 'application/pdf' })
}
