import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ASSET_GC_STATE, ASSET_GRACE_MS, HashFinder, sweepUnusedAssets } from './assetGc.ts'
import { AssetStore } from './assets.ts'
import { RecordStore, snapshotWorkspace } from './records.ts'

// どこからも参照されなくなった Asset の片付け。誤って消すのがいちばん困るので、参照になりうる場所をひとつずつ確かめる

const DAY = 24 * 60 * 60 * 1000
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const hashOf = (c: string) => c.repeat(64)
const A = hashOf('a')
const B = hashOf('b')

// ファイルの時刻を古くする（受け取ったばかりの Asset は消さないので）
const OLD = new Date(Date.now() - 365 * DAY)

interface Env {
  workspace: string
  dataDir: string
  assets: string
  records: RecordStore
  sweep: (now: number) => ReturnType<typeof sweepUnusedAssets>
}

function env(): Env {
  const workspace = mkdtempSync(join(tmpdir(), 'canvcode-assetgc-'))
  const dataDir = join(workspace, '.canvcode')
  const assets = join(dataDir, 'assets')
  mkdirSync(assets, { recursive: true })
  const records = new RecordStore(dataDir)
  cleanups.push(() => rmSync(workspace, { recursive: true, force: true }))
  cleanups.push(() => records.close())
  return { workspace, dataDir, assets, records, sweep: (now) => sweepUnusedAssets({ workspace, dataDir, records, now }) }
}

// 画像の Asset（原本・縮小版・<ハッシュ>.json）
function image(e: Env, hash: string): string[] {
  const names = [`${hash}.png`, `${hash}.256.webp`, `${hash}.1024.webp`, `${hash}.json`]
  for (const name of names) writeFileSync(join(e.assets, name), name === `${hash}.json` ? JSON.stringify({ mime: 'image/png', size: 1, variants: { 256: 'webp', 1024: 'webp' } }) : 'x')
  age(e, names)
  return names
}

// PDF の Asset（原本・<ハッシュ>.json・pages.json・.txt）
function pdf(e: Env, hash: string): string[] {
  const names = [`${hash}.pdf`, `${hash}.json`, `${hash}.pages.json`, `${hash}.txt`]
  for (const name of names) writeFileSync(join(e.assets, name), '{}')
  age(e, names)
  return names
}

function age(e: Env, names: string[]): void {
  for (const name of names) utimesSync(join(e.assets, name), OLD, OLD)
}

const assetFiles = (e: Env) => readdirSync(e.assets).sort()
const state = (e: Env) => JSON.parse(readFileSync(join(e.dataDir, ASSET_GC_STATE), 'utf8')) as { unreferencedSince: Record<string, number> }

const node = (id: string, parentId: string, type: string, props: object) => ({ typeName: 'node', id, type, parentId, x: 0, y: 0, rotation: 0, index: 'a1', opacity: 1, locked: false, props, meta: {} })

// 30 日と少し空けて 2 回走らせ、残った Asset のハッシュを返す
async function survivors(e: Env, hashes: string[]): Promise<string[]> {
  const t0 = Date.now()
  await e.sweep(t0)
  await e.sweep(t0 + ASSET_GRACE_MS + 1000)
  const left = new Set(readdirSync(e.assets).map((name) => name.slice(0, 64)))
  return hashes.filter((hash) => left.has(hash))
}

describe('HashFinder', () => {
  it('finds hashes in any case, and inside longer runs of hex digits', () => {
    const finder = new HashFinder([A, B, hashOf('c'), hashOf('d')])
    finder.scan(`![](asset:${A.toUpperCase()}) ${'0'.repeat(10)}${B}${'f'.repeat(3)} ${hashOf('c').slice(1)}`)
    expect([...finder.found].sort()).toEqual([A, B])
    expect(finder.done).toBe(false)
  })
})

