// レコードのストア（MAI-11）。
// - レコードは id をキーにした Map で持ち、更新するときはレコードごと置き換える（書き換えない）
// - 変更は必ずトランザクションの中で行い、変更前と変更後の値の組（差分）として記録する
// - 差分は Undo、サーバーへの送信、再描画する範囲の判定のすべてに使う

export interface BaseRecord {
  id: string
}

// 1 レコード分の変更。before が undefined なら追加、after が undefined なら削除。
export interface Change<R> {
  before: R | undefined
  after: R | undefined
}

export type Patch<R> = Map<string, Change<R>>

// user: この画面での操作 / history: Undo・Redo / remote: サーバーや別のタブから届いた変更
export type ChangeSource = 'user' | 'history' | 'remote'

export interface TransactionOptions {
  // 'ignore' にすると Undo の履歴に残さない
  history?: 'record' | 'ignore'
  // Undo の履歴を分ける単位（Canvas の id。MAI-11）
  scope?: string
  source?: ChangeSource
  // 履歴に一緒に保存しておく値（操作前の選択状態など）
  meta?: unknown
}

export interface StoreEvent<R> {
  label: string
  patch: Patch<R>
  options: Required<Pick<TransactionOptions, 'history' | 'source'>> & TransactionOptions
  // 'progress' はドラッグ中などトランザクションの途中経過、'commit' は確定した全体の差分
  phase: 'progress' | 'commit'
}

export type StoreListener<R> = (event: StoreEvent<R>) => void

export interface StoreHooks<R extends BaseRecord> {
  afterCreate?: (record: R, tx: Transaction<R>) => void
  afterUpdate?: (prev: R, next: R, tx: Transaction<R>) => void
  afterDelete?: (record: R, tx: Transaction<R>) => void
  // commit の直前に、トランザクション全体の差分を受け取る
  beforeCommit?: (patch: Patch<R>, tx: Transaction<R>) => void
  // 購読者に知らせる直前に、まだ知らせていない差分を受け取る（途中経過でも commit でも呼ばれる）。
  // ほかのレコードから計算して決まる値（矢印の端など）を、ここで合わせ直す。
  // ここで変えたものも同じ知らせに入る。取り消し（cancel）のときは呼ばない
  beforeFlush?: (pending: Patch<R>, tx: Transaction<R>) => void
}

export function invertPatch<R>(patch: Patch<R>): Patch<R> {
  const inverted: Patch<R> = new Map()
  for (const [id, change] of patch) inverted.set(id, { before: change.after, after: change.before })
  return inverted
}

// 差分を順に重ねる。追加してから削除したものは消え、同じ値に戻ったものも消える。
export function mergePatch<R>(into: Patch<R>, next: Patch<R>): Patch<R> {
  for (const [id, change] of next) {
    const existing = into.get(id)
    const merged = { before: existing ? existing.before : change.before, after: change.after }
    if (merged.before === merged.after) into.delete(id)
    else into.set(id, merged)
  }
  return into
}

export class Transaction<R extends BaseRecord> {
  readonly label: string
  readonly options: StoreEvent<R>['options']
  private readonly store: Store<R>
  // トランザクション全体の差分
  private readonly total: Patch<R> = new Map()
  // まだ購読者に知らせていない分
  private pending: Patch<R> = new Map()
  private done = false

  constructor(store: Store<R>, label: string, options: TransactionOptions) {
    this.store = store
    this.label = label
    this.options = { history: 'record', source: 'user', ...options }
  }

  get isDone(): boolean {
    return this.done
  }

  get(id: string): R | undefined {
    return this.store.get(id)
  }

  // 作成または置き換え
  put(record: R): void {
    this.assertOpen()
    const before = this.store.get(record.id)
    if (before === record) return
    this.store._write(record.id, record)
    this.record(record.id, before, record)
    if (before) this.store._hooks.afterUpdate?.(before, record, this)
    else this.store._hooks.afterCreate?.(record, this)
  }

