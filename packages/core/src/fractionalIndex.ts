// 重なり順を表す fractional index（MAI-7）。
// 文字列の辞書順がそのまま並び順になり、任意の 2 つの間に新しいキーを作れる。
// キーは「整数部」＋「小数部」でできている。整数部の先頭の文字が整数部の長さを表すので、
// 末尾への追加を繰り返してもキーはゆっくりとしか長くならない。
// 考え方は David Greenspan「Implementing Fractional Indexing」による。

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const BASE = DIGITS.length
const INTEGER_ZERO = 'a0'
const SMALLEST_INTEGER = 'A' + '0'.repeat(26)

function digitValue(ch: string): number {
  const value = DIGITS.indexOf(ch)
  if (value < 0) throw new Error(`Invalid index digit: ${ch}`)
  return value
}

function integerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2
  if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2
  throw new Error(`Invalid index head: ${head}`)
}

function integerPart(key: string): string {
  const length = integerLength(key[0])
  if (length > key.length) throw new Error(`Invalid index: ${key}`)
  return key.slice(0, length)
}

export function isValidIndex(key: string): boolean {
  try {
    if (key === SMALLEST_INTEGER) return false
    const int = integerPart(key)
    const fraction = key.slice(int.length)
    for (const ch of key.slice(1)) digitValue(ch)
    return !fraction.endsWith('0')
  } catch {
    return false
  }
}

// 小数部どうしの中間。a < b、どちらも末尾は '0' でない（a は空文字でもよい）。b が null なら上限なし。
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0
    while ((a[n] ?? '0') === b[n]) n++
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
  }
  const da = a ? digitValue(a[0]) : 0
  const db = b !== null ? digitValue(b[0]) : BASE
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)]
  if (b !== null && b.length > 1) return b.slice(0, 1)
  return DIGITS[da] + midpoint(a.slice(1), null)
}

function incrementInteger(x: string): string | null {
  const head = x[0]
  const digits = x.slice(1).split('')
  let carry = true
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const d = digitValue(digits[i]) + 1
    if (d === BASE) {
      digits[i] = '0'
    } else {
      digits[i] = DIGITS[d]
      carry = false
    }
  }
  if (!carry) return head + digits.join('')
  if (head === 'Z') return INTEGER_ZERO
  if (head === 'z') return null
  const nextHead = String.fromCharCode(head.charCodeAt(0) + 1)
  if (nextHead > 'a') digits.push('0')
  else digits.pop()
  return nextHead + digits.join('')
}

function decrementInteger(x: string): string | null {
  const head = x[0]
  const digits = x.slice(1).split('')
  let borrow = true
  for (let i = digits.length - 1; borrow && i >= 0; i--) {
    const d = digitValue(digits[i]) - 1
    if (d === -1) {
      digits[i] = DIGITS[BASE - 1]
    } else {
      digits[i] = DIGITS[d]
      borrow = false
    }
  }
  if (!borrow) return head + digits.join('')
  if (head === 'a') return 'Z' + DIGITS[BASE - 1]
  if (head === 'A') return null
  const prevHead = String.fromCharCode(head.charCodeAt(0) - 1)
  if (prevHead < 'Z') digits.push(DIGITS[BASE - 1])
  else digits.pop()
  return prevHead + digits.join('')
}

// a と b の間に入るキー。a が null なら先頭、b が null なら末尾に置くキーになる。
export function indexBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) throw new Error(`Index ${a} is not less than ${b}`)
  if (a === null) {
    if (b === null) return INTEGER_ZERO
    const ib = integerPart(b)
    const fb = b.slice(ib.length)
    if (ib === SMALLEST_INTEGER) return ib + midpoint('', fb)
    if (ib < b) return ib
    const prev = decrementInteger(ib)
    if (prev === null) throw new Error('Cannot create an index before the smallest one')
    return prev
  }
  const ia = integerPart(a)
  const fa = a.slice(ia.length)
  if (b === null) {
    const next = incrementInteger(ia)
    return next === null ? ia + midpoint(fa, null) : next
  }
  const ib = integerPart(b)
  const fb = b.slice(ib.length)
  if (ia === ib) return ia + midpoint(fa, fb)
  const next = incrementInteger(ia)
  if (next === null) throw new Error('Cannot increment index')
  if (next < b) return next
  return ia + midpoint(fa, null)
}

// a と b の間に n 個のキーを昇順で作る。二分して作るので、n が大きくてもキーが長くなりにくい。
export function indicesBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return []
  if (n === 1) return [indexBetween(a, b)]
  if (b === null) {
    // 末尾への一括追加は、整数部を順に増やすだけで済む
    const keys: string[] = []
    let prev = a
    for (let i = 0; i < n; i++) {
      prev = indexBetween(prev, null)
      keys.push(prev)
    }
    return keys
  }
  const mid = Math.floor(n / 2)
  const midKey = indexBetween(a, b)
  return [...indicesBetween(a, midKey, mid), midKey, ...indicesBetween(midKey, b, n - mid - 1)]
}
