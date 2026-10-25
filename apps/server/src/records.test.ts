import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DB_BACKUPS_TO_KEEP, JOURNAL_SIZE_LIMIT, MAX_AGENT_OPS, MAX_AGENT_OPS_BYTES, pruneDbBackups, RecordStore, RefConflictError, snapshotWorkspace } from './records.ts'

// レコードの保存（MAI-13、MAI-35）

const dirs: string[] = []
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'canvcode-records-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const node = (id: string, parentId: string, x = 0) => ({ typeName: 'node', id, type: 'geo', parentId, x, y: 0, props: {} })

describe('RecordStore', () => {
  it('keeps refs apart from the synced records and across restarts', () => {
    const dir = dataDir()
    const store = new RecordStore(dir)
    const ref = { typeName: 'ref', id: 'ref:Ab12Cd34Ef', createdAt: 1, kind: 'lines', fileId: 'file:a', startLine: 1, endLine: 2, snapshot: 'a\nb' } as const
    store.putRef(ref)
    expect(store.getRef(ref.id)).toEqual(ref)
    expect(store.getRef('ref:Zz99Zz99Zz')).toBeUndefined()
    expect(() => store.putRef({ ...ref, startLine: 2 })).toThrow(RefConflictError)
    expect(store.rev).toBe(0)
    expect(store.load().records.map((r) => r.typeName)).toEqual(['canvas'])
    expect(store.changesSince(0).records).toEqual([])
    store.close()
    const reopened = new RecordStore(dir)
    expect(reopened.getRef(ref.id)).toEqual(ref)
    reopened.close()
  })

  it('deletes refs older than a cutoff and returns their ids', () => {
    const store = new RecordStore(dataDir())
    const ref = (id: string, createdAt: number) => ({ typeName: 'ref', id, createdAt, kind: 'lines', fileId: 'file:a', startLine: 1, endLine: 1, snapshot: 'a' }) as const
    store.putRef(ref('ref:Old0000001', 100))
    store.putRef(ref('ref:Old0000002', 199))
    store.putRef(ref('ref:New0000001', 200))
    expect(store.deleteRefsOlderThan(200).sort()).toEqual(['ref:Old0000001', 'ref:Old0000002'])
    expect(store.getRef('ref:Old0000001')).toBeUndefined()
    expect(store.getRef('ref:New0000001')).toBeDefined()
    expect(store.deleteRefsOlderThan(200)).toEqual([])
    store.close()
  })

  it('reads one record and the children of a parent', () => {
    const store = new RecordStore(dataDir())
    const root = store.rootCanvasId
    store.apply([node('node:a', root), node('node:b', 'node:a')], [])
    expect(store.get('node:a')).toMatchObject({ id: 'node:a' })
    expect(store.get('node:none')).toBeUndefined()
    expect(store.childrenOf('node:a').map((r) => r.id)).toEqual(['node:b'])
    expect(store.childrenOf(root).map((r) => r.id)).toEqual(['node:a'])
    store.close()
  })

  it('creates the root canvas once and keeps it across restarts', () => {
    const dir = dataDir()
    const first = new RecordStore(dir)
    const root = first.rootCanvasId
    expect(first.load().records).toEqual([expect.objectContaining({ typeName: 'canvas', id: root, title: 'ホーム' })])
    first.close()
    const second = new RecordStore(dir)
    expect(second.rootCanvasId).toBe(root)
    second.close()
  })

  it('saves changes with an increasing revision and loads them after a restart', () => {
    const dir = dataDir()
    const store = new RecordStore(dir)
    const root = store.rootCanvasId
    expect(store.apply([node('node:a', root), node('node:b', root)], [])).toBe(1)
    expect(store.apply([node('node:a', root, 50)], ['node:b'])).toBe(2)
    store.close()
    const reopened = new RecordStore(dir)
    const { rev, records } = reopened.load()
    expect(rev).toBe(2)
    expect(records.filter((r) => r.typeName === 'node')).toEqual([expect.objectContaining({ id: 'node:a', x: 50 })])
    reopened.close()
  })

  it('returns the changes and deletions after a revision', () => {
    const store = new RecordStore(dataDir())
    const root = store.rootCanvasId
    store.apply([node('node:a', root), node('node:b', root)], [])
    store.apply([node('node:c', root)], ['node:a'])
    expect(store.changesSince(1)).toEqual({ rev: 2, records: [expect.objectContaining({ id: 'node:c' })], canvasIds: [store.rootCanvasId], deleted: ['node:a'] })
    // 消したものをまた入れたら、消した記録から外す
    store.apply([node('node:a', root)], [])
    expect(store.changesSince(2).deleted).toEqual([])
    store.close()
  })

  it('refuses invalid records and deleting the root, without saving anything', () => {
    const store = new RecordStore(dataDir())
    const root = store.rootCanvasId
    expect(() => store.apply([node('node:a', root), { typeName: 'node', id: 'canvas:x' }], [])).toThrow()
    expect(() => store.apply([node('node:b', root)], [root])).toThrow()
    expect(store.rev).toBe(0)
    expect(store.load().records).toHaveLength(1)
    store.close()
  })

  it('makes a snapshot copy', () => {
    const dir = dataDir()
    const store = new RecordStore(dir)
    store.apply([node('node:a', store.rootCanvasId)], [])
    const path = snapshotWorkspace(dir)
    expect(statSync(path).size).toBeGreaterThan(0)
    store.close()
  })

  it('migrates a version 1 database to the current version (agent_ops) after making a copy', () => {
    const dir = dataDir()
    const store = new RecordStore(dir)
    store.apply([node('node:a', store.rootCanvasId)], [])
    store.close()
    // 版 1 の db にする（agent_ops がなく、schema が 1）
    const db = new DatabaseSync(join(dir, 'workspace.db'))
    db.exec("DROP TABLE agent_ops; UPDATE meta SET value = '1' WHERE key = 'schema'")
    db.close()
    const reopened = new RecordStore(dir)
    expect(readdirSync(dir).some((name) => name.startsWith('workspace.db.before-v3-'))).toBe(true)
    expect(reopened.get('node:a')).toBeDefined()
    const rev = reopened.applyAgentOp({ id: 'ai-1', canvasId: reopened.rootCanvasId, label: 'x', createdAt: 1, patch: [{ id: 'node:b', before: null, after: node('node:b', reopened.rootCanvasId) }] })
    expect(reopened.getAgentOp('ai-1')).toMatchObject({ rev, undoneAt: null, patch: [{ id: 'node:b', before: null }] })
    expect(reopened.revsOf(['node:a', 'node:b', 'node:none'])).toEqual(new Map([['node:a', 1], ['node:b', rev]]))
    reopened.close()
  })

  describe('所属する Canvas（canvas_id）', () => {
    const canvas = (id: string) => ({ typeName: 'canvas', id, title: id, parentCanvasId: null, ownerNodeId: null, createdAt: 0, updatedAt: 0, deletedAt: null, trash: null })
    const binding = (id: string, fromId: string, toId: string) => ({ typeName: 'binding', id, type: 'arrow', fromId, toId, props: {} })

    it('resolves the canvas through parents in the same batch (in any order) and in the database', () => {
      const store = new RecordStore(dataDir())
      const root = store.rootCanvasId
      // 子が親より先に来る
      store.apply([node('node:child', 'node:group'), node('node:group', root), binding('binding:1', 'node:child', 'node:group')], [])
      store.apply([node('node:later', 'node:group')], [])
      for (const id of ['node:group', 'node:child', 'node:later', 'binding:1']) expect(store.canvasOf(id)).toBe(root)
      expect(store.canvasOf(root)).toBeNull()
      expect(store.canvasOf('node:none')).toBeNull()
      // 親がないノードは所属なし
      store.apply([node('node:orphan', 'node:missing')], [])
      expect(store.canvasOf('node:orphan')).toBeNull()
      store.close()
    })

    it('moves the descendants and their bindings along with a node moved to another canvas, raising their revision', () => {
      const store = new RecordStore(dataDir())
      const root = store.rootCanvasId
      store.apply([canvas('canvas:other')], [])
      store.apply([node('node:group', root), node('node:inner', 'node:group'), node('node:deep', 'node:inner'), node('node:arrow', 'node:inner'), binding('binding:1', 'node:arrow', 'node:deep'), node('node:stay', root)], [])
      const rev = store.rev
      store.apply([node('node:group', 'canvas:other')], [])
      for (const id of ['node:group', 'node:inner', 'node:deep', 'node:arrow', 'binding:1']) expect(store.canvasOf(id)).toBe('canvas:other')
      expect(store.canvasOf('node:stay')).toBe(root)
      const changes = store.changesSince(rev)
      expect(changes.records.map((r) => r.id).sort()).toEqual(['binding:1', 'node:arrow', 'node:deep', 'node:group', 'node:inner'])
      expect(new Set(changes.canvasIds)).toEqual(new Set(['canvas:other']))
      // 同じ Canvas の中で動かしただけなら、子孫は変えない
      const after = store.rev
      store.apply([{ ...node('node:group', 'canvas:other'), x: 10 }], [])
      expect(store.changesSince(after).records.map((r) => r.id)).toEqual(['node:group'])
      store.close()
    })

    it('deletes the records of a deleted canvas and records them in an agent edit so that undoing restores them', () => {
      const store = new RecordStore(dataDir())
      store.apply([canvas('canvas:gone'), node('node:a', 'canvas:gone'), node('node:b', 'node:a'), node('node:arrow', 'canvas:gone'), binding('binding:1', 'node:arrow', 'node:a')], [])
      const rev = store.rev
      store.apply([], ['canvas:gone'])
      for (const id of ['node:a', 'node:b', 'node:arrow', 'binding:1']) expect(store.get(id)).toBeUndefined()
      expect(store.changesSince(rev).deleted.sort()).toEqual(['binding:1', 'canvas:gone', 'node:a', 'node:arrow', 'node:b'])

      store.apply([canvas('canvas:ai'), node('node:c', 'canvas:ai')], [])
      store.applyAgentOp({ id: 'ai-1', canvasId: store.rootCanvasId, label: 'x', createdAt: 1, patch: [{ id: 'canvas:ai', before: canvas('canvas:ai'), after: null }] })
      expect(store.get('node:c')).toBeUndefined()
      expect(store.getAgentOp('ai-1')!.patch).toEqual([
        { id: 'canvas:ai', before: canvas('canvas:ai'), after: null },
        { id: 'node:c', before: expect.objectContaining({ id: 'node:c' }), after: null },
      ])
      store.close()
    })

    it('fills the canvas of existing records when migrating to version 3', () => {
      const dir = dataDir()
      const store = new RecordStore(dir)
      const root = store.rootCanvasId
      store.apply([node('node:a', root), node('node:b', 'node:a'), node('node:arrow', root), binding('binding:1', 'node:arrow', 'node:b'), node('node:loop1', 'node:loop2'), node('node:loop2', 'node:loop1')], [])
      store.close()
      // 版 2 の db にする（canvas_id がなく、schema が 2）
      const db = new DatabaseSync(join(dir, 'workspace.db'))
      db.exec("DROP INDEX records_canvas; ALTER TABLE records DROP COLUMN canvas_id; UPDATE meta SET value = '2' WHERE key = 'schema'")
      db.close()
      const reopened = new RecordStore(dir)
      for (const id of ['node:a', 'node:b', 'node:arrow', 'binding:1']) expect(reopened.canvasOf(id)).toBe(root)
      expect(reopened.canvasOf('node:loop1')).toBeNull()
      reopened.close()
    })
  })

  it('limits the size of the WAL file to 16 MB', () => {
    const store = new RecordStore(dataDir())
    const db = (store as unknown as { db: DatabaseSync }).db
    expect(db.prepare('PRAGMA journal_size_limit').get()).toEqual({ journal_size_limit: 16 * 1024 * 1024 })
    expect(JOURNAL_SIZE_LIMIT).toBe(16 * 1024 * 1024)
    store.close()
  })

  describe('AI の編集の記録の上限', () => {
    // patch の JSON がおよそ bytes バイトになる記録
    const op = (store: RecordStore, n: number, bytes: number) =>
      store.applyAgentOp({
        id: `ai-${n}`,
        canvasId: store.rootCanvasId,
        label: String(n),
        createdAt: n,
        patch: [{ id: `node:n${n}`, before: null, after: { ...node(`node:n${n}`, store.rootCanvasId), meta: { pad: 'x'.repeat(bytes) } } }],
      })
    const kept = (store: RecordStore, count: number) => Array.from({ length: count }, (_, i) => i + 1).filter((n) => store.getAgentOp(`ai-${n}`))

    it('keeps 50 ops and 20 MB by default', () => {
      expect(MAX_AGENT_OPS).toBe(50)
      expect(MAX_AGENT_OPS_BYTES).toBe(20 * 1024 * 1024)
      const store = new RecordStore(dataDir())
      for (let n = 1; n <= 53; n++) op(store, n, 10)
      expect(kept(store, 53)).toEqual(Array.from({ length: 50 }, (_, i) => i + 4))
      store.close()
    })

    it('removes the oldest ops beyond the total size', () => {
      const store = new RecordStore(dataDir(), { maxAgentOpsBytes: 3500 })
      for (let n = 1; n <= 5; n++) op(store, n, 1000)
      // 1 件はおよそ 1100 バイト。新しい 3 件で 3500 バイトに収まる
      expect(kept(store, 5)).toEqual([3, 4, 5])
      store.close()
    })

    it('applies the count and the size limits together', () => {
      const store = new RecordStore(dataDir(), { maxAgentOps: 2, maxAgentOpsBytes: 100_000 })
      for (let n = 1; n <= 4; n++) op(store, n, 100)
      expect(kept(store, 4)).toEqual([3, 4])
      store.close()
    })

    it('keeps the newest op even when it alone is over the size limit', () => {
      const store = new RecordStore(dataDir(), { maxAgentOpsBytes: 500 })
      op(store, 1, 100)
      op(store, 2, 2000)
      expect(kept(store, 2)).toEqual([2])
      // 次の小さな記録が来たら、大きなものは消える
      op(store, 3, 100)
      expect(kept(store, 3)).toEqual([3])
      store.close()
    })

    it('counts the size in bytes, not in characters', () => {
      const store = new RecordStore(dataDir(), { maxAgentOpsBytes: 4000 })
      // 「あ」は UTF-8 で 3 バイト。600 文字でおよそ 1900 バイト
      for (let n = 1; n <= 3; n++)
        store.applyAgentOp({ id: `ai-${n}`, canvasId: store.rootCanvasId, label: '', createdAt: n, patch: [{ id: `node:n${n}`, before: null, after: { ...node(`node:n${n}`, store.rootCanvasId), meta: { pad: 'あ'.repeat(600) } } }] })
      expect(kept(store, 3)).toEqual([2, 3])
      store.close()
    })
  })

  describe('移行・片付けの前の写し', () => {
    it('keeps only the newest two copies of workspace.db', () => {
      expect(DB_BACKUPS_TO_KEEP).toBe(2)
      const dir = dataDir()
      const names = [
        'workspace.db.before-v2-1791022997711.bak',
        'workspace.db.before-slides-v1-removal-1791207891760.bak',
        'workspace.db.before-v2-1791300000000.bak',
      ]
      for (const name of names) writeFileSync(join(dir, name), 'x')
      // 写しでないものには触れない
      for (const name of ['workspace.db', 'workspace.db-wal', 'other.bak', 'workspace.db.bak']) writeFileSync(join(dir, name), 'x')
      expect(pruneDbBackups(dir)).toEqual(['workspace.db.before-v2-1791022997711.bak'])
      expect(readdirSync(dir).sort()).toEqual(['other.bak', 'workspace.db', 'workspace.db-wal', 'workspace.db.bak', names[1], names[2]].sort())
      expect(pruneDbBackups(dir)).toEqual([])
    })

    it('orders copies without a time in the name by mtime', () => {
      const dir = dataDir()
      writeFileSync(join(dir, 'workspace.db.before-a.bak'), 'x')
      writeFileSync(join(dir, 'workspace.db.before-b.bak'), 'x')
      utimesSync(join(dir, 'workspace.db.before-a.bak'), new Date(1000), new Date(1000))
      expect(pruneDbBackups(dir, 1)).toEqual(['workspace.db.before-a.bak'])
    })

    it('removes old copies when a migration makes a new one', () => {
      const dir = dataDir()
      new RecordStore(dir).close()
      for (const stamp of [1, 2, 3]) writeFileSync(join(dir, `workspace.db.before-v2-${1790000000000 + stamp}.bak`), 'x')
      const db = new DatabaseSync(join(dir, 'workspace.db'))
      db.exec("DROP TABLE agent_ops; UPDATE meta SET value = '1' WHERE key = 'schema'")
      db.close()
      new RecordStore(dir).close()
      const backups = readdirSync(dir).filter((name) => name.endsWith('.bak')).sort()
      expect(backups).toHaveLength(2)
      expect(backups[0]).toBe('workspace.db.before-v2-1790000000003.bak')
      // 新しく作った写しは、開ける db
      const copy = new DatabaseSync(join(dir, backups[1]), { readOnly: true })
      expect(copy.prepare("SELECT value FROM meta WHERE key = 'schema'").get()).toEqual({ value: '1' })
      copy.close()
    })
  })
})
