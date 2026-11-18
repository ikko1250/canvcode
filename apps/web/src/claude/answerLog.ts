// キャンバスの AI（付箋で聞く）の答えの記録。付箋の答えのパネル（AnswerPanel）に、回答中のもの（考えている中身が流れる）と、
// 終わったもの（答えへ移れる）・過去の答えを出す。終わったものはブラウザ（localStorage）に残す（このサーバーのアドレスごと）。
// DOM を使わない store（useSyncExternalStore で読む）

export interface AnswerLogEntry {
  id: string
  canvasId: string
  // ask：付箋で聞いた。rewrite：ボタンで書き直した。follow-up：続きの質問
  kind: 'ask' | 'rewrite' | 'follow-up'
  // 質問の最初の行か、押したボタンの文字
  label: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  // Claude の考えている中身（Claude が返したもの。要約されている）
  thinking: string
  startedAt: number
  finishedAt?: number
  // 答えを書いた付箋
  noteId?: string
  error?: string
}

const STORAGE_KEY = 'canvcode.claude.answers'
// 残す数と、1 件の考えている中身の長さ
export const KEPT_ANSWERS = 50
export const KEPT_THINKING = 20000

export class AnswerLog {
  // 作った時刻（画面を開いた時刻。これより後に終わったものを、パネルの上の帯に出す）
  readonly openedAt = Date.now()
  private entries: AnswerLogEntry[]
  private readonly listeners = new Set<() => void>()
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null

  constructor(storage: Pick<Storage, 'getItem' | 'setItem'> | null = defaultStorage()) {
    this.storage = storage
    this.entries = load(storage)
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // 新しいものから
  getSnapshot = (): readonly AnswerLogEntry[] => this.entries

  start(entry: Pick<AnswerLogEntry, 'canvasId' | 'kind' | 'label'> & { noteId?: string }): string {
    const id = `answer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    this.entries = [{ id, ...entry, status: 'running', thinking: '', startedAt: Date.now() }, ...this.entries]
    this.notify()
    return id
  }

  appendThinking(id: string, text: string): void {
    if (!text) return
    this.update(id, (entry) => ({ ...entry, thinking: entry.thinking + text }))
  }

  finish(id: string, result: { status: 'done' | 'failed' | 'cancelled'; noteId?: string; error?: string }): void {
    this.update(id, (entry) => ({ ...entry, ...result, finishedAt: Date.now() }))
    this.save()
  }

  // 終わったものを消す（回答中のものは残す）
  clearFinished(): void {
    this.entries = this.entries.filter((entry) => entry.status === 'running')
    this.notify()
    this.save()
  }

  private update(id: string, change: (entry: AnswerLogEntry) => AnswerLogEntry): void {
    let changed = false
    this.entries = this.entries.map((entry) => {
      if (entry.id !== id) return entry
      changed = true
      return change(entry)
    })
    if (changed) this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  private save(): void {
    if (!this.storage) return
    const kept = this.entries
      .filter((entry) => entry.status !== 'running')
      .slice(0, KEPT_ANSWERS)
      .map((entry) => (entry.thinking.length > KEPT_THINKING ? { ...entry, thinking: `${entry.thinking.slice(0, KEPT_THINKING)}…` } : entry))
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(kept))
    } catch {
      // 覚えられなくても困らない（容量を超えたときなど）
    }
  }
}

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function load(storage: Pick<Storage, 'getItem' | 'setItem'> | null): AnswerLogEntry[] {
  try {
    const raw = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '[]') as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter(isEntry).slice(0, KEPT_ANSWERS)
  } catch {
    return []
  }
}

function isEntry(value: unknown): value is AnswerLogEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as AnswerLogEntry
  return (
    typeof entry.id === 'string' &&
    typeof entry.canvasId === 'string' &&
    typeof entry.label === 'string' &&
    typeof entry.thinking === 'string' &&
    typeof entry.startedAt === 'number' &&
    (entry.kind === 'ask' || entry.kind === 'rewrite' || entry.kind === 'follow-up') &&
    (entry.status === 'done' || entry.status === 'failed' || entry.status === 'cancelled')
  )
}

// 考えている中身を、段落（空の行で区切る）と、続けて並んだ調べている行（「― 」で始まる行）のまとまりに分ける
export function thinkingBlocks(text: string): ({ kind: 'text'; text: string } | { kind: 'tool'; lines: string[] })[] {
  const blocks: ({ kind: 'text'; text: string } | { kind: 'tool'; lines: string[] })[] = []
  let paragraph: string[] = []
  const endParagraph = () => {
    const joined = paragraph.join('\n').trim()
    if (joined) blocks.push({ kind: 'text', text: joined })
    paragraph = []
  }
  for (const line of text.split('\n')) {
    if (line.startsWith('― ')) {
      endParagraph()
      const last = blocks.at(-1)
      if (last?.kind === 'tool') last.lines.push(line.slice(2).trim())
      else blocks.push({ kind: 'tool', lines: [line.slice(2).trim()] })
    } else if (line.trim() === '') endParagraph()
    else paragraph.push(line)
  }
  endParagraph()
  return blocks
}
