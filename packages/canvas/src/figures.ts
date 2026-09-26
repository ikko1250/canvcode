import type { Box, NodeRecord, Patch } from '@canvcode/core'
import type { Editor } from './editor.ts'
import type { FileManager } from './files.ts'

// スライドの図にするフレーム（提案 B）。
// デッキの画像のパスに canvas:<フレームの id> と書かれたフレームを、ブラウザで PNG に描いてサーバーへ送る。
// サーバーはそれをスライドの画像に埋め込む（キャンバスの並び・出力・AI の確認で同じ画像）。
// - どのフレームが図に使われているかは、サーバー（GET /api/figures）に聞く。デッキが変わったら聞き直す
// - 図のフレームか、その中のノードが変わったら、少し待って描き直す（CanvasView が予約する）

// 描く大きさ：長い辺をこの画素数にする（図の欄は最大 920px 幅なので、2 倍くらいの解像度）
export const FIGURE_MAX_EDGE = 1920
// フレームの中が変わってから描くまでの待ち時間
export const FIGURE_RENDER_DELAY_MS = 1000

export interface FigureFrameState {
  // このフレームを図に使っているデッキ（File の id）
  decks: string[]
  // サーバーに画像があるか
  hasImage: boolean
}

export class FigureService {
  private readonly baseUrl: string
  private readonly frames = new Map<string, FigureFrameState>()
  private readonly listeners = new Set<() => void>()
  private loading: Promise<void> | null = null
  private again = false

  constructor(options: { files?: FileManager; isDeck?: (fileId: string) => boolean; baseUrl?: string } = {}) {
    this.baseUrl = options.baseUrl ?? '/api'
    // デッキの本文が変わったら（図の参照が増えた・減ったかもしれない）読み直す
    options.files?.onChange((fileId) => {
      if (!options.isDeck || options.isDeck(fileId)) void this.refresh()
    })
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  isFigure(frameId: string): boolean {
    return this.frames.has(frameId)
  }

  hasImage(frameId: string): boolean {
    return this.frames.get(frameId)?.hasImage ?? false
  }

  // 参照されているフレームの一覧を読み直す（読んでいる途中に頼まれたら、読み終えてからもう一度）
  refresh(): Promise<void> {
    if (typeof fetch === 'undefined') return Promise.resolve()
    if (this.loading) {
      this.again = true
      return this.loading
    }
    this.loading = (async () => {
      try {
        const response = await fetch(`${this.baseUrl}/figures`)
        if (!response.ok) return
        const { frames } = (await response.json()) as { frames: ({ id: string } & FigureFrameState)[] }
        this.frames.clear()
        for (const { id, decks, hasImage } of frames) this.frames.set(id, { decks, hasImage })
        for (const listener of this.listeners) listener()
      } catch (error) {
        console.warn('Failed to load figure frames', error)
      } finally {
        this.loading = null
        if (this.again) {
          this.again = false
          void this.refresh()
        }
      }
    })()
    return this.loading
  }

  // デッキに入れたばかりのフレームを、サーバーに聞き直す前から図として扱う
  markFigure(frameId: string, deckId: string): void {
    const state = this.frames.get(frameId)
    if (state) {
      if (!state.decks.includes(deckId)) state.decks.push(deckId)
    } else {
      this.frames.set(frameId, { decks: [deckId], hasImage: false })
    }
  }

  // フレームの画像をサーバーに置く
  async upload(frameId: string, png: Blob): Promise<void> {
    const response = await fetch(`${this.baseUrl}/figures/${encodeURIComponent(frameId)}.png`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: png,
    })
    if (!response.ok) throw new Error(`Failed to save a figure: ${response.status}`)
    const state = this.frames.get(frameId)
    if (state) state.hasImage = true
  }
}

// 差分のうち、図のフレームに関わるもの（フレームそのもの・その中のノード。消えたノードは消える前の親で見る）
export function figureFramesTouched(editor: Editor, patch: Patch<NodeRecord>, isFigure: (frameId: string) => boolean): Set<string> {
  const touched = new Set<string>()
  const visit = (id: string | null) => {
    // 親をたどる（循環していても止まるよう、回数を限る）
    for (let depth = 0; id && depth < 64; depth++) {
      const node = editor.getNode(id)
      if (node?.type === 'frame' && isFigure(id)) touched.add(id)
      id = node?.parentId ?? null
    }
  }
  for (const [id, change] of patch) {
    visit(id)
    const before = change.before?.parentId
    if (before && before !== change.after?.parentId) visit(before)
  }
  return touched
}

// フレームを描く範囲。フレームの枠の線（1 画面ピクセル）が図の縁に写らないよう、少し内側にする
export function figureRenderBox(bounds: Box): { box: Box; maxEdge: number } {
  const scale = FIGURE_MAX_EDGE / Math.max(bounds.w, bounds.h, 1)
  const inset = Math.min(1 / scale, bounds.w / 4, bounds.h / 4)
  return {
    box: { x: bounds.x + inset, y: bounds.y + inset, w: bounds.w - inset * 2, h: bounds.h - inset * 2 },
    maxEdge: FIGURE_MAX_EDGE,
  }
}

// デッキの画像の並びと、ほかの図のフレームの下に空ける間
const FIGURE_FRAME_GAP = 160

// 「キャンバスで描く」（スライドエディタ）で、図のフレームを作る。デッキのカードとスライドの画像、
// すでにある図のフレームの下に、左をカードにそろえて置く。どれも無ければ fallback を中心に置く。
// 同じ id のノードがもうあれば（読み直したときなど）作らず false
export function createFigureFrame(
  editor: Editor,
  options: { frameId: string; fileId: string; w: number; h: number; name: string; isFigure(frameId: string): boolean; fallback: { x: number; y: number } },
): boolean {
  if (editor.store.has(options.frameId)) return false
  const related: Box[] = []
  for (const id of editor.index.allIds()) {
    const entry = editor.index.get(id)
    if (!entry) continue
    const { node } = entry
    const props = node.props as { fileId?: string; role?: string }
    const deckCard = node.type === 'slide-deck-card' && props.fileId === options.fileId && props.role === 'owner'
    const deckPage = node.type === 'slide-page' && props.fileId === options.fileId
    const figure = node.type === 'frame' && options.isFigure(id)
    if (deckCard || deckPage || figure) related.push(entry.worldBounds)
  }
  const left = related.length > 0 ? Math.min(...related.map((b) => b.x)) : options.fallback.x - options.w / 2
  const top = related.length > 0 ? Math.max(...related.map((b) => b.y + b.h)) + FIGURE_FRAME_GAP : options.fallback.y - options.h / 2
  const frame = { ...editor.makeNode('frame', { x: left, y: top, props: { w: options.w, h: options.h, name: options.name } }), id: options.frameId }
  editor.createNodes([frame], 'create figure frame')
  return true
}
