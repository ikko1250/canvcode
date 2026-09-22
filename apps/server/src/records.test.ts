import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RecordStore, snapshotWorkspace } from './records.ts'

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
})
