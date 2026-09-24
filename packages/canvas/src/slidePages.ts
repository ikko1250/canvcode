import type { Box, NodeRecord } from '@canvcode/core'
import { SLIDE_PAGE_SIZE, type RasterImage, type SlidePageImages, type SlidePageProps } from '@canvcode/nodes'
import type { Editor } from './editor.ts'
import type { FileManager } from './files.ts'

// スライドデッキの画像をキャンバスに並べる。
// - デッキのカード（持ち主）の右に、スライドの画像（slide-page）を横 4 枚ずつの格子で並べる
// - スライドは id（slideKey）で見分ける。並べ替え・追加・削除のあとは、画像を新しい位置へ動かし、
//   その上に置いたノード（中心が画像の中にあるもの）も一緒に動かす
// - デッキから消えたスライドの画像は消さず、上の書き込みごと並びの下に移して「削除された」と見せる
// - 並べ直しは Undo の履歴に入れない（利用者の操作ではなく、デッキに合わせた結果なので）

export interface SlidePageInfo {
  key: string
  hash: string
  // 画像ができているか。できていなければ、前の画像（hash）を見せ続ける
  ready: boolean
}

const COLUMNS = 4
const GAP = 40
// カードと 1 枚目の間
const CARD_GAP = 80
// 並びと、削除されたスライドの列の間
const REMOVED_GAP = 160

interface Placement {
  node: NodeRecord<SlidePageProps> | null
  props: SlidePageProps
  x: number
  y: number
}

// cardId（この Canvas の直下にあるデッキのカード）の横の画像を、pages に合わせる。何か変えたら true
export function reconcileSlidePages(editor: Editor, cardId: string, pages: SlidePageInfo[]): boolean {
  const card = editor.getNode(cardId)
  const cardBounds = editor.index.get(cardId)?.worldBounds
  if (!card || !cardBounds || card.parentId !== editor.canvasId) return false
  const fileId = (card.props as { fileId?: string }).fileId
  if (!fileId) return false

  // この Canvas の直下にある、このデッキの画像
  const existing: NodeRecord<SlidePageProps>[] = []
  for (const id of editor.index.allIds()) {
    const node = editor.getNode(id)
    if (node?.type === 'slide-page' && (node.props as SlidePageProps).fileId === fileId) existing.push(node as NodeRecord<SlidePageProps>)
  }
  const byKey = new Map<string, NodeRecord<SlidePageProps>>()
  const duplicates: string[] = []
  for (const node of existing) {
    if (byKey.has(node.props.slideKey)) duplicates.push(node.id)
    else byKey.set(node.props.slideKey, node)
  }
  const pageKeys = new Set(pages.map((page) => page.key))
  // まだ id の無かったスライド（位置のキー @i）に、あとから id が付いた。同じ位置の画像をそのスライドのものにする
  for (const [index, page] of pages.entries()) {
    const positional = byKey.get(`@${index}`)
    if (byKey.has(page.key) || !positional || pageKeys.has(`@${index}`)) continue
    byKey.delete(`@${index}`)
    byKey.set(page.key, positional)
  }

  const { w, h } = SLIDE_PAGE_SIZE
  const originX = cardBounds.x + cardBounds.w + CARD_GAP
  const originY = cardBounds.y
  const slot = (index: number) => ({ x: originX + (index % COLUMNS) * (w + GAP), y: originY + Math.floor(index / COLUMNS) * (h + GAP) })

  const placements: Placement[] = pages.map((page, index) => {
    const node = byKey.get(page.key) ?? null
    const hash = page.ready ? page.hash : (node?.props.hash ?? '')
    return { node, props: { fileId, slideKey: page.key, hash, slideIndex: index, removed: false, w, h }, ...slot(index) }
  })
  const used = new Set(placements.flatMap((p) => (p.node ? [p.node.id] : [])))
  const rows = Math.max(1, Math.ceil(pages.length / COLUMNS))
  const removedY = originY + rows * (h + GAP) - GAP + REMOVED_GAP
  let removedCount = 0
  for (const node of byKey.values()) {
    if (used.has(node.id)) continue
    placements.push({ node, props: { ...node.props, removed: true, w, h }, x: originX + removedCount * (w + GAP), y: removedY })
    removedCount += 1
  }

  // 動く画像の上に載っているノード（中心が画像の中）。動かす前の位置で決める
  const pageIds = new Set(existing.map((node) => node.id))
  const riders = new Map<string, string[]>()
  const moving = placements.filter((p) => p.node && (p.node.x !== p.x || p.node.y !== p.y))
  if (moving.length > 0) {
    const taken = new Set<string>()
    for (const id of editor.index.allIds()) {
      if (id === cardId || pageIds.has(id)) continue
      const bounds = editor.index.get(id)?.worldBounds
      if (!bounds) continue
      const center = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 }
      for (const p of moving) {
        const node = p.node!
        const box: Box = { x: node.x, y: node.y, w: node.props.w, h: node.props.h }
        if (taken.has(id) || !contains(box, center)) continue
        taken.add(id)
        riders.set(node.id, [...(riders.get(node.id) ?? []), id])
      }
    }
  }

  const changed = duplicates.length > 0 || placements.some((p) => !p.node || p.node.x !== p.x || p.node.y !== p.y || !sameProps(p.node.props, p.props) || !p.node.locked)
  if (!changed) return false

  const tx = editor.store.begin('sync slide pages', { scope: editor.canvasId, history: 'ignore' })
  try {
    const movedIds = [...moving.map((p) => p.node!.id), ...[...riders.values()].flat()]
    if (movedIds.length > 0) editor.detachArrows(tx, movedIds)
    for (const p of placements) {
      if (!p.node) {
        tx.put({ ...editor.makeNode('slide-page', { x: p.x, y: p.y, props: p.props }), locked: true })
        continue
      }
      const dx = p.x - p.node.x
      const dy = p.y - p.node.y
      tx.put({ ...p.node, x: p.x, y: p.y, props: p.props, locked: true })
      for (const id of riders.get(p.node.id) ?? []) {
        const rider = editor.getNode(id)
        if (rider) tx.put({ ...rider, x: rider.x + dx, y: rider.y + dy })
      }
    }
    for (const id of duplicates) tx.remove(id)
    tx.commit()
  } catch (error) {
    if (!tx.isDone) tx.cancel()
    throw error
  }
  return true
}

