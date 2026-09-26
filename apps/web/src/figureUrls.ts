import { isFrameId } from '@canvcode/slides'

// スライドエディタからキャンバスへ移る URL（提案 B）。
// - 「キャンバスで描く」：/?new-figure=<フレームの id>&deck=<File の id>&w=&h=&name= を開くと、
//   デッキのある Canvas に、その id・大きさ・名前のフレームを作って、そこへ移る
// - 「キャンバスで開く」：/?figure=<フレームの id> を開くと、そのフレームのある Canvas へ移って見せる

export interface NewFigureRequest {
  kind: 'new'
  frameId: string
  deckId: string
  w: number
  h: number
  name: string
}

export type FigureRequest = NewFigureRequest | { kind: 'open'; frameId: string }

// フレームの大きさの範囲（小さすぎ・大きすぎる値は丸める）
const MIN_SIZE = 40
const MAX_SIZE = 10_000

export function newFigureUrl(request: Omit<NewFigureRequest, 'kind'>): string {
  const query = new URLSearchParams({
    'new-figure': request.frameId,
    deck: request.deckId,
    w: String(Math.round(request.w)),
    h: String(Math.round(request.h)),
    name: request.name,
  })
  return `/?${query}`
}

export function figureUrl(frameId: string): string {
  return `/?${new URLSearchParams({ figure: frameId })}`
}

// 開いた URL の頼み（無ければ・読めなければ null）
export function figureRequestFromUrl(search: string): FigureRequest | null {
  const params = new URLSearchParams(search)
  const open = params.get('figure')
  if (open !== null) return isFrameId(open) ? { kind: 'open', frameId: open } : null
  const frameId = params.get('new-figure')
  const deckId = params.get('deck')
  if (frameId === null || !isFrameId(frameId) || !deckId) return null
  const size = (value: string | null, fallback: number) => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(n))) : fallback
  }
  return { kind: 'new', frameId, deckId, w: size(params.get('w'), 920), h: size(params.get('h'), 732), name: params.get('name') || '図' }
}