  update(id: string, updater: (record: R) => R): R | undefined {
    const current = this.store.get(id)
    if (!current) return undefined
    const next = updater(current)
    this.put(next)
    return next
  }

  remove(id: string): void {
    this.assertOpen()
    const before = this.store.get(id)
    if (!before) return
    this.store._write(id, undefined)
    this.record(id, before, undefined)
    this.store._hooks.afterDelete?.(before, this)
  }

  // 差分をまとめて当てる（Undo・Redo・リモートの変更で使う）
  applyPatch(patch: Patch<R>): void {
    for (const [id, change] of patch) {
      if (change.after) this.put(change.after)
      else this.remove(id)
    }
  }

  // 途中経過を購読者に知らせる（ドラッグ中の再描画など）
  flush(): void {
    this.flushPending(true)
  }

  private flushPending(runHooks: boolean): void {
    this.assertOpen()
    if (this.pending.size === 0) return
    if (runHooks) this.store._hooks.beforeFlush?.(this.pending, this)
    const patch = this.pending
    this.pending = new Map()
    this.store._emit({ label: this.label, patch, options: this.options, phase: 'progress' })
  }

  commit(): Patch<R> {
    this.assertOpen()
    this.store._hooks.beforeCommit?.(this.total, this)
    this.flush()
    this.done = true
    this.store._endTransaction(this)
    if (this.total.size > 0) {
      this.store._emit({ label: this.label, patch: this.total, options: this.options, phase: 'commit' })
    }
    return this.total
  }

  // これまでの変更をすべて元に戻して終える（ドラッグ中の Esc など）。購読者には途中経過として知らせる。
  cancel(): void {
    this.assertOpen()
    const revert = invertPatch(this.total)
    for (const [id, change] of revert) this.store._write(id, change.after)
    this.pending = mergePatch(this.pending, revert)
    this.flushPending(false)
    this.done = true
    this.store._endTransaction(this)
  }

  private record(id: string, before: R | undefined, after: R | undefined): void {
    mergePatch(this.total, new Map([[id, { before, after }]]))
    mergePatch(this.pending, new Map([[id, { before, after }]]))
  }

  private assertOpen(): void {
    if (this.done) throw new Error(`Transaction "${this.label}" is already finished`)
  }
}

export class Store<R extends BaseRecord> {
  private readonly records = new Map<string, R>()
  private readonly listeners = new Set<StoreListener<R>>()
  private active: Transaction<R> | null = null
  _hooks: StoreHooks<R> = {}

  get(id: string): R | undefined {
    return this.records.get(id)
  }

  has(id: string): boolean {
    return this.records.has(id)
  }

  get size(): number {
    return this.records.size
  }

  values(): IterableIterator<R> {
    return this.records.values()
  }

  setHooks(hooks: StoreHooks<R>): void {
    this._hooks = hooks
  }

  listen(listener: StoreListener<R>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get activeTransaction(): Transaction<R> | null {
    return this.active
  }

  // 長く続く操作（ドラッグなど）のためにトランザクションを開く。commit か cancel で閉じる。
  begin(label: string, options: TransactionOptions = {}): Transaction<R> {
    if (this.active) throw new Error(`Transaction "${this.active.label}" is still open`)
    this.active = new Transaction(this, label, options)
    return this.active
  }

  transact<T>(label: string, fn: (tx: Transaction<R>) => T, options: TransactionOptions = {}): T {
    const tx = this.begin(label, options)
    try {
      const result = fn(tx)
      tx.commit()
      return result
    } catch (error) {
      if (!tx.isDone) tx.cancel()
      throw error
    }
  }

  _write(id: string, record: R | undefined): void {
    if (record) this.records.set(id, record)
    else this.records.delete(id)
  }

  _endTransaction(tx: Transaction<R>): void {
    if (this.active === tx) this.active = null
  }

  _emit(event: StoreEvent<R>): void {
    for (const listener of this.listeners) listener(event)
  }
}
