import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DELETED_TTL_MS, sweepDeletedFiles } from './storageCleanup.ts'

// .canvcode の中の、たまっていくものの片付け

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'canvcode-storage-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('sweepDeletedFiles', () => {
  it('removes files moved to deleted/ more than 90 days ago, judged by the time in the name', async () => {
    expect(DELETED_TTL_MS).toBe(90 * 24 * 60 * 60 * 1000)
    const dataDir = tempDir()
    const deleted = join(dataDir, 'deleted')
    mkdirSync(deleted)
    const now = 1_800_000_000_000
    const old = `${now - DELETED_TTL_MS - 1}-古いメモ.md`
    const edge = `${now - DELETED_TTL_MS + 1000}-もうすぐ.md`
    const recent = `${now - 1000}-新しいメモ.md`
    for (const name of [old, edge, recent]) writeFileSync(join(deleted, name), 'x')
    // 中身の更新時刻（mtime）は移しても変わらないので、古くても関係ない
    utimesSync(join(deleted, recent), new Date(0), new Date(0))
    // フォルダには触れない
    const folder = `${now - DELETED_TTL_MS * 2}-folder`
    mkdirSync(join(deleted, folder))
    expect(await sweepDeletedFiles(dataDir, now)).toEqual([old])
    expect(readdirSync(deleted).sort()).toEqual([edge, recent, folder].sort())
  })

  it('judges files without a time in the name by ctime, and does nothing without deleted/', async () => {
    const dataDir = tempDir()
    expect(await sweepDeletedFiles(dataDir)).toEqual([])
    mkdirSync(join(dataDir, 'deleted'))
    writeFileSync(join(dataDir, 'deleted', '手で置いた.md'), 'x')
    expect(await sweepDeletedFiles(dataDir)).toEqual([])
    expect(await sweepDeletedFiles(dataDir, Date.now() + DELETED_TTL_MS + 1000)).toEqual(['手で置いた.md'])
    expect(existsSync(join(dataDir, 'deleted', '手で置いた.md'))).toBe(false)
  })
})
