import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { createBackup, pruneBackups, restoreBackup } from './backup.ts'
import { RecordStore } from './records.ts'
import { extractTar, tarChunks } from './tar.ts'

// ワークスペースのバックアップと復元

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'canvcode-backup-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const node = (id: string, parentId: string) => ({ typeName: 'node', id, type: 'geo', parentId, x: 0, y: 0, props: {} })
const HASH = 'a'.repeat(64)

function write(path: string, data: string | Buffer): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, data)
}

// 動いているサーバーの代わりに、RecordStore を開いたままにしたワークスペース
function workspace(): { dir: string; store: RecordStore } {
  const dir = join(tempDir(), 'ws')
  const store = new RecordStore(join(dir, '.canvcode'))
  store.apply([node('node:a', store.rootCanvasId)], [])
  write(join(dir, 'メモ.md'), '# メモ\n')
  write(join(dir, 'sub', 'code.py'), 'print(1)\n')
  write(join(dir, 'assets', 'figure.png'), 'png')
  write(join(dir, '.メモ.md.1.2.tmp'), 'half')
  write(join(dir, '.canvcode', 'files.json'), '{"version":1,"files":[]}')
  write(join(dir, '.canvcode', 'assets', `${HASH}.pdf`), 'pdf')
  write(join(dir, '.canvcode', 'assets', `${HASH}.json`), '{}')
  write(join(dir, '.canvcode', 'assets', `${HASH}.json.1.2.tmp`), '{')
  write(join(dir, '.canvcode', 'thumbnails', 'canvas_x.png'), 'thumb')
  write(join(dir, '.canvcode', 'ref-images', 'ref_Ab12Cd34Ef.png'), 'ref')
  write(join(dir, '.canvcode', 'texmf', 'luatex-cache', 'x'), 'cache')
  write(join(dir, '.canvcode', 'imports', 'old.ricbackup'), 'old')
  write(join(dir, '.canvcode', 'workspace.db.before-v2-1.bak'), 'bak')
  return { dir, store }
}

