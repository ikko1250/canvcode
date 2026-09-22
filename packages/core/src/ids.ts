// レコードの ID（MAI-7）。種類を表す接頭辞＋短いランダム文字列。
// 16 文字の base62 は約 95 ビットあり、端末をまたいでも衝突しない（MAI-15）。

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const ID_LENGTH = 16

export type IdPrefix = 'node' | 'binding' | 'asset' | 'canvas' | 'file' | 'anchor'

export function randomIdSuffix(length = ID_LENGTH): string {
  const bytes = new Uint8Array(length * 2)
  let out = ''
  while (out.length < length) {
    crypto.getRandomValues(bytes)
    // 248 = 62 * 4。これ以上の値を捨てて、偏りなく 62 通りに割り当てる
    for (const byte of bytes) {
      if (byte < 248) out += ALPHABET[byte % 62]
      if (out.length === length) break
    }
  }
  return out
}

export function createId<P extends IdPrefix>(prefix: P): `${P}:${string}` {
  return `${prefix}:${randomIdSuffix()}`
}
