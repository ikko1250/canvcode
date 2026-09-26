import type { Box } from './geometry.ts'
import { randomIdSuffix } from './ids.ts'
import { locateQuote } from './text.ts'

// AI に見てほしい場所の参照（ref）。範囲を選ぶと ref:XXXXXXXXXX という短い ID を作り、ID だけをクリップボードに入れる。
// ユーザーが AI に貼り付けると、AI は MCP の resolve_reference で中身を取り出す。
// - 同期するレコード（WorkspaceRecord）には入れない。サーバーの workspace.db の refs テーブルに、REST で 1 件ずつ保存する
// - 作った時点でしか分からないこと（ノードのワールド座標、PDF の範囲の文字、行の中身）は、ここに持たせておく
// - 消さない。指している先が消えていても、解決するときに status で知らせる

export const REF_PREFIX = 'ref:'
export const REF_ID_PATTERN = /^ref:[0-9A-Za-z]{8,24}$/
// 10 文字の base62 は約 59 ビット。ワークスペースの中で重なることはまずなく、重なればサーバーが 409 を返す
const REF_ID_LENGTH = 10

export function createRefId(): string {
  return `${REF_PREFIX}${randomIdSuffix(REF_ID_LENGTH)}`
}

// Canvas の範囲：ワールド座標の矩形と、その中のノード（作った時点のワールド座標）。
// 範囲選択の枠が PDF のページの一部にかかっていれば、そのページのノードに pdf（ページの中の範囲）を付ける
export interface CanvasRefTarget {
  kind: 'canvas'
  canvasId: string
  rect: Box
  nodes: { id: string; bounds: Box; pdf?: PdfRegion }[]
}

// PDF のページの中の範囲（ページ全体を 0〜1 とした割合）と、作った時点の範囲の文字。
// figure は、文字がほとんどない（図や表、文字のない PDF）とき。そのときは ref に画像も添える
export interface PdfRegion {
  fileId: string
  pageIndex: number
  rect: Box
  text: string
  figure?: true
}

// Markdown / Python の行の範囲（1 から、終わりの行を含む）。snapshot はその行の中身で、ファイルが変わったら付け直すのに使う
export interface LinesRefTarget {
  kind: 'lines'
  fileId: string
  startLine: number
  endLine: number
  snapshot: string
}

// PDF の範囲：ページ（0 から）と、ページの中の矩形（ページ全体を 0〜1 とした割合）、作った時点の範囲の文字
export interface PdfRefTarget {
  kind: 'pdf'
  fileId: string
  pageIndex: number
  rect: Box
  text: string
  figure?: true
}

export type RefTarget = CanvasRefTarget | LinesRefTarget | PdfRefTarget

export type ReferenceRecord = RefTarget & { typeName: 'ref'; id: string; createdAt: number }

const MAX_TEXT = 200_000
const MAX_NODES = 5000

// ブラウザから届いた ref を確かめる。正しくなければ理由を付けて投げる。余計な項目は落とす
export function validateReference(value: unknown): ReferenceRecord {
  const v = object(value, 'reference')
  if (v.typeName !== 'ref') throw new Error('typeName must be "ref"')
  if (typeof v.id !== 'string' || !REF_ID_PATTERN.test(v.id)) throw new Error('invalid ref id')
  const createdAt = number(v.createdAt, 'createdAt')
  const base = { typeName: 'ref' as const, id: v.id, createdAt }
  switch (v.kind) {
    case 'canvas': {
      if (!Array.isArray(v.nodes)) throw new Error('nodes must be an array')
      if (v.nodes.length > MAX_NODES) throw new Error('too many nodes')
      const nodes = v.nodes.map((n, i) => {
        const node = object(n, `nodes[${i}]`)
        const out: CanvasRefTarget['nodes'][number] = { id: prefixed(node.id, 'node:', `nodes[${i}].id`), bounds: box(node.bounds, `nodes[${i}].bounds`) }
        if (node.pdf !== undefined) out.pdf = pdfRegion(node.pdf, `nodes[${i}].pdf`)
        return out
      })
      return { ...base, kind: 'canvas', canvasId: prefixed(v.canvasId, 'canvas:', 'canvasId'), rect: box(v.rect, 'rect'), nodes }
    }
    case 'lines': {
      const startLine = integer(v.startLine, 'startLine')
      const endLine = integer(v.endLine, 'endLine')
      if (startLine < 1 || endLine < startLine) throw new Error('invalid line range')
      return { ...base, kind: 'lines', fileId: prefixed(v.fileId, 'file:', 'fileId'), startLine, endLine, snapshot: text(v.snapshot, 'snapshot') }
    }
    case 'pdf':
      return { ...base, kind: 'pdf', ...pdfRegion(v, '') }
    default:
      throw new Error('kind must be canvas, lines or pdf')
  }
}

