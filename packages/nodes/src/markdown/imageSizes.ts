// Markdown の中の画像の大きさ（画素）。高さを中身に合わせるカードは、計測用の DOM では画像を読み込まないうちに測るので、
// 画像の高さが 0 になり、画像より下が切れていた。大きさを別に読み込んでおき、わかったら知らせて測り直させる（#33）。
// キャンバスの画面（packages/canvas）からも知らせを受けるので、重い Markdown のモジュールを読み込まないよう、ここだけ別にする

export interface ImageSize {
  width: number
  height: number
}

// 読み終えた大きさ（読めなかった・大きさのない画像は null）。捨てると、待っているカードがまた読み込んで測り直し続けるので、
// 捨てない（data: URL はそのまま持つと大きいので、ハッシュをキーにする）
const sizes = new Map<string, ImageSize | null>()
const loading = new Set<string>()
const listeners = new Set<() => void>()
let notifyPending = false

// src の画像の大きさ。まだわからなければ読み込みを始めて undefined を返す。読めなかった・大きさのない画像は null
export function markdownImageSize(src: string): ImageSize | null | undefined {
  const key = sizeKey(src)
  const known = sizes.get(key)
  if (known !== undefined) return known
  if (!loading.has(key) && typeof Image !== 'undefined' && typeof fetch !== 'undefined') {
    loading.add(key)
    void loadSize(src).then((size) => {
      loading.delete(key)
      sizes.set(key, size)
      scheduleNotify()
    })
  }
  return undefined
}

// 画像の大きさがわかったら呼ぶ（同時にわかったものは 1 回にまとめる）。外す関数を返す
export function onMarkdownImageSize(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// カードを描くとき（rasterize.ts の inlineImages）と同じく fetch で読む。fetch で読めない画像（CORS を許さないサイトなど）は、
// 描くときに代わりの文字になるので、大きさも null にして、画像の分の高さを取らない
async function loadSize(src: string): Promise<ImageSize | null> {
  try {
    const response = await fetch(src)
    if (!response.ok) return null
    const url = URL.createObjectURL(await response.blob())
    try {
      // 大きさだけが要るので、decode() で画素まで展開せず、読み込めたら natural の大きさを見る
      const image = new Image()
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = () => reject(new Error('image load failed'))
        image.src = url
      })
      return image.naturalWidth > 0 && image.naturalHeight > 0 ? { width: image.naturalWidth, height: image.naturalHeight } : null
    } finally {
      URL.revokeObjectURL(url)
    }
  } catch {
    return null
  }
}

function sizeKey(src: string): string {
  if (!src.startsWith('data:')) return src
  // FNV-1a
  let hash = 0x811c9dc5
  for (let i = 0; i < src.length; i++) {
    hash ^= src.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `data:${src.length}:${(hash >>> 0).toString(36)}`
}

function scheduleNotify(): void {
  if (notifyPending) return
  notifyPending = true
  queueMicrotask(() => {
    notifyPending = false
    for (const listener of listeners) listener()
  })
}