describe('createBackup / restoreBackup', () => {
  it('backs up a running workspace and restores it into a new folder', async () => {
    const { dir, store } = workspace()
    utimesSync(join(dir, 'メモ.md'), 1_700_000_000, 1_700_000_000)
    const out = join(tempDir(), 'out')
    const result = await createBackup({ workspace: dir, outDir: out })
    // バックアップのあとの変更は入らない
    store.apply([node('node:b', store.rootCanvasId)], [])
    store.close()
    expect(result.manifest.rev).toBe(1)
    expect(result.manifest.assetFiles).toEqual([`${HASH}.json`, `${HASH}.pdf`])
    expect(readdirSync(out)).toEqual([result.path.slice(out.length + 1)])

    const target = join(tempDir(), 'restored')
    const restored = await restoreBackup({ archive: result.path, workspace: target })
    expect(restored.manifest.rev).toBe(1)
    expect(readFileSync(join(target, 'メモ.md'), 'utf8')).toBe('# メモ\n')
    expect(statSync(join(target, 'メモ.md')).mtimeMs).toBe(1_700_000_000_000)
    expect(readFileSync(join(target, 'sub', 'code.py'), 'utf8')).toBe('print(1)\n')
    expect(existsSync(join(target, 'assets', 'figure.png'))).toBe(true)
    expect(readFileSync(join(target, '.canvcode', 'assets', `${HASH}.pdf`), 'utf8')).toBe('pdf')
    expect(existsSync(join(target, '.canvcode', 'thumbnails', 'canvas_x.png'))).toBe(true)
    expect(existsSync(join(target, '.canvcode', 'ref-images', 'ref_Ab12Cd34Ef.png'))).toBe(true)
    expect(existsSync(join(target, '.canvcode', 'files.json'))).toBe(true)
    // 入れないもの
    for (const path of ['.メモ.md.1.2.tmp', '.canvcode/texmf', '.canvcode/imports', '.canvcode/workspace.db.before-v2-1.bak', '.canvcode/workspace.db-wal', `.canvcode/assets/${HASH}.json.1.2.tmp`, 'canvcode-backup.json']) {
      expect(existsSync(join(target, path)), path).toBe(false)
    }
    // 復元した db は、そのままサーバーで開ける
    const reopened = new RecordStore(join(target, '.canvcode'))
    expect(reopened.rev).toBe(1)
    expect(reopened.get('node:a')).toBeDefined()
    expect(reopened.get('node:b')).toBeUndefined()
    reopened.close()
  })

  it('can leave the assets out and take them from another folder when restoring', async () => {
    const { dir, store } = workspace()
    store.close()
    const result = await createBackup({ workspace: dir, outDir: join(tempDir(), 'out'), assets: false, imports: true })
    expect(result.manifest.includesAssets).toBe(false)
    expect(result.manifest.assetFiles).toEqual([`${HASH}.json`, `${HASH}.pdf`])
    await expect(restoreBackup({ archive: result.path, workspace: join(tempDir(), 'a') })).rejects.toThrow('--assets')
    await expect(restoreBackup({ archive: result.path, workspace: join(tempDir(), 'b'), assetsFrom: tempDir() })).rejects.toThrow('見つかりません')
    const target = join(tempDir(), 'c')
    await restoreBackup({ archive: result.path, workspace: target, assetsFrom: join(dir, '.canvcode', 'assets') })
    expect(readFileSync(join(target, '.canvcode', 'assets', `${HASH}.pdf`), 'utf8')).toBe('pdf')
    expect(readFileSync(join(target, '.canvcode', 'imports', 'old.ricbackup'), 'utf8')).toBe('old')
  })

  it('does not restore over a folder that has files, and leaves nothing behind when it fails', async () => {
    const { dir, store } = workspace()
    store.close()
    const result = await createBackup({ workspace: dir, outDir: join(tempDir(), 'out') })
    await expect(restoreBackup({ archive: result.path, workspace: dir })).rejects.toThrow('空ではありません')
    const parent = tempDir()
    const broken = join(parent, 'broken.tar.gz')
    writeFileSync(broken, readFileSync(result.path).subarray(0, 200))
    await expect(restoreBackup({ archive: broken, workspace: join(parent, 'x') })).rejects.toThrow()
    expect(readdirSync(parent)).toEqual(['broken.tar.gz'])
  })

  it('keeps only the newest backups', async () => {
    const { dir, store } = workspace()
    store.close()
    const out = join(tempDir(), 'out')
    for (let i = 0; i < 3; i++) await createBackup({ workspace: dir, outDir: out, now: new Date(Date.UTC(2026, 0, 1 + i)) })
    const last = await createBackup({ workspace: dir, outDir: out, keep: 2, now: new Date(Date.UTC(2026, 0, 9)) })
    expect(last.removed).toHaveLength(2)
    expect(readdirSync(out).sort()).toEqual(['canvcode-backup-2026-01-03T00-00-00-000Z.tar.gz', 'canvcode-backup-2026-01-09T00-00-00-000Z.tar.gz'])
    await expect(pruneBackups(out, 0)).rejects.toThrow()
  })
})

describe('tar', () => {
  async function roundTrip(entries: { path: string; data: Buffer }[]): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of tarChunks(entries.map((e) => ({ ...e, mtime: 0 })))) chunks.push(chunk)
    const dest = tempDir()
    await extractTar(Readable.from([Buffer.concat(chunks)]), dest)
    return dest
  }

  it('keeps long and non-ASCII names and empty files', async () => {
    const long = `${'長い名前'.repeat(20)}/${'x'.repeat(150)}.md`
    const dest = await roundTrip([
      { path: long, data: Buffer.from('a'.repeat(1000)) },
      { path: 'empty.md', data: Buffer.alloc(0) },
    ])
    expect(readFileSync(join(dest, ...long.split('/')), 'utf8')).toBe('a'.repeat(1000))
    expect(readFileSync(join(dest, 'empty.md'), 'utf8')).toBe('')
  })

  it('refuses names outside the destination, both when writing and when reading', async () => {
    await expect(roundTrip([{ path: '../evil', data: Buffer.from('x') }])).rejects.toThrow('使えない名前')
    await expect(roundTrip([{ path: '/etc/evil', data: Buffer.from('x') }])).rejects.toThrow('使えない名前')
    // 外で作られた tar：名前を ../evil に書き換え、チェックサムを付け直す
    const chunks: Buffer[] = []
    for await (const chunk of tarChunks([{ path: 'xx/evil', data: Buffer.from('x'), mtime: 0 }])) chunks.push(chunk)
    const tar = Buffer.concat(chunks)
    tar.write('../evil', 0, 'ascii')
    tar.fill(0x20, 148, 156)
    let sum = 0
    for (let i = 0; i < 512; i++) sum += tar[i]
    tar.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
    const dest = tempDir()
    await expect(extractTar(Readable.from([tar]), join(dest, 'inner'))).rejects.toThrow('使えない名前')
    expect(existsSync(join(dest, 'evil'))).toBe(false)
  })
})