function contains(box: Box, point: { x: number; y: number }): boolean {
  return point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h
}

function sameProps(a: SlidePageProps, b: SlidePageProps): boolean {
  return a.fileId === b.fileId && a.slideKey === b.slideKey && a.hash === b.hash && a.slideIndex === b.slideIndex && a.removed === b.removed && a.w === b.w && a.h === b.h
}

// ---- サーバーとのやりとり ----

export interface SlidePagesState {
  pages: SlidePageInfo[]
  // サーバーが画像を作っている途中
  pending: boolean
  error?: string
}

const POLL_MS = 1500

// デッキごとのスライドの画像の一覧を、サーバーから読む。デッキの本文が変わったら読み直し、
// 画像を作っている途中なら、できるまで少し待って読み直す
export class SlidePageService implements SlidePageImages {
  private readonly baseUrl: string
  private readonly states = new Map<string, SlidePagesState>()
  private readonly loading = new Set<string>()
  // 読んでいる途中にまた頼まれた（読み終えたら、もう一度読む）
  private readonly again = new Set<string>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly listeners = new Set<(fileId: string, state: SlidePagesState) => void>()

  constructor(options: { files?: FileManager; baseUrl?: string } = {}) {
    this.baseUrl = options.baseUrl ?? '/api'
    // デッキを保存した・外で変わったら、画像の一覧を読み直す
    options.files?.onChange((fileId) => {
      if (this.states.has(fileId)) void this.refresh(fileId)
    })
  }

  // 待っている読み直しをやめる（ワークスペースと同じだけ生きるので、本文の変更の知らせは受け続ける。
  // 開発時の StrictMode で画面を作り直しても、知らせが切れないように）
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  onChange(listener: (fileId: string, state: SlidePagesState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // 手元の一覧（まだ読んでいなければ読み始めて null）
  get(fileId: string): SlidePagesState | null {
    const state = this.states.get(fileId)
    if (!state) void this.refresh(fileId)
    return state ?? null
  }

  async refresh(fileId: string): Promise<void> {
    if (typeof fetch === 'undefined') return
    if (this.loading.has(fileId)) {
      this.again.add(fileId)
      return
    }
    this.loading.add(fileId)
    const timer = this.timers.get(fileId)
    if (timer) clearTimeout(timer)
    this.timers.delete(fileId)
    try {
      const response = await fetch(`${this.baseUrl}/slides/${encodeURIComponent(fileId)}/pages`)
      if (!response.ok) return
      const state = (await response.json()) as SlidePagesState
      this.states.set(fileId, state)
      for (const listener of this.listeners) listener(fileId, state)
      if (state.pending) this.timers.set(fileId, setTimeout(() => void this.refresh(fileId), POLL_MS))
    } catch (error) {
      console.warn('Failed to load slide pages', fileId, error)
    } finally {
      this.loading.delete(fileId)
      if (this.again.delete(fileId)) void this.refresh(fileId)
    }
  }

  async load(hash: string): Promise<RasterImage> {
    const response = await fetch(`${this.baseUrl}/slide-pages/${hash}.png`)
    if (!response.ok) throw new Error(`Failed to load a slide page: ${response.status}`)
    const image = await createImageBitmap(await response.blob())
    return { image, width: image.width, height: image.height, level: 1 }
  }
}