describe('sweepUnusedAssets', () => {
  it('removes an asset 30 days after it was first seen unreferenced, with all its derived files', async () => {
    expect(ASSET_GRACE_MS).toBe(30 * DAY)
    const e = env()
    image(e, A)
    pdf(e, B)
    const t0 = Date.now()
    // 1 回目：参照されていないことを覚えるだけ
    expect(await e.sweep(t0)).toMatchObject({ assets: 2, referenced: 0, waiting: 2, removed: [] })
    expect(state(e).unreferencedSince).toEqual({ [A]: t0, [B]: t0 })
    // 30 日経つまでは消さない（その間の回は、覚えた時刻を変えない）
    expect((await e.sweep(t0 + ASSET_GRACE_MS - 1)).removed).toEqual([])
    expect(state(e).unreferencedSince).toEqual({ [A]: t0, [B]: t0 })
    expect(assetFiles(e)).toHaveLength(8)
    const result = await e.sweep(t0 + ASSET_GRACE_MS)
    expect(result.removed.sort()).toEqual([A, B])
    expect(assetFiles(e)).toEqual([])
    expect(state(e).unreferencedSince).toEqual({})
  })

  it('removes the files of a real stored asset, and the list no longer has it', async () => {
    const e = env()
    const store = new AssetStore(e.dataDir)
    const hash = await store.storeOriginal(Buffer.from('png bytes'), 'image/png', 1, 1)
    age(e, readdirSync(e.assets))
    expect(await survivors(e, [hash])).toEqual([])
    expect(assetFiles(e)).toEqual([])
  })

  it('keeps an asset that is referenced again, and counts from the start when it is unreferenced again', async () => {
    const e = env()
    image(e, A)
    const t0 = Date.now()
    await e.sweep(t0)
    const root = e.records.rootCanvasId
    e.records.apply([node('node:img', root, 'image', { assetId: `asset:${A}`, w: 1, h: 1 })], [])
    expect(await e.sweep(t0 + ASSET_GRACE_MS)).toMatchObject({ referenced: 1, waiting: 0, removed: [] })
    expect(state(e).unreferencedSince).toEqual({})
    e.records.apply([], ['node:img'])
    // 消したノードは AI の編集の記録にもないので、参照はなくなる。ここから 30 日
    await e.sweep(t0 + ASSET_GRACE_MS + DAY)
    expect((await e.sweep(t0 + ASSET_GRACE_MS * 2)).removed).toEqual([])
    expect((await e.sweep(t0 + ASSET_GRACE_MS * 2 + DAY)).removed).toEqual([A])
  })

  describe('references in workspace.db', () => {
    it('keeps assets used by image nodes, image fills, PDF files and pages, and quote cards', async () => {
      const e = env()
      const hashes = ['1', '2', '3', '4', '5', '6'].map(hashOf)
      for (const hash of hashes) image(e, hash)
      const root = e.records.rootCanvasId
      e.records.apply(
        [
          node('node:img', root, 'image', { assetId: `asset:${hashes[0]}`, w: 1, h: 1, crop: null }),
          node('node:geo', root, 'geo', { fill: { type: 'image', assetId: `asset:${hashes[1]}`, opacity: 1 } }),
          { typeName: 'file', id: 'file:pdf', kind: 'pdf', title: '論文', path: '', size: 1, mtime: 1, hash: 'x', missing: false, assetId: `asset:${hashes[2]}`, pagesCanvasId: 'canvas:pages', pageCount: 1, parentCanvasId: null, ownerNodeId: null, createdAt: 1, updatedAt: 1, deletedAt: null, trash: null },
          node('node:page', root, 'pdf-page', { assetId: `asset:${hashes[3]}`, fileId: 'file:pdf', pageIndex: 0, w: 1, h: 1 }),
          node('node:quote', root, 'quote-card', { figure: { assetId: `asset:${hashes[4]}`, pageIndex: 0 } }),
        ],
        [],
      )
      expect(await survivors(e, hashes)).toEqual(hashes.slice(0, 5))
    })

    it('keeps assets of nodes in the trash and of the owner copied into a trash batch', async () => {
      const e = env()
      image(e, A)
      image(e, B)
      const trashed = { typeName: 'canvas', id: 'canvas:trashed', title: '捨てた', parentCanvasId: null, ownerNodeId: null, createdAt: 1, updatedAt: 1, deletedAt: 5, trash: { batchId: 'canvas:trashed', portal: node('node:owner', 'canvas:x', 'image', { assetId: `asset:${B}` }) } }
      e.records.apply([trashed, node('node:in-trash', 'canvas:trashed', 'image', { assetId: `asset:${A}` })], [])
      expect(await survivors(e, [A, B])).toEqual([A, B])
    })

    it('keeps assets that only an AI edit record (undone or not) or a ref mentions', async () => {
      const e = env()
      const hashes = ['1', '2', '3'].map(hashOf)
      for (const hash of hashes) image(e, hash)
      const root = e.records.rootCanvasId
      // AI が置いて、あとで消した（消した記録の before に残る）
      e.records.apply([node('node:a', root, 'image', { assetId: `asset:${hashes[0]}` })], [])
      e.records.applyAgentOp({ id: 'op:1', canvasId: root, label: 'delete', createdAt: 1, patch: [{ id: 'node:a', before: node('node:a', root, 'image', { assetId: `asset:${hashes[0]}` }), after: null }] })
      // AI が置いて、取り消した
      e.records.applyAgentOp({ id: 'op:2', canvasId: root, label: 'add', createdAt: 2, patch: [{ id: 'node:b', before: null, after: node('node:b', root, 'image', { assetId: `asset:${hashes[1]}` }) }] })
      e.records.applyAgentUndo('op:2', [], ['node:b'])
      e.records.putRef({ typeName: 'ref', id: 'ref:Ab12Cd34Ef', createdAt: 1, kind: 'lines', fileId: 'file:a', startLine: 1, endLine: 1, snapshot: `![](asset:${hashes[2]})` })
      expect(await survivors(e, hashes)).toEqual(hashes)
    })

    it('keeps assets that only a copy of workspace.db mentions (before-*.bak and snapshots)', async () => {
      const e = env()
      image(e, A)
      image(e, B)
      const root = e.records.rootCanvasId
      e.records.apply([node('node:a', root, 'image', { assetId: `asset:${A}` })], [])
      e.records.backupBefore('v9')
      e.records.apply([node('node:a', root, 'image', { assetId: `asset:${B}` })], [])
      snapshotWorkspace(e.dataDir)
      e.records.apply([], ['node:a'])
      expect(await survivors(e, [A, B])).toEqual([A, B])
    })

    it('does not remove anything when a copy of workspace.db cannot be read', async () => {
      const e = env()
      image(e, A)
      const t0 = Date.now()
      await e.sweep(t0)
      writeFileSync(join(e.dataDir, 'workspace.db.before-v9-1.bak'), 'not a database')
      await expect(e.sweep(t0 + ASSET_GRACE_MS)).rejects.toThrow()
      expect(assetFiles(e)).toHaveLength(4)
      rmSync(join(e.dataDir, 'workspace.db.before-v9-1.bak'))
      expect((await e.sweep(t0 + ASSET_GRACE_MS)).removed).toEqual([A])
    })

    it('reads workspace.db again before removing when it changed during the sweep', async () => {
      const e = env()
      image(e, A)
      const t0 = Date.now()
      await e.sweep(t0)
      // 1 回目に読んだあとで、ノードが置かれたことにする
      let rev = 1
      let calls = 0
      const records = {
        get rev() {
          return rev
        },
        forEachText(visit: (text: string) => void) {
          calls++
          if (calls === 1) {
            rev = 2
            visit('{}')
          } else visit(`{"assetId":"asset:${A}"}`)
          return { records: 1 }
        },
      } as unknown as RecordStore
      const result = await sweepUnusedAssets({ workspace: e.workspace, dataDir: e.dataDir, records, now: t0 + ASSET_GRACE_MS })
      expect(calls).toBe(2)
      expect(result.removed).toEqual([])
      expect(assetFiles(e)).toHaveLength(4)
      expect(state(e).unreferencedSince).toEqual({})
    })

    it('does not remove anything when workspace.db has no records', async () => {
      const e = env()
      image(e, A)
      const records = { rev: 0, forEachText: () => ({ records: 0 }) } as unknown as RecordStore
      await expect(sweepUnusedAssets({ workspace: e.workspace, dataDir: e.dataDir, records, now: Date.now() })).rejects.toThrow()
      expect(assetFiles(e)).toHaveLength(4)
    })
  })

  describe('references in files', () => {
    it('keeps assets mentioned in Markdown, Python and slide files anywhere in the workspace', async () => {
      const e = env()
      const hashes = ['1', '2', '3', '4', '5'].map(hashOf)
      for (const hash of hashes) image(e, hash)
      mkdirSync(join(e.workspace, 'sub', 'deeper'), { recursive: true })
      writeFileSync(join(e.workspace, 'メモ.md'), `# メモ\n\n![図](/api/assets/${hashes[0]})\n`)
      writeFileSync(join(e.workspace, 'sub', 'deeper', 'code.py'), `ASSET = "asset:${hashes[1]}"\n`)
      writeFileSync(join(e.workspace, 'sub', 'deck.slide.json'), JSON.stringify({ image: `asset:${hashes[2]}` }))
      // . で始まるフォルダ（.canvcode・.git を除く）も見る
      mkdirSync(join(e.workspace, '.notes'))
      writeFileSync(join(e.workspace, '.notes', 'n.txt'), hashes[3].toUpperCase())
      expect(await survivors(e, hashes)).toEqual(hashes.slice(0, 4))
    })

    it('finds a hash that crosses the boundary between the chunks of a large file', async () => {
      const e = env()
      image(e, A)
      // 1 MiB ずつ読むので、その境目にハッシュをまたがせる
      writeFileSync(join(e.workspace, 'big.md'), `${'あ'.repeat(349_525)}${A}\n`)
      expect(await survivors(e, [A])).toEqual([A])
    })

    it('keeps assets mentioned in deleted/, files.json and ref image info', async () => {
      const e = env()
      const hashes = ['1', '2', '3'].map(hashOf)
      for (const hash of hashes) image(e, hash)
      mkdirSync(join(e.dataDir, 'deleted'), { recursive: true })
      writeFileSync(join(e.dataDir, 'deleted', '1790085743872-無題.md'), `![](asset:${hashes[0]})`)
      writeFileSync(join(e.dataDir, 'files.json'), JSON.stringify({ version: 1, files: [{ id: `file:${hashes[1]}`, path: 'x.md' }] }))
      mkdirSync(join(e.dataDir, 'ref-images'))
      writeFileSync(join(e.dataDir, 'ref-images', 'ref_Ab12Cd34Ef.json'), JSON.stringify({ note: hashes[2] }))
      expect(await survivors(e, hashes)).toEqual(hashes)
    })

    it('does not count the assets folder itself, imports, .git, node_modules or binary files as references', async () => {
      const e = env()
      image(e, A)
      // Asset の <ハッシュ>.json は自分のハッシュを持たないが、ほかの Asset のファイル名にも惑わされない
      writeFileSync(join(e.assets, `${B}.json.123.456.tmp`), 'x')
      mkdirSync(join(e.dataDir, 'imports'))
      writeFileSync(join(e.dataDir, 'imports', 'old.ricbackup'), A)
      for (const dir of ['.git', 'node_modules']) {
        mkdirSync(join(e.workspace, dir))
        writeFileSync(join(e.workspace, dir, 'x.md'), A)
      }
      writeFileSync(join(e.workspace, 'image.png'), A)
      expect(await survivors(e, [A])).toEqual([])
    })
  })

  describe('safety', () => {
    it('does not remove an asset whose files were written within 30 days', async () => {
      const e = env()
      image(e, A)
      const t0 = Date.now()
      await e.sweep(t0 - ASSET_GRACE_MS - DAY)
      // 縮小版を受け取ったばかり
      utimesSync(join(e.assets, `${A}.256.webp`), new Date(), new Date())
      expect((await e.sweep(t0)).removed).toEqual([])
      expect(assetFiles(e)).toHaveLength(4)
    })

    it('removes a PDF even if its page images were made within 30 days (they are made again on start)', async () => {
      const e = env()
      pdf(e, A)
      const t0 = Date.now()
      await e.sweep(t0 - ASSET_GRACE_MS - DAY)
      writeFileSync(join(e.assets, `${A}.preview-v2.json`), '{}')
      writeFileSync(join(e.assets, `${A}.preview-v2.sheet0.webp`), 'x')
      expect((await e.sweep(t0)).removed).toEqual([A])
      expect(assetFiles(e)).toEqual([])
    })

    it('ignores assets that only have files being written, and leaves fresh temporary files alone', async () => {
      const e = env()
      writeFileSync(join(e.assets, `${A}.png.123.456.tmp`), 'x')
      expect((await e.sweep(Date.now())).assets).toBe(0)
      image(e, B)
      writeFileSync(join(e.assets, `${B}.256.webp.123.456.tmp`), 'x')
      const t0 = Date.now()
      await e.sweep(t0)
      // 時刻を進めずに消す（一時ファイルは 1 時間より新しい）
      await sweepUnusedAssets({ workspace: e.workspace, dataDir: e.dataDir, records: e.records, now: t0 + ASSET_GRACE_MS, graceMs: ASSET_GRACE_MS })
      expect(assetFiles(e)).toEqual([`${A}.png.123.456.tmp`, `${B}.256.webp.123.456.tmp`])
    })

    it('starts counting again when the saved time is in the future or the state file is broken', async () => {
      const e = env()
      image(e, A)
      image(e, B)
      const t0 = Date.now()
      writeFileSync(join(e.dataDir, ASSET_GC_STATE), JSON.stringify({ version: 1, unreferencedSince: { [A]: t0 + 10 * DAY, [B]: 'x' } }))
      expect((await e.sweep(t0)).removed).toEqual([])
      expect(state(e).unreferencedSince).toEqual({ [A]: t0, [B]: t0 })
      writeFileSync(join(e.dataDir, ASSET_GC_STATE), '{broken')
      expect((await e.sweep(t0 + ASSET_GRACE_MS)).removed).toEqual([])
      expect(state(e).unreferencedSince).toEqual({ [A]: t0 + ASSET_GRACE_MS, [B]: t0 + ASSET_GRACE_MS })
    })

    it('does nothing without an assets folder', async () => {
      const e = env()
      rmSync(e.assets, { recursive: true })
      expect(await e.sweep(Date.now())).toEqual({ assets: 0, referenced: 0, waiting: 0, removed: [] })
      expect(existsSync(e.assets)).toBe(false)
    })
  })
})
