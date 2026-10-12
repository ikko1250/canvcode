import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ReferenceRecord } from '@canvcode/core'

// レコードの保存（MAI-13）。ワークスペースのレコード（Canvas・File・Node・Binding・SourceAnchor）を
// .canvcode/workspace.db（SQLite、WAL）に 1 行ずつ JSON で持つ。
// - 差分を受け取るたびに 1 つのトランザクションで保存し、ワークスペース全体の変更番号（rev）を 1 つ進める
// - 消したレコードは deleted に変更番号と一緒に残す（つなぎ直したタブに「その後に消えたもの」を渡すため）
// - parent_id に索引を張っておく（Canvas ごとに読むように変えるとき用。今は画面を開くときにまとめて読む）

export interface StoredRecord {
  typeName: string
  id: string
  [key: string]: unknown
}

export interface Changes {
  rev: number
  records: StoredRecord[]
  deleted: string[]
}

// テーブルの構造の版。変えるときは MIGRATIONS に足す（起動時に、適用する前に workspace.db のコピーを作る）
const SCHEMA_VERSION = 2
const MIGRATIONS: Record<number, (db: DatabaseSync) => void> = {
  // AI の編集の記録（MCP の edit_canvas。Undo に使う）
  2: (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_ops (
        id TEXT PRIMARY KEY,
        canvas_id TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        rev INTEGER NOT NULL,
        patch TEXT NOT NULL,
        undone_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS agent_ops_created_at ON agent_ops (created_at);
    `),
}

// WAL のファイル（workspace.db-wal）の大きさの上限（バイト）。チェックポイントのあと、これを超えた分を切り詰める
export const JOURNAL_SIZE_LIMIT = 16 * 1024 * 1024

// 残しておく AI の編集の記録の数と、合計の大きさ（patch の JSON のバイト数）。どちらかを超えたら古いものから消す。
// 最新の 1 件は、大きさの上限を超えていても残す（直前の編集を取り消せるように）
export const MAX_AGENT_OPS = 50
export const MAX_AGENT_OPS_BYTES = 20 * 1024 * 1024

export interface RecordStoreOptions {
  // AI の編集の記録の上限（テスト用。省けば MAX_AGENT_OPS・MAX_AGENT_OPS_BYTES）
  maxAgentOps?: number
  maxAgentOpsBytes?: number
}

// AI の編集 1 回分の記録。patch は変わったレコードの前後（null はなかった・消した）
export interface AgentOpEntry {
  id: string
  before: StoredRecord | null
  after: StoredRecord | null
}

export interface AgentOp {
  id: string
  canvasId: string
  label: string
  createdAt: number
  rev: number
  patch: AgentOpEntry[]
  undoneAt: number | null
}

// 受け付けるレコードの種類と、id の接頭辞（MAI-7）
const RECORD_PREFIX: Record<string, string> = { canvas: 'canvas:', file: 'file:', node: 'node:', binding: 'binding:', anchor: 'anchor:' }

export class RecordStore {
  private readonly db: DatabaseSync
  readonly path: string
  private readonly maxAgentOps: number
  private readonly maxAgentOpsBytes: number

  constructor(dataDir: string, options: RecordStoreOptions = {}) {
    this.maxAgentOps = options.maxAgentOps ?? MAX_AGENT_OPS
    this.maxAgentOpsBytes = options.maxAgentOpsBytes ?? MAX_AGENT_OPS_BYTES
    mkdirSync(dataDir, { recursive: true })
    this.path = join(dataDir, 'workspace.db')
    const existed = existsSync(this.path)
    this.db = new DatabaseSync(this.path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    // チェックポイントのあとも、WAL のファイルを JOURNAL_SIZE_LIMIT より大きいまま残さない（大きな書き込みのあとに膨らんだままにしない）
    this.db.exec(`PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT}`)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        type_name TEXT NOT NULL,
        parent_id TEXT,
        type TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        body TEXT NOT NULL,
        rev INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS records_parent ON records (parent_id);
      CREATE INDEX IF NOT EXISTS records_rev ON records (rev);
      CREATE INDEX IF NOT EXISTS records_type_name ON records (type_name);
      CREATE TABLE IF NOT EXISTS deleted (id TEXT PRIMARY KEY, rev INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS deleted_rev ON deleted (rev);
      CREATE TABLE IF NOT EXISTS refs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS refs_created_at ON refs (created_at);
    `)
    this.migrate(existed)
    if (this.meta('root') === null) this.createRoot()
  }

  get rev(): number {
    return Number(this.meta('rev') ?? 0)
  }

  get rootCanvasId(): string {
    return this.meta('root')!
  }

  // すべてのレコード（画面を開いたときに読む）
  load(): { rootCanvasId: string; rev: number; records: StoredRecord[] } {
    const rows = this.db.prepare('SELECT body FROM records').all() as { body: string }[]
    return { rootCanvasId: this.rootCanvasId, rev: this.rev, records: rows.map((row) => JSON.parse(row.body) as StoredRecord) }
  }

  // since より後の変更（つなぎ直したタブに渡す）
  changesSince(since: number): Changes {
    const records = (this.db.prepare('SELECT body FROM records WHERE rev > ?').all(since) as { body: string }[]).map(
      (row) => JSON.parse(row.body) as StoredRecord,
    )
    const deleted = (this.db.prepare('SELECT id FROM deleted WHERE rev > ?').all(since) as { id: string }[]).map((row) => row.id)
    return { rev: this.rev, records, deleted }
  }

  // 差分を 1 つのトランザクションで保存し、新しい変更番号を返す。正しくないレコードがあれば、何も保存せずに投げる
  // also は同じトランザクションの中で、ほかの表に書くとき（AI の編集の記録）
  apply(puts: unknown[], deletes: unknown[], also?: (rev: number) => void): number {
    for (const record of puts) validRecord(record)
    for (const id of deletes) if (typeof id !== 'string') throw new Error('invalid id')
    const rev = this.rev + 1
    const put = this.db.prepare(
      'INSERT INTO records (id, type_name, parent_id, type, version, body, rev) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET type_name = excluded.type_name, parent_id = excluded.parent_id, type = excluded.type, ' +
        'version = excluded.version, body = excluded.body, rev = excluded.rev',
    )
    const unmarkDeleted = this.db.prepare('DELETE FROM deleted WHERE id = ?')
    const remove = this.db.prepare('DELETE FROM records WHERE id = ?')
    const markDeleted = this.db.prepare('INSERT INTO deleted (id, rev) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET rev = excluded.rev')
    this.db.exec('BEGIN')
    try {
      for (const record of puts as StoredRecord[]) {
        const parent = typeof record.parentId === 'string' ? record.parentId : null
        const type = typeof record.type === 'string' ? record.type : null
        const version = typeof record.version === 'number' ? record.version : 1
        put.run(record.id, record.typeName, parent, type, version, JSON.stringify(record), rev)
        unmarkDeleted.run(record.id)
      }
      for (const id of deletes as string[]) {
        remove.run(id)
        markDeleted.run(id, rev)
      }
      // ルートの Canvas は消させない
      if (!this.db.prepare('SELECT 1 FROM records WHERE id = ?').get(this.rootCanvasId)) throw new Error('the root canvas cannot be deleted')
      also?.(rev)
      this.setMeta('rev', String(rev))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return rev
  }

  // レコードを最後に変えた変更番号（ないものは入れない）
  revsOf(ids: readonly string[]): Map<string, number> {
    const out = new Map<string, number>()
    if (ids.length === 0) return out
    const rows = this.db.prepare('SELECT id, rev FROM records WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as { id: string; rev: number }[]
    for (const row of rows) out.set(row.id, Number(row.rev))
    return out
  }

  // 差分を保存し、AI の編集として記録する（同じトランザクション）。古い記録は、件数（MAX_AGENT_OPS）と
  // 合計の大きさ（MAX_AGENT_OPS_BYTES）に収まるように消す
  applyAgentOp(op: Omit<AgentOp, 'rev' | 'undoneAt'>): number {
    const puts = op.patch.flatMap((e) => (e.after ? [e.after] : []))
    const deletes = op.patch.flatMap((e) => (e.after ? [] : [e.id]))
    return this.apply(puts, deletes, (rev) => {
      this.db
        .prepare('INSERT INTO agent_ops (id, canvas_id, label, created_at, rev, patch) VALUES (?, ?, ?, ?, ?, ?)')
        .run(op.id, op.canvasId, op.label, op.createdAt, rev, JSON.stringify(op.patch))
      this.pruneAgentOps()
    })
  }

  // 新しいものから数えて、件数か合計の大きさが上限を超えたところから先（古いもの）を消す。いちばん新しい 1 件は必ず残す
  private pruneAgentOps(): void {
    const rows = this.db.prepare('SELECT id, length(CAST(patch AS BLOB)) AS bytes FROM agent_ops ORDER BY created_at DESC, rowid DESC').all() as { id: string; bytes: number }[]
    const remove = this.db.prepare('DELETE FROM agent_ops WHERE id = ?')
    let total = 0
    for (const [i, row] of rows.entries()) {
      total += Number(row.bytes)
      if (i > 0 && (i >= this.maxAgentOps || total > this.maxAgentOpsBytes)) remove.run(row.id)
    }
  }

  getAgentOp(id: string): AgentOp | undefined {
    const row = this.db.prepare('SELECT * FROM agent_ops WHERE id = ?').get(id) as
      | { id: string; canvas_id: string; label: string; created_at: number; rev: number; patch: string; undone_at: number | null }
      | undefined
    if (!row) return undefined
    return {
      id: row.id,
      canvasId: row.canvas_id,
      label: row.label,
      createdAt: Number(row.created_at),
      rev: Number(row.rev),
      patch: JSON.parse(row.patch) as AgentOpEntry[],
      undoneAt: row.undone_at === null ? null : Number(row.undone_at),
    }
  }

  // AI の編集を取り消した差分を保存し、取り消したことを記録する（同じトランザクション）
  applyAgentUndo(id: string, puts: StoredRecord[], deletes: string[]): number {
    return this.apply(puts, deletes, () => {
      this.db.prepare('UPDATE agent_ops SET undone_at = ? WHERE id = ?').run(Date.now(), id)
    })
  }

  // 1 件のレコード（なければ undefined）
  get(id: string): StoredRecord | undefined {
    const row = this.db.prepare('SELECT body FROM records WHERE id = ?').get(id) as { body: string } | undefined
    return row ? (JSON.parse(row.body) as StoredRecord) : undefined
  }

  // parentId がこれのノード（Canvas の上のノード、group / frame の子）
  childrenOf(parentId: string): StoredRecord[] {
    const rows = this.db.prepare('SELECT body FROM records WHERE parent_id = ?').all(parentId) as { body: string }[]
    return rows.map((row) => JSON.parse(row.body) as StoredRecord)
  }

  // この種類（typeName）のレコード（AI に Canvas の木を渡すときに、Canvas と File だけを読む）
  ofTypeName(typeName: string): StoredRecord[] {
    const rows = this.db.prepare('SELECT body FROM records WHERE type_name = ?').all(typeName) as { body: string }[]
    return rows.map((row) => JSON.parse(row.body) as StoredRecord)
  }

  // ノードの数を親ごとに数える。group / frame / slide / slide-layout の親も返す（Canvas ごとの数を、中身を読まずに足し上げるため）
  nodeCounts(): { counts: Map<string, number>; containers: Map<string, string> } {
    const counts = new Map<string, number>()
    for (const row of this.db.prepare("SELECT parent_id, COUNT(*) AS n FROM records WHERE type_name = 'node' GROUP BY parent_id").all() as { parent_id: string | null; n: number }[]) {
      if (row.parent_id !== null) counts.set(row.parent_id, Number(row.n))
    }
    const containers = new Map<string, string>()
    for (const row of this.db.prepare("SELECT id, parent_id FROM records WHERE type_name = 'node' AND type IN ('group', 'frame', 'slide', 'slide-layout')").all() as { id: string; parent_id: string | null }[]) {
      if (row.parent_id !== null) containers.set(row.id, row.parent_id)
    }
    return { counts, containers }
  }

  // この型（type）のノードの id（起動時の片付けで、消した型のノードを探す）
  nodeIdsOfTypes(types: readonly string[]): string[] {
    if (types.length === 0) return []
    const rows = this.db
      .prepare("SELECT id FROM records WHERE type_name = 'node' AND type IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(types)) as { id: string }[]
    return rows.map((row) => row.id)
  }

  // AI の編集の記録のうち、この型のノードを含むものを消し、消した数を返す（取り消しで、消した型のノードを戻さないように）
  deleteAgentOpsWithNodeTypes(types: readonly string[]): number {
    let removed = 0
    const remove = this.db.prepare('DELETE FROM agent_ops WHERE id = ?')
    for (const row of this.db.prepare('SELECT id, patch FROM agent_ops').all() as { id: string; patch: string }[]) {
      const patch = JSON.parse(row.patch) as AgentOpEntry[]
      const touches = patch.some((entry) => [entry.before, entry.after].some((record) => record?.typeName === 'node' && types.includes(String(record.type))))
      if (!touches) continue
      remove.run(row.id)
      removed++
    }
    return removed
  }

  // 矢印（fromId）のつながり（Binding）
  bindingsFrom(arrowIds: readonly string[]): StoredRecord[] {
    if (arrowIds.length === 0) return []
    const rows = this.db
      .prepare("SELECT body FROM records WHERE type_name = 'binding' AND json_extract(body, '$.fromId') IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(arrowIds)) as { body: string }[]
    return rows.map((row) => JSON.parse(row.body) as StoredRecord)
  }

  // since より後に変わったレコードの id と、消えたレコードの id（中身は読まない）
  idsChangedSince(since: number): { changed: Set<string>; deleted: string[] } {
    const changed = new Set((this.db.prepare('SELECT id FROM records WHERE rev > ?').all(since) as { id: string }[]).map((row) => row.id))
    const deleted = (this.db.prepare('SELECT id FROM deleted WHERE rev > ? ORDER BY rev').all(since) as { id: string }[]).map((row) => row.id)
    return { changed, deleted }
  }

  // AI に渡す参照（ref）を保存する。同期するレコードとは別のテーブルに置き、rev も進めない（ブラウザには流さない）。
  // 書き換えはしない。同じ id がすでにあれば RefConflictError を投げる
  putRef(ref: ReferenceRecord): void {
    try {
      this.db.prepare('INSERT INTO refs (id, kind, body, created_at) VALUES (?, ?, ?, ?)').run(ref.id, ref.kind, JSON.stringify(ref), ref.createdAt)
    } catch (error) {
      if (this.getRef(ref.id)) throw new RefConflictError(ref.id)
      throw error
    }
  }

  getRef(id: string): ReferenceRecord | undefined {
    const row = this.db.prepare('SELECT body FROM refs WHERE id = ?').get(id) as { body: string } | undefined
    return row ? (JSON.parse(row.body) as ReferenceRecord) : undefined
  }

  // created_at が cutoff より前の ref を消し、消した id を返す（MAI-65）
  deleteRefsOlderThan(cutoff: number): string[] {
    this.db.exec('BEGIN')
    try {
      const ids = (this.db.prepare('SELECT id FROM refs WHERE created_at < ?').all(cutoff) as { id: string }[]).map((row) => row.id)
      this.db.prepare('DELETE FROM refs WHERE created_at < ?').run(cutoff)
      this.db.exec('COMMIT')
      return ids
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // すべての表のすべての行の、文字列とバイト列の値を visit に渡し、records の行数を返す（使われていない Asset を探すとき。assetGc.ts）
  forEachText(visit: (text: string) => void): { records: number } {
    return forEachTextInDb(this.db, visit)
  }

  // 動かしたまま、一貫した写しを作る（MAI-13 の「8. バックアップ」）
  snapshot(path: string): void {
    this.db.prepare('VACUUM INTO ?').run(path)
  }

  // レコードを一度に書き換える前（移行・片付け）の写し（workspace.db.before-<label>-<時刻>.bak）を作り、その場所を返す。
  // 写しは新しい DB_BACKUPS_TO_KEEP 個だけを残し、古いものを消す
  backupBefore(label: string): string {
    const path = `${this.path}.before-${label}-${Date.now()}.bak`
    this.snapshot(path)
    pruneDbBackups(dirname(this.path))
    return path
  }

  close(): void {
    this.db.close()
  }

  private createRoot(): void {
    const id = `canvas:${randomId()}`
    const now = Date.now()
    const root = { typeName: 'canvas', id, title: 'ホーム', parentCanvasId: null, ownerNodeId: null, createdAt: now, updatedAt: now, deletedAt: null, trash: null }
    this.db.exec('BEGIN')
    this.setMeta('root', id)
    this.db.prepare('INSERT INTO records (id, type_name, parent_id, type, version, body, rev) VALUES (?, ?, NULL, NULL, 1, ?, ?)').run(id, 'canvas', JSON.stringify(root), this.rev)
    this.db.exec('COMMIT')
  }

  // 新しく作った db も版 1 から順に当てる（版 2 からの表は MIGRATIONS だけで作る）。写しを作るのは、前からあった db だけ
  private migrate(existed: boolean): void {
    const current = Number(this.meta('schema') ?? 1)
    if (current < SCHEMA_VERSION) {
      // 適用する前に写しを作る（WAL の中身も含めて写すため、VACUUM INTO を使う）
      if (existed) this.backupBefore(`v${SCHEMA_VERSION}`)
      for (let v = current + 1; v <= SCHEMA_VERSION; v++) MIGRATIONS[v]?.(this.db)
    }
    this.setMeta('schema', String(SCHEMA_VERSION))
  }

  private meta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }
}

export class RefConflictError extends Error {
  constructor(id: string) {
    super(`ref already exists: ${id}`)
  }
}

function validRecord(value: unknown): asserts value is StoredRecord {
  const record = value as StoredRecord
  const prefix = record && typeof record === 'object' ? RECORD_PREFIX[record.typeName] : undefined
  if (!prefix || typeof record.id !== 'string' || !record.id.startsWith(prefix)) throw new Error(`invalid record: ${JSON.stringify(value)?.slice(0, 200)}`)
}

function randomId(): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  return [...randomBytes(16)].map((b) => alphabet[b % 62]).join('')
}

// db のすべての表（sqlite_ で始まる内部の表を除く）のすべての行の、文字列とバイト列（latin1 で文字列にする）の値を visit に渡す。
// 表の形を知らずに読むので、新しい表・古い版の写し（*.bak）でも漏れない。records の行数を返す（表がなければ 0）
export function forEachTextInDb(db: DatabaseSync, visit: (text: string) => void): { records: number } {
  let records = 0
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]
  for (const { name } of tables) {
    for (const row of db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).iterate()) {
      if (name === 'records') records++
      for (const value of Object.values(row as Record<string, unknown>)) {
        if (typeof value === 'string') visit(value)
        else if (value instanceof Uint8Array) visit(Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('latin1'))
      }
    }
  }
  return { records }
}

// 移行・片付けの前の写し（workspace.db.before-*.bak）のうち、新しい keep 個を残して消し、消したものの名前を返す。
// 新しさは名前の末尾の時刻（ミリ秒）で決める。時刻が読めない名前は、更新時刻で比べる
export const DB_BACKUPS_TO_KEEP = 2
const DB_BACKUP_PATTERN = /^workspace\.db\.before-.+\.bak$/

export function pruneDbBackups(dataDir: string, keep = DB_BACKUPS_TO_KEEP): string[] {
  const backups = readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && DB_BACKUP_PATTERN.test(entry.name))
    .map((entry) => {
      const stamp = /-(\d{10,})\.bak$/.exec(entry.name)
      return { name: entry.name, time: stamp ? Number(stamp[1]) : statSync(join(dataDir, entry.name)).mtimeMs }
    })
    .sort((a, b) => b.time - a.time || (a.name < b.name ? 1 : -1))
  const removed: string[] = []
  for (const backup of backups.slice(keep)) {
    try {
      rmSync(join(dataDir, backup.name), { force: true })
      removed.push(backup.name)
    } catch (error) {
      console.error('failed to remove an old copy of workspace.db', backup.name, error)
    }
  }
  return removed
}

// 写しを作る（npm run snapshot）。.canvcode/snapshots/workspace-<日時>.db に置き、その場所を返す
export function snapshotWorkspace(dataDir: string): string {
  const store = new RecordStore(dataDir)
  try {
    const dir = join(dataDir, 'snapshots')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const path = join(dir, `workspace-${stamp}.db`)
    store.snapshot(path)
    return path
  } finally {
    store.close()
  }
}
