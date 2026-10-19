import { findMatches, type Box, type PdfSearchPage } from '@canvcode/core'
import type { PdfTextItem } from './quotes.ts'

// PDF の単語検索（試作）。一致するページと件数はサーバーが pages.json で探し（GET /api/assets/<ハッシュ>/search）、
// ハイライトする位置は、一致したページだけ、ブラウザで文字の断片（PDF.js の getTextContent）から出す。DOM を使わない部分だけをここに置く

export interface PdfSearchResponse {
  // 'pending'：テキストをまだ取り出していない / 'textless'：どのページにも文字がない（スキャンした PDF など）
  status: 'ok' | 'pending' | 'textless'
  total: number
  pages: PdfSearchPage[]
}

// ページの文字の断片の中で、一致したところの矩形（ポイント、ページの左上が原点）。
// 1 つの一致が複数の断片（行をまたぐときなど）にかかれば、矩形も複数になる。断片の中で文字の幅は等しいとみなす。
// 一致は、ページの上から（同じ行なら左から）の順に並べる。断片は PDF に書かれた順で、スライドを PDF にしたものなどでは、
// 置いた順（テキストボックスを作った順）になっていて、見た目の順とは限らないので
export function matchRects(items: readonly PdfTextItem[], query: string): Box[][] {
  return sortByReadingOrder(findRects(items, query))
}

function findRects(items: readonly PdfTextItem[], query: string): Box[][] {
  // 断片はそのままつなぐ（サーバーのテキストも、断片をつないで改行を入れただけ。空白と改行は比べるときに無視する）
  const starts: number[] = []
  let text = ''
  for (const item of items) {
    starts.push(text.length)
    text += item.text
  }
  return findMatches(text, query).map(({ from, to }) => {
    const rects: Box[] = []
    items.forEach((item, i) => {
      const start = starts[i]
      const end = start + item.text.length
      if (end <= from || start >= to || item.text.length === 0) return
      const a = (Math.max(from, start) - start) / item.text.length
      const b = (Math.min(to, end) - start) / item.text.length
      rects.push({ x: item.x + item.w * a, y: item.y, w: item.w * (b - a), h: item.h })
    })
    return rects
  })
}

// 一致の最初の矩形で並べる。上下の中心が、文字の高さの半分より近ければ同じ行とみなして、左から
function sortByReadingOrder(matches: Box[][]): Box[][] {
  const head = (match: Box[]) => match[0]
  return matches
    .filter((match) => match.length > 0)
    .sort((a, b) => {
      const p = head(a)
      const q = head(b)
      const dy = p.y + p.h / 2 - (q.y + q.h / 2)
      return Math.abs(dy) < Math.max(p.h, q.h) * 0.5 ? p.x - q.x : dy
    })
}

// 検索の結果の 1 件
export interface PdfSearchHit {
  fileId: string
  pageIndex: number
  // ページの中の何件目か（0 から）
  index: number
}

// ページの中の一致の矩形（ページ全体を 0〜1 とした割合）を、ページごとに覚えておく。
// 位置を出す前は、サーバーの件数だけ分かっている
export class PdfSearchResults {
  readonly query: string
  // 一致したページ（並べる順）と、その件数。位置を出したら、ブラウザで数えた件数に置き換える
  private readonly pages: { fileId: string; pageIndex: number; count: number }[]
  private readonly rects = new Map<string, Box[][]>()

  constructor(query: string, pages: { fileId: string; pageIndex: number; count: number }[]) {
    this.query = query
    this.pages = pages
  }

  get total(): number {
    return this.pages.reduce((sum, page) => sum + page.count, 0)
  }

  // 結果の一覧（ページの順、ページの中は前から）
  hit(n: number): PdfSearchHit | null {
    let rest = n
    for (const page of this.pages) {
      if (rest < page.count) return { fileId: page.fileId, pageIndex: page.pageIndex, index: rest }
      rest -= page.count
    }
    return null
  }

  // ページの n 件目が、全体の何件目か
  ordinal(fileId: string, pageIndex: number, index: number): number {
    let n = 0
    for (const page of this.pages) {
      if (page.fileId === fileId && page.pageIndex === pageIndex) return n + Math.min(index, Math.max(0, page.count - 1))
      n += page.count
    }
    return -1
  }

  pendingPages(): { fileId: string; pageIndex: number }[] {
    return this.pages.filter((page) => !this.rects.has(key(page.fileId, page.pageIndex)))
  }

  setRects(fileId: string, pageIndex: number, rects: Box[][]): void {
    this.rects.set(key(fileId, pageIndex), rects)
    const page = this.pages.find((p) => p.fileId === fileId && p.pageIndex === pageIndex)
    // サーバーとブラウザで、文字の取り出し方がわずかに違うことがある。位置を出せたものを正しいとする
    if (page) page.count = rects.length
  }

  rectsOnPage(fileId: string, pageIndex: number): Box[][] | undefined {
    return this.rects.get(key(fileId, pageIndex))
  }
}

function key(fileId: string, pageIndex: number): string {
  return `${fileId}#${pageIndex}`
}
