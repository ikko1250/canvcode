import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AssetStore } from '../assets.ts'
import { FileStore } from '../files.ts'
import { RecordStore } from '../records.ts'
import { ThumbnailStore } from '../thumbnails.ts'
import { handleImport, sweepStaleUploads, UPLOAD_SUFFIX, type ImportDeps } from './import.ts'
import { zipBytes } from './testZip.ts'

// 旧データの取り込みの、元のファイルの扱い（取り込んだら残さない）

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'canvcode-import-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// 付箋が 1 つだけの .ricbackup
function backup(): Buffer {
  const note = {
    key: 'shape:n1',
    value: {
      typeName: 'shape',
      id: 'shape:n1',
      type: 'note',
      parentId: 'page:page',
      index: 'a1',
      x: 0,
      y: 0,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      meta: {},
      props: { color: 'yellow', size: 'm', richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '付箋' }] }] } },
    },
  }
  return zipBytes({
    'manifest.json': JSON.stringify({ magic: 'recursive-infinite-canvas-backup', formatVersion: 1, appDatabasePath: 'app/database.json', tldrawDatabasePaths: ['tldraw/0/database.json'] }),
    'app/database.json': JSON.stringify({ name: 'ric', version: 7, stores: { documents: [], contents: [], blobs: [], anchors: [], previews: [], conversations: [] } }),
    'tldraw/0/database.json': JSON.stringify({ name: 'TLDRAW_DOCUMENT_v2root-canvas', stores: { records: [note], assets: [] } }),
  })
}

async function setup(): Promise<{ dataDir: string; url: string; records: RecordStore }> {
  const workspace = tempDir()
  const dataDir = join(workspace, '.canvcode')
  const assets = new AssetStore(dataDir)
  await assets.init()
  const thumbnails = new ThumbnailStore(dataDir)
  await thumbnails.init()
  const records = new RecordStore(dataDir)
  const files = new FileStore(workspace, dataDir, () => {})
  await files.init()
  cleanups.push(async () => {
    records.close()
    await files.close()
  })
  const deps: ImportDeps = { dataDir, records, files, assets, thumbnails }
  const server: Server = createServer((req, res) => {
    void handleImport(req, res, new URL(req.url ?? '/', 'http://x').pathname, deps)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())))
  return { dataDir, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/import`, records }
}

const notes = (records: RecordStore) => records.load().records.filter((r) => r.typeName === 'node')

describe('POST /api/import', () => {
  it('imports an uploaded backup and does not keep it in imports/', async () => {
    const { dataDir, url, records } = await setup()
    // 以前に残した .ricbackup には触れない
    mkdirSync(join(dataDir, 'imports'))
    writeFileSync(join(dataDir, 'imports', '1790094256632-old.ricbackup'), 'old')
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-filename': 'my.ricbackup' }, body: new Uint8Array(backup()) })
    expect(response.status).toBe(200)
    expect(notes(records)).toHaveLength(1)
    expect(readdirSync(join(dataDir, 'imports'))).toEqual(['1790094256632-old.ricbackup'])
  })

  it('removes the uploaded file when the import fails', async () => {
    const { dataDir, url } = await setup()
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-filename': 'broken.ricbackup' }, body: 'not a zip' })
    expect(response.status).toBe(400)
    expect(readdirSync(join(dataDir, 'imports'))).toEqual([])
  })

  it('reads a file on the server where it is, without copying or removing it', async () => {
    const { dataDir, url, records } = await setup()
    const source = join(tempDir(), 'server.ricbackup')
    writeFileSync(source, backup())
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: source }) })
    expect(response.status).toBe(200)
    expect(notes(records)).toHaveLength(1)
    expect(readFileSync(source).equals(backup())).toBe(true)
    expect(existsSync(join(dataDir, 'imports'))).toBe(false)
  })

  it('leaves a file already in imports/ there when it is imported by its path', async () => {
    const { dataDir, url } = await setup()
    mkdirSync(join(dataDir, 'imports'))
    const kept = join(dataDir, 'imports', '1790094256632-workspace.ricbackup')
    writeFileSync(kept, backup())
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: kept }) })
    expect(response.status).toBe(200)
    expect(readdirSync(join(dataDir, 'imports'))).toEqual(['1790094256632-workspace.ricbackup'])
  })
})

describe('sweepStaleUploads', () => {
  it('removes only upload files that have not been written for a day', async () => {
    const dataDir = tempDir()
    const dir = join(dataDir, 'imports')
    mkdirSync(dir)
    const stale = `1-a.ricbackup${UPLOAD_SUFFIX}`
    const fresh = `2-b.ricbackup${UPLOAD_SUFFIX}`
    for (const name of [stale, fresh, '1790094256632-old.ricbackup']) writeFileSync(join(dir, name), 'x')
    const now = Date.now()
    const old = new Date(now - 25 * 60 * 60 * 1000)
    utimesSync(join(dir, stale), old, old)
    utimesSync(join(dir, '1790094256632-old.ricbackup'), new Date(0), new Date(0))
    expect(await sweepStaleUploads(dataDir, now)).toEqual([stale])
    expect(readdirSync(dir).sort()).toEqual(['1790094256632-old.ricbackup', fresh].sort())
    expect(await sweepStaleUploads(tempDir())).toEqual([])
  })
})
