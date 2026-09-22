import { invertPatch, type BaseRecord, type Patch, type Store } from './store.ts'

// Undo / Redo（MAI-11）。
// - 履歴は scope（Canvas の id）ごとに分けて持つ
// - 取り消そうとしたレコードが、その後別の操作で変わっていたら、取り消さずに失敗を返す
// - 履歴はメモリ内だけに持つ（再読み込みで消える）

export interface HistoryEntry<R> {
  label: string
  patch: Patch<R>
  meta: unknown
}

export type UndoResult<R> =
  | { ok: true; entry: HistoryEntry<R> }
  | { ok: false; reason: 'empty' | 'conflict' }

const DEFAULT_SCOPE = 'default'
const DEFAULT_LIMIT = 200

interface Stacks<R> {
  undo: HistoryEntry<R>[]
  redo: HistoryEntry<R>[]
}

export interface HistoryOptions<R> {
  limit?: number
  // 当てようとしている差分を、ほかの理由で拒むか（ストアの決まりごと。例：まだ中身のある Canvas を消す取り消し）。
  // false を返すと、取り消さずに conflict を返す
  validate?: (patch: Patch<R>) => boolean
}

export class History<R extends BaseRecord> {
  private readonly store: Store<R>
  private readonly limit: number
  private readonly validate: ((patch: Patch<R>) => boolean) | undefined
  private readonly scopes = new Map<string, Stacks<R>>()
  private readonly listeners = new Set<() => void>()
  private readonly unlisten: () => void

  constructor(store: Store<R>, options: HistoryOptions<R> = {}) {
    this.store = store
    this.limit = options.limit ?? DEFAULT_LIMIT
    this.validate = options.validate
    this.unlisten = store.listen((event) => {
      if (event.phase !== 'commit') return
      if (event.options.history === 'ignore' || event.options.source !== 'user') return
      const stacks = this.stacks(event.options.scope ?? DEFAULT_SCOPE)
      stacks.undo.push({ label: event.label, patch: event.patch, meta: event.options.meta })
      if (stacks.undo.length > this.limit) stacks.undo.shift()
      stacks.redo.length = 0
      this.notify()
    })
  }

  dispose(): void {
    this.unlisten()
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  canUndo(scope = DEFAULT_SCOPE): boolean {
    return this.stacks(scope).undo.length > 0
  }

  canRedo(scope = DEFAULT_SCOPE): boolean {
    return this.stacks(scope).redo.length > 0
  }

  undo(scope = DEFAULT_SCOPE): UndoResult<R> {
    return this.step(scope, 'undo')
  }

  redo(scope = DEFAULT_SCOPE): UndoResult<R> {
    return this.step(scope, 'redo')
  }

  clear(scope = DEFAULT_SCOPE): void {
    this.scopes.delete(scope)
    this.notify()
  }

  private step(scope: string, direction: 'undo' | 'redo'): UndoResult<R> {
    const stacks = this.stacks(scope)
    const from = direction === 'undo' ? stacks.undo : stacks.redo
    const to = direction === 'undo' ? stacks.redo : stacks.undo
    const entry = from.at(-1)
    if (!entry) return { ok: false, reason: 'empty' }

    // undo なら「変更後」、redo なら「変更前」が今の値と一致していなければならない
    const patch = direction === 'undo' ? invertPatch(entry.patch) : entry.patch
    for (const [id, change] of patch) {
      if (this.store.get(id) !== change.before) return { ok: false, reason: 'conflict' }
    }
    if (this.validate && !this.validate(patch)) return { ok: false, reason: 'conflict' }

    from.pop()
    this.store.transact(`${direction}: ${entry.label}`, (tx) => tx.applyPatch(patch), {
      history: 'ignore',
      source: 'history',
      scope,
    })
    to.push(entry)
    this.notify()
    return { ok: true, entry }
  }

  private stacks(scope: string): Stacks<R> {
    let stacks = this.scopes.get(scope)
    if (!stacks) {
      stacks = { undo: [], redo: [] }
      this.scopes.set(scope, stacks)
    }
    return stacks
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
