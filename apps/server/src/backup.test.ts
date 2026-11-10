import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createGunzip, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { BACKUP_MANIFEST, createBackup, pruneBackups, restoreBackup } from './backup.ts'
import { BLOB_MIN_SIZE, isBlobFile } from './backupBlobs.ts'
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
  // PDF のページの画像（サーバーが作り直す）
  write(join(dir, '.canvcode', 'assets', `${HASH}.preview-v1.sheet0.webp`), 'webp')
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
    for (const path of ['.メモ.md.1.2.tmp', '.canvcode/texmf', '.canvcode/imports', '.canvcode/workspace.db.before-v2-1.bak', '.canvcode/workspace.db-wal', `.canvcode/assets/${HASH}.json.1.2.tmp`, `.canvcode/assets/${HASH}.preview-v1.sheet0.webp`, 'canvcode-backup.json']) {
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

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

// アーカイブを展開したフォルダ（復元を通さずに、アーカイブに入っているものを見る）
async function unpack(archive: string): Promise<string> {
  const dest = tempDir()
  await extractTar(createReadStream(archive).pipe(createGunzip()), dest)
  return dest
}

// 書いたばかりのファイルのハッシュは覚えないので、前に書いたことにする
function age(...paths: string[]): void {
  for (const path of paths) utimesSync(path, 1_700_000_000, 1_700_000_000)
}

describe('isBlobFile', () => {
  it('takes PDFs, images and the like by extension, and anything of 1 MiB or more', () => {
    expect(isBlobFile('research/x/sources/論文.PDF', 10)).toBe(true)
    expect(isBlobFile('assets/figure.png', 0)).toBe(true)
    expect(isBlobFile('.canvcode/thumbnails/canvas_x.png', 10)).toBe(true)
    expect(isBlobFile('data/book.xlsx', 10)).toBe(true)
    expect(isBlobFile('メモ.md', BLOB_MIN_SIZE - 1)).toBe(false)
    expect(isBlobFile('メモ.md', BLOB_MIN_SIZE)).toBe(true)
    expect(isBlobFile('sub/pdf', 10)).toBe(false)
    expect(isBlobFile('.png', 10)).toBe(false)
  })

  it('keeps the files directly under .canvcode in the archive', () => {
    expect(isBlobFile('.canvcode/files.json', 5 * BLOB_MIN_SIZE)).toBe(false)
    expect(isBlobFile('.canvcode/workspace.db', 5 * BLOB_MIN_SIZE)).toBe(false)
    expect(isBlobFile('.canvcode/deleted/古い.md', 5 * BLOB_MIN_SIZE)).toBe(true)
  })
})

describe('createBackup with blobsDir', () => {
  // PDF を 2 つ（中身は同じ）と、1 MiB 以上のテキストを足したワークスペース
  function workspaceWithBlobs(): { dir: string; store: RecordStore; big: string } {
    const { dir, store } = workspace()
    const big = 'あ'.repeat(BLOB_MIN_SIZE / 2)
    write(join(dir, 'research', 'sources', '論文.pdf'), 'pdf-1')
    write(join(dir, 'research', 'sources', '同じ論文.pdf'), 'pdf-1')
    write(join(dir, 'research', 'sources', '大きい.txt'), big)
    return { dir, store, big }
  }

  it('leaves the blob files out of the archive and stores each content once', async () => {
    const { dir, store, big } = workspaceWithBlobs()
    store.close()
    const blobsDir = join(dir, '.canvcode', 'backup-blobs')
    const result = await createBackup({ workspace: dir, outDir: join(dir, '.canvcode', 'backups'), assets: false, blobsDir })
    expect(result.manifest.format).toBe(2)
    expect(result.manifest.blobFiles.map((file) => [file.path, file.sha256, file.size])).toEqual([
      ['.canvcode/ref-images/ref_Ab12Cd34Ef.png', sha256('ref'), 3],
      ['.canvcode/thumbnails/canvas_x.png', sha256('thumb'), 5],
      ['assets/figure.png', sha256('png'), 3],
      ['research/sources/同じ論文.pdf', sha256('pdf-1'), 5],
      ['research/sources/大きい.txt', sha256(big), Buffer.byteLength(big)],
      ['research/sources/論文.pdf', sha256('pdf-1'), 5],
    ])
    expect(result.blobs).toMatchObject({ files: 6, hashed: 6, added: 5 })
    // 中身は、ハッシュの名前で 1 つずつ（同じ中身の PDF は 1 つ）
    expect(readdirSync(blobsDir).filter((name) => !name.startsWith('.')).sort()).toEqual([sha256('ref'), sha256('thumb'), sha256('png'), sha256('pdf-1'), sha256(big)].sort())
    expect(readFileSync(join(blobsDir, sha256('pdf-1')), 'utf8')).toBe('pdf-1')
    // アーカイブには、外に出したファイルが入らず、db の写しとテキストは入る
    const unpacked = await unpack(result.path)
    for (const path of ['research', 'assets', '.canvcode/thumbnails', '.canvcode/ref-images', '.canvcode/backup-blobs', '.canvcode/backups']) expect(existsSync(join(unpacked, path)), path).toBe(false)
    for (const path of ['メモ.md', 'sub/code.py', '.canvcode/workspace.db', '.canvcode/files.json', BACKUP_MANIFEST]) expect(existsSync(join(unpacked, path)), path).toBe(true)
    expect(result.files).toBe(4)
  })

  it('reads only the files that changed since the last backup', async () => {
    const { dir, store } = workspaceWithBlobs()
    store.close()
    const out = join(tempDir(), 'out')
    const blobsDir = join(tempDir(), 'blobs')
    const pdf = join(dir, 'research', 'sources', '論文.pdf')
    age(pdf, join(dir, 'research', 'sources', '同じ論文.pdf'), join(dir, 'research', 'sources', '大きい.txt'), join(dir, 'assets', 'figure.png'), join(dir, '.canvcode', 'thumbnails', 'canvas_x.png'))
    const backup = (day: number) => createBackup({ workspace: dir, outDir: out, assets: false, blobsDir, now: new Date(Date.UTC(2026, 0, day)) })
    expect((await backup(1)).blobs).toMatchObject({ files: 6, hashed: 6, added: 5 })
    // 書いたばかりの ref-images の PNG だけは、ハッシュを覚えていないので読み直す（中身は同じなので置かない）
    expect((await backup(2)).blobs).toMatchObject({ files: 6, hashed: 1, added: 0 })
    // 中身が変わったファイル（大きさは同じ・更新時刻が違う）は読み直して、新しい中身を置く。前の中身は消さない
    writeFileSync(pdf, 'pdf-2')
    utimesSync(pdf, 1_700_000_100, 1_700_000_100)
    const third = await backup(3)
    expect(third.blobs).toMatchObject({ files: 6, hashed: 2, added: 1, addedBytes: 5 })
    expect(third.manifest.blobFiles.find((file) => file.path === 'research/sources/論文.pdf')).toEqual({ path: 'research/sources/論文.pdf', sha256: sha256('pdf-2'), size: 5, mtime: 1_700_000_100_000 })
    expect(readFileSync(join(blobsDir, sha256('pdf-1')), 'utf8')).toBe('pdf-1')
    // 置いた中身がなくなっていたら、ハッシュを覚えていても読み直して置く
    rmSync(join(blobsDir, sha256('pdf-2')))
    expect((await backup(4)).blobs).toMatchObject({ hashed: 2, added: 1 })
    expect(readFileSync(join(blobsDir, sha256('pdf-2')), 'utf8')).toBe('pdf-2')
    // ハッシュの控えが壊れていたら、全部を読み直す（置いてある中身は書かない）
    writeFileSync(join(blobsDir, '.index.json'), '{')
    expect((await backup(5)).blobs).toMatchObject({ hashed: 6, added: 0 })
    expect(readdirSync(blobsDir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('restores the blob files from the folder, with the same content and time', async () => {
    const { dir, store, big } = workspaceWithBlobs()
    store.close()
    const pdf = join(dir, 'research', 'sources', '論文.pdf')
    utimesSync(pdf, 1_700_000_000, 1_700_000_000)
    const blobsDir = join(dir, '.canvcode', 'backup-blobs')
    const result = await createBackup({ workspace: dir, outDir: join(dir, '.canvcode', 'backups'), assets: false, blobsDir })
    const assetsFrom = join(dir, '.canvcode', 'assets')
    await expect(restoreBackup({ archive: result.path, workspace: join(tempDir(), 'a'), assetsFrom })).rejects.toThrow('--blobs')
    const target = join(tempDir(), 'restored')
    const restored = await restoreBackup({ archive: result.path, workspace: target, assetsFrom, blobsFrom: blobsDir })
    expect(restored.files).toBe(4 + 6)
    expect(readFileSync(join(target, 'research', 'sources', '論文.pdf'), 'utf8')).toBe('pdf-1')
    expect(statSync(join(target, 'research', 'sources', '論文.pdf')).mtimeMs).toBe(1_700_000_000_000)
    expect(readFileSync(join(target, 'research', 'sources', '同じ論文.pdf'), 'utf8')).toBe('pdf-1')
    expect(readFileSync(join(target, 'research', 'sources', '大きい.txt'), 'utf8')).toBe(big)
    expect(readFileSync(join(target, '.canvcode', 'thumbnails', 'canvas_x.png'), 'utf8')).toBe('thumb')
    expect(readFileSync(join(target, '.canvcode', 'assets', `${HASH}.pdf`), 'utf8')).toBe('pdf')
    expect(readFileSync(join(target, 'メモ.md'), 'utf8')).toBe('# メモ\n')
    for (const path of ['.canvcode/backup-blobs', BACKUP_MANIFEST]) expect(existsSync(join(target, path)), path).toBe(false)
    const reopened = new RecordStore(join(target, '.canvcode'))
    expect(reopened.get('node:a')).toBeDefined()
    reopened.close()
  })

  it('stops, naming the files, when a blob is missing or does not match its hash', async () => {
    const { dir, store } = workspaceWithBlobs()
    store.close()
    const blobsDir = join(tempDir(), 'blobs')
    const result = await createBackup({ workspace: dir, outDir: join(tempDir(), 'out'), assets: false, blobsDir })
    const assetsFrom = join(dir, '.canvcode', 'assets')
    const parent = tempDir()
    rmSync(join(blobsDir, sha256('pdf-1')))
    // 大きさは同じで中身が違う
    writeFileSync(join(blobsDir, sha256('thumb')), 'thumB')
    const failure = await restoreBackup({ archive: result.path, workspace: join(parent, 'x'), assetsFrom, blobsFrom: blobsDir }).then(
      () => null,
      (error: Error) => error.message,
    )
    expect(failure).toContain('中身が見つかりません（2 個）')
    expect(failure).toContain('research/sources/論文.pdf')
    expect(failure).toContain('research/sources/同じ論文.pdf')
    expect(failure).toContain('中身がハッシュと合いません（1 個）')
    expect(failure).toContain('.canvcode/thumbnails/canvas_x.png')
    // 途中まで戻したものは残さない
    expect(readdirSync(parent)).toEqual([])
  })

  it('keeps a manual backup self-contained when blobsDir is not given', async () => {
    const { dir, store } = workspaceWithBlobs()
    store.close()
    const result = await createBackup({ workspace: dir, outDir: join(tempDir(), 'out') })
    expect(result.manifest.blobFiles).toEqual([])
    expect(result.blobs).toEqual({ files: 0, bytes: 0, hashed: 0, added: 0, addedBytes: 0 })
    expect(existsSync(join(dir, '.canvcode', 'backup-blobs'))).toBe(false)
    const target = join(tempDir(), 'restored')
    await restoreBackup({ archive: result.path, workspace: target })
    expect(readFileSync(join(target, 'research', 'sources', '論文.pdf'), 'utf8')).toBe('pdf-1')
  })
})

describe('restoreBackup and the archive format', () => {
  // 手で作ったアーカイブ（manifest と db と、渡したファイル）
  async function archiveWith(manifest: Record<string, unknown>, files: { path: string; data: Buffer }[] = []): Promise<string> {
    const { dir, store } = workspace()
    store.close()
    const made = await createBackup({ workspace: dir, outDir: join(tempDir(), 'out') })
    const unpacked = await unpack(made.path)
    const entries = [
      { path: BACKUP_MANIFEST, data: Buffer.from(JSON.stringify({ ...made.manifest, ...manifest })), mtime: 0 },
      { path: '.canvcode/workspace.db', data: readFileSync(join(unpacked, '.canvcode', 'workspace.db')), mtime: 0 },
      { path: 'メモ.md', data: Buffer.from('# メモ\n'), mtime: 0 },
      ...files.map((file) => ({ ...file, mtime: 0 })),
    ]
    const chunks: Buffer[] = []
    for await (const chunk of tarChunks(entries)) chunks.push(chunk)
    const path = join(tempDir(), 'canvcode-backup-2026-01-01T00-00-00-000Z.tar.gz')
    writeFileSync(path, gzipSync(Buffer.concat(chunks)))
    return path
  }

  it('still restores an archive of the old format, which has no blobFiles', async () => {
    const archive = await archiveWith({ format: 1, blobFiles: undefined, includesAssets: true, assetFiles: [] }, [{ path: 'research/論文.pdf', data: Buffer.from('pdf-1') }])
    const target = join(tempDir(), 'restored')
    const restored = await restoreBackup({ archive, workspace: target })
    expect(restored.manifest.format).toBe(1)
    expect(readFileSync(join(target, 'research', '論文.pdf'), 'utf8')).toBe('pdf-1')
    expect(readFileSync(join(target, 'メモ.md'), 'utf8')).toBe('# メモ\n')
  })

  it('refuses a newer format', async () => {
    const archive = await archiveWith({ format: 3 })
    await expect(restoreBackup({ archive, workspace: join(tempDir(), 'x') })).rejects.toThrow('新しい形式')
  })

  it('refuses blob files that point outside the destination or onto a file from the archive', async () => {
    const blobsFrom = tempDir()
    writeFileSync(join(blobsFrom, sha256('x')), 'x')
    const entry = (path: string) => ({ includesAssets: true, assetFiles: [], blobFiles: [{ path, sha256: sha256('x'), size: 1, mtime: 0 }] })
    const parent = tempDir()
    await expect(restoreBackup({ archive: await archiveWith(entry('../evil')), workspace: join(parent, 'a'), blobsFrom })).rejects.toThrow('使えない名前')
    await expect(restoreBackup({ archive: await archiveWith(entry('メモ.md')), workspace: join(parent, 'b'), blobsFrom })).rejects.toThrow('EEXIST')
    await expect(restoreBackup({ archive: await archiveWith(entry(BACKUP_MANIFEST)), workspace: join(parent, 'c'), blobsFrom })).rejects.toThrow('EEXIST')
    await expect(restoreBackup({ archive: await archiveWith({ ...entry('a.pdf'), blobFiles: [{ path: 'a.pdf', sha256: '../x', size: 1 }] }), workspace: join(parent, 'd'), blobsFrom })).rejects.toThrow('壊れています')
    expect(readdirSync(parent)).toEqual([])
    expect(existsSync(join(parent, '..', 'evil'))).toBe(false)
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
