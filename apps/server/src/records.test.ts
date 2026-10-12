import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JOURNAL_SIZE_LIMIT, MAX_AGENT_OPS, MAX_AGENT_OPS_BYTES, RecordStore, RefConflictError, snapshotWorkspace } from './records.ts'

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
    expect(store.changesSince(1)).toEqual({ rev: 2, records: [expect.objectContaining({ id: 'node:c' })], deleted: ['node:a'] })
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

  it('migrates a version 1 database to version 2 (agent_ops) after making a copy', () => {
    const dir = dataDir()
    const store = new RecordStore(dir)
    store.apply([node('node:a', store.rootCanvasId)], [])
    store.close()
    // 版 1 の db にする（agent_ops がなく、schema が 1）
    const db = new DatabaseSync(join(dir, 'workspace.db'))
    db.exec("DROP TABLE agent_ops; UPDATE meta SET value = '1' WHERE key = 'schema'")
    db.close()
    const reopened = new RecordStore(dir)
    expect(readdirSync(dir).some((name) => name.startsWith('workspace.db.before-v2-'))).toBe(true)
    expect(reopened.get('node:a')).toBeDefined()
    const rev = reopened.applyAgentOp({ id: 'ai-1', canvasId: reopened.rootCanvasId, label: 'x', createdAt: 1, patch: [{ id: 'node:b', before: null, after: node('node:b', reopened.rootCanvasId) }] })
    expect(reopened.getAgentOp('ai-1')).toMatchObject({ rev, undoneAt: null, patch: [{ id: 'node:b', before: null }] })
    expect(reopened.revsOf(['node:a', 'node:b', 'node:none'])).toEqual(new Map([['node:a', 1], ['node:b', rev]]))
    reopened.close()
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
})
