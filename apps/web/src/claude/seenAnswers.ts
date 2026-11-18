// まだ見ていない答え（質問のタブの青い点。docs/canvas-answer-panel-plan.md の 6）。
// 見たかどうかは、ブラウザに覚える（localStorage。付箋の id と、見た答えの答えた時刻の組。端末ごと）。
// 付箋に書くと、見るたびに Canvas が変わり、Undo に混ざるので書かない。DOM を使わない store（useSyncExternalStore で読む）

const STORAGE_KEY = 'canvcode.questions.seen'
// 覚えておく数（古いものから忘れる）
export const KEPT_SEEN = 500

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>

export class SeenAnswers {
  // 付箋の id → 見た答えの答えた時刻（覚えた順）
  private seen: Map<string, number>
  private version = 0
  private readonly listeners = new Set<() => void>()
  private readonly storage: Storage | null

  constructor(storage: Storage | null = defaultStorage()) {
    this.storage = storage
    this.seen = load(storage)
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // 変わるたびに増える（useSyncExternalStore の snapshot）
  getSnapshot = (): number => this.version

  // その答えを見たか
  isSeen(noteId: string, answeredAt: number): boolean {
    return this.seen.get(noteId) === answeredAt
  }

  // 見た
  mark(noteId: string, answeredAt: number): void {
    if (this.isSeen(noteId, answeredAt)) return
    this.seen.delete(noteId)
    this.seen.set(noteId, answeredAt)
    while (this.seen.size > KEPT_SEEN) this.seen.delete(this.seen.keys().next().value!)
    this.version++
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify([...this.seen]))
    } catch {
      // 覚えられなくても困らない（容量を超えたときなど）
    }
    for (const listener of this.listeners) listener()
  }
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function load(storage: Storage | null): Map<string, number> {
  try {
    const raw = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '[]') as unknown
    if (!Array.isArray(raw)) return new Map()
    return new Map(raw.filter((item): item is [string, number] => Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'number').slice(-KEPT_SEEN))
  } catch {
    return new Map()
  }
}