// 貼り付けられた文字列から ref の ID を取り出す（前後の空白・引用符・句読点を除き、ref: が無ければ補う）。取り出せなければ null
export function normalizeRefId(input: string): string | null {
  const s = input.replace(/ref%3A/gi, 'ref:')
  // ref: が付いていればそれを、なければ全体が 1 つの ID のときだけ受け付ける
  const suffix =
    /ref:([0-9A-Za-z]{8,24})(?![0-9A-Za-z])/.exec(s)?.[1] ?? /^[\s`'"「『(<]*([0-9A-Za-z]{8,24})[\s`'"」』)>.,。、]*$/.exec(s)?.[1]
  return suffix ? `${REF_PREFIX}${suffix}` : null
}

export type LinesStatus = 'unchanged' | 'moved' | 'lost'

// 今の本文で、ref の行の範囲がどこにあるか。
// - 覚えていた行の中身が同じなら unchanged
// - 違えば snapshot を探し直し、見つかれば moved（行数は snapshot の行数のまま）
// - 見つからなければ lost。覚えていた行を本文の長さに切り詰めて返す
export function resolveLines(
  text: string,
  ref: Pick<LinesRefTarget, 'startLine' | 'endLine' | 'snapshot'>,
): { startLine: number; endLine: number; text: string; status: LinesStatus } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const snapshot = ref.snapshot.replace(/\r\n?/g, '\n')
  const span = ref.endLine - ref.startLine
  const slice = (start: number, end: number): string => lines.slice(start - 1, end).join('\n')
  if (ref.endLine <= lines.length && slice(ref.startLine, ref.endLine) === snapshot) {
    return { startLine: ref.startLine, endLine: ref.endLine, text: snapshot, status: 'unchanged' }
  }
  const found = locateQuote(lines.join('\n'), snapshot, ref.startLine)
  if (found !== null) {
    const end = Math.min(lines.length, found + snapshot.split('\n').length - 1)
    return { startLine: found, endLine: end, text: slice(found, end), status: 'moved' }
  }
  const start = Math.min(ref.startLine, lines.length)
  const end = Math.min(start + span, lines.length)
  return { startLine: start, endLine: end, text: slice(start, end), status: 'lost' }
}

// エディタの選択（文字の位置 from〜to）を、行の範囲にする。
// - 何も選んでいなければ、カーソルのある行
// - 選択が行頭で終わっていれば（行ごと選んだとき）、その行は含めない
export function linesOfSelection(doc: string, from: number, to: number): { startLine: number; endLine: number; snapshot: string } {
  const text = doc.replace(/\r\n?/g, '\n')
  const lo = Math.max(0, Math.min(from, to, text.length))
  let hi = Math.max(0, Math.min(Math.max(from, to), text.length))
  if (hi > lo && text[hi - 1] === '\n') hi--
  const lines = text.split('\n')
  const startLine = lineOf(text, lo)
  const endLine = lineOf(text, hi)
  return { startLine, endLine, snapshot: lines.slice(startLine - 1, endLine).join('\n') }
}

function lineOf(text: string, offset: number): number {
  let line = 1
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line++
  return line
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value as Record<string, unknown>
}

function number(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`)
  return value
}

function integer(value: unknown, name: string): number {
  const n = number(value, name)
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`)
  return n
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  if (value.length > MAX_TEXT) throw new Error(`${name} is too long`)
  return value
}

function prefixed(value: unknown, prefix: string, name: string): string {
  if (typeof value !== 'string' || !value.startsWith(prefix) || value.length > 200) throw new Error(`${name} must start with ${prefix}`)
  return value
}

// PDF のページの中の範囲。name は項目名の前に付ける（'' なら付けない）
function pdfRegion(value: unknown, name: string): PdfRegion {
  const v = object(value, name || 'reference')
  const at = (key: string) => (name ? `${name}.${key}` : key)
  const pageIndex = integer(v.pageIndex, at('pageIndex'))
  if (pageIndex < 0) throw new Error(`invalid ${at('pageIndex')}`)
  const rect = box(v.rect, at('rect'))
  const eps = 1e-6
  if (rect.x < -eps || rect.y < -eps || rect.x + rect.w > 1 + eps || rect.y + rect.h > 1 + eps) {
    throw new Error(`${at('rect')} must be within the page (0..1)`)
  }
  const out: PdfRegion = { fileId: prefixed(v.fileId, 'file:', at('fileId')), pageIndex, rect, text: text(v.text, at('text')) }
  if (v.figure === true) out.figure = true
  return out
}

function box(value: unknown, name: string): Box {
  const b = object(value, name)
  const out = { x: number(b.x, `${name}.x`), y: number(b.y, `${name}.y`), w: number(b.w, `${name}.w`), h: number(b.h, `${name}.h`) }
  if (out.w < 0 || out.h < 0) throw new Error(`${name} must not have a negative size`)
  return out
}
