import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, rmdir, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import { BlobStore, isBlobFile, restoreBlobs, type BlobFile } from './backupBlobs.ts'
import { isPdfPreviewFile } from './pdfPreview.ts'
import { extractTar, readFirstTarFile, tarChunks, type TarEntry } from './tar.ts'

// ワークスペースのバックアップと復元（MAI-13 の「8. バックアップと書き出し」）。
// 1 つの .tar.gz に、ワークスペースを元に戻すのに要るものをまとめる。サーバーを動かしたままでよい。
// - workspace.db は VACUUM INTO で写す（WAL の中身も含め、ある時点で揃ったもの。動いているサーバーの書き込みを止めない）。
//   読み取り専用で開くので、動いている db には何も書かない
// - db を写してから、ほかのファイルを読む。Asset はハッシュの名前で書き換えず、消すのは 30 日どこからも参照されなかったものだけ
//   （assetGc.ts）なので、db が指している Asset は入る（db より新しい Asset が余分に入ることはある）
// - .md / .py などのファイルは、一時ファイルに書いてから名前を変えて置かれる（files.ts）ので、書きかけを読むことはない。
//   書きかけの一時ファイル（.tmp、. で始まる名前）は入れない
// - 作り直せるもの・復元に要らないものは入れない：texmf（LuaTeX のキャッシュ）、v1 のスライドのキャッシュ、
//   移行のときの写し（*.bak）、snapshots・backups、db の -wal / -shm、PDF のページの画像（<ハッシュ>.preview-v*。サーバーが作り直す）。
//   取り込んだ元の .ricbackup（imports）は大きいので、imports: true のときだけ入れる
// - assets: false にすると Asset（.canvcode/assets）を入れず、名前の一覧だけを入れる。Asset は書き換わらないので、
//   別に（rclone copy などで）増えた分だけ送っておき、復元するときにそのフォルダを渡す
// - blobsDir を渡すと、PDF・画像などの種類のファイルと 1 MiB 以上のファイル（backupBlobs.ts の isBlobFile）をアーカイブに入れず、
//   パス・中身の SHA-256・大きさ・更新時刻だけを manifest の blobFiles に書く。中身は blobsDir に、ハッシュを名前にして 1 回だけ置く
//   （MAI-101。定期バックアップで、変わらない PDF が毎回アーカイブに入るのをやめる）。復元するときに、そのフォルダを渡す。
//   workspace.db の写しは毎回変わるので、アーカイブに入れる。渡さなければ、今までどおり 1 つの .tar.gz で完結する
// - 書き終えるまでは .partial の名前で置き、書き終えてから名前を変える（アップロードの道具が書きかけを拾わないように）

export const BACKUP_MANIFEST = 'canvcode-backup.json'
// 1：最初の形。2：blobFiles に、中身を別に置いたファイルがある（MAI-101。古い CanvCode が、中身のないファイルに気づかずに
// 戻さないよう上げる）。中身を別に置いていないバックアップは、古い CanvCode でも戻せるよう 1 のままにする
const FORMAT = 2
export const BACKUP_NAME_PATTERN = /^canvcode-backup-.+\.tar\.gz$/
const NAME_PATTERN = BACKUP_NAME_PATTERN

// .canvcode の中で入れないもの（キャッシュ・写し・db の本体（写しを別に入れる）・定期バックアップの状態（backupSync.ts）・
// アーカイブの外に置いた中身（backup-blobs。入れると、置くたびに指紋が変わって毎回アーカイブができる））
const EXCLUDED_DATA = new Set([
  'workspace.db',
  'workspace.db-wal',
  'workspace.db-shm',
  'workspace.db-journal',
  'texmf',
  'snapshots',
  'backups',
  'slide-pages',
  'figures',
  'backup-status.json',
  'backup-sync.lock',
  'backup-blobs',
  // 画面から頼んだ Claude Code の会話の履歴（claude/store.ts）。動いているサーバーが書き続けるので、写すと揃わないことがある
  'claude.db',
  'claude.db-wal',
  'claude.db-shm',
  'claude.db-journal',
])

// バックアップの名前（canvcode-backup-2026-10-12T03-05-00-000Z.tar.gz）から、作った時刻（ミリ秒）を読む。読めなければ null
export function backupTime(name: string): number | null {
  const match = /^canvcode-backup-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.tar\.gz$/.exec(name)
  if (!match) return null
  const time = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`)
  return Number.isNaN(time) ? null : time
}

// 前のバックアップから変わったかを見るための指紋。db の全テーブルの行と、バックアップに入るファイル（Asset も含む）の
// 名前・大きさ・更新時刻から作る。db は読み取り専用で開くので、動いているサーバーの db には何も書かない
export async function fingerprintWorkspace(workspaceDir: string, outDir: string): Promise<{ rev: number; hash: string }> {
  const workspace = resolve(workspaceDir)
  const hash = createHash('sha256')
  let rev = 0
  const db = new DatabaseSync(join(workspace, '.canvcode', 'workspace.db'), { readOnly: true, timeout: 10_000 })
  try {
    rev = Number((db.prepare("SELECT value FROM meta WHERE key = 'rev'").get() as { value: string } | undefined)?.value ?? 0)
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((row) => row.name)
    for (const table of tables) {
      hash.update(`table ${table}\n`)
      for (const row of db.prepare(`SELECT * FROM "${table.replace(/"/g, '""')}" ORDER BY rowid`).iterate()) {
        hash.update(JSON.stringify(row, (_key, value: unknown) => (value instanceof Uint8Array ? Buffer.from(value).toString('base64') : typeof value === 'bigint' ? String(value) : value)))
        hash.update('\n')
      }
    }
  } finally {
    db.close()
  }
  hash.update('files\n')
  for (const file of await listWorkspace(workspace, [resolve(outDir)], true, false)) {
    const info = await stat(join(workspace, ...file.split('/'))).catch(() => null)
    if (info) hash.update(`${file}\t${info.size}\t${Math.round(info.mtimeMs)}\n`)
  }
  return { rev, hash: hash.digest('hex') }
}

export interface BackupManifest {
  app: 'canvcode'
  format: number
  createdAt: string
  // 写した db の変更番号・テーブルの版・ルートの Canvas
  rev: number
  schema: number
  rootCanvasId: string | null
  includesAssets: boolean
  includesImports: boolean
  // .canvcode/assets にあったファイルの名前（includesAssets が false のとき、復元でこの名前を探す）
  assetFiles: string[]
  // アーカイブに入れず、中身を別に置いたファイル（1 つでもあれば format は 2。分けていなければ空で、format 1 の古いものにはない）
  blobFiles: BlobFile[]
}

export interface BackupOptions {
  workspace: string
  // 置く場所（ワークスペースの中なら、そこはバックアップに入れない）
  outDir: string
  assets?: boolean
  imports?: boolean
  // 渡すと、PDF・画像などのファイルをアーカイブに入れず、中身をここに置く（backupBlobs.ts）
  blobsDir?: string
  // 置く場所に残す数（古いものから消す）。省けば消さない
  keep?: number
  now?: Date
}

export interface BackupResult {
  path: string
  manifest: BackupManifest
  // アーカイブに入れたファイルの数と大きさ（圧縮する前）
  files: number
  bytes: number
  // アーカイブの外に置いたファイルの数と大きさ、そのうちこの回に読んだ数、新しく置いた中身の数と大きさ
  blobs: { files: number; bytes: number; hashed: number; added: number; addedBytes: number }
  removed: string[]
}

export async function createBackup(options: BackupOptions): Promise<BackupResult> {
  const workspace = resolve(options.workspace)
  const dataDir = join(workspace, '.canvcode')
  const outDir = resolve(options.outDir)
  const includeAssets = options.assets ?? true
  const includeImports = options.imports ?? false
  const dbPath = join(dataDir, 'workspace.db')
  if (options.keep !== undefined && !(Number.isInteger(options.keep) && options.keep >= 1)) throw new Error('keep は 1 以上の整数にしてください')
  if (!(await exists(dbPath))) throw new Error(`workspace.db がありません: ${dbPath}`)
  await mkdir(outDir, { recursive: true })
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-')
  const path = join(outDir, `canvcode-backup-${stamp}.tar.gz`)
  const partial = `${path}.partial`
  const dbCopy = join(outDir, `.canvcode-backup-${stamp}-${process.pid}.db.tmp`)
  try {
    // 1. db を写す（ほかのファイルより先に）
    const db = snapshotDb(dbPath, dbCopy)
    // 2. ほかのファイルを集める
    const blobsDir = options.blobsDir !== undefined ? resolve(options.blobsDir) : null
    const listed = await listWorkspace(workspace, blobsDir ? [outDir, blobsDir] : [outDir], includeAssets, includeImports)
    // 3. アーカイブの外に出すファイルの中身を置く（manifest に書くので、アーカイブを書く前に）
    const files: string[] = []
    const blobFiles: BlobFile[] = []
    const store = blobsDir ? await BlobStore.open(blobsDir, (options.now ?? new Date()).getTime()) : null
    if (store) {
      for (const file of listed) {
        const abs = join(workspace, ...file.split('/'))
        const info = await stat(abs).catch(() => null)
        // 集めたあとで消えたもの（名前を変えた・ゴミ箱に移した）は飛ばす
        if (!info) continue
        if (!isBlobFile(file, info.size)) {
          files.push(file)
          continue
        }
        const blob = await store.put(file, abs)
        if (blob) blobFiles.push(blob)
      }
      await store.save()
    } else {
      files.push(...listed)
    }
    const assetFiles = includeAssets ? [] : (await readdir(join(dataDir, 'assets')).catch(() => [] as string[])).filter((name) => !isTemp(name) && !isPdfPreviewFile(name)).sort()
    if (includeAssets) for (const file of listed) if (file.startsWith('.canvcode/assets/')) assetFiles.push(file.slice('.canvcode/assets/'.length))
    const manifest: BackupManifest = {
      app: 'canvcode',
      format: blobFiles.length > 0 ? FORMAT : 1,
      createdAt: (options.now ?? new Date()).toISOString(),
      ...db,
      includesAssets: includeAssets,
      includesImports: includeImports,
      assetFiles,
      blobFiles,
    }
    let count = 0
    let bytes = 0
    async function* entries(): AsyncGenerator<TarEntry> {
      const now = Date.now()
      yield { path: BACKUP_MANIFEST, data: Buffer.from(JSON.stringify(manifest, null, 2)), mtime: now }
      const dbData = await readFile(dbCopy)
      count++
      bytes += dbData.length
      yield { path: '.canvcode/workspace.db', data: dbData, mtime: now }
      for (const file of files) {
        const abs = join(workspace, ...file.split('/'))
        // 集めたあとで消えたもの（名前を変えた・ゴミ箱に移した）は飛ばす
        const read = await readFile(abs).then(
          (data) => data,
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null
            throw error
          },
        )
        if (!read) continue
        const info = await stat(abs).catch(() => null)
        count++
        bytes += read.length
        yield { path: file, data: read, mtime: info?.mtimeMs ?? now }
      }
    }
    await pipeline(Readable.from(tarChunks(entries())), createGzip(), createWriteStream(partial))
    await rename(partial, path)
    const removed = options.keep !== undefined ? await pruneBackups(outDir, options.keep) : []
    const blobs = { files: blobFiles.length, bytes: blobFiles.reduce((sum, file) => sum + file.size, 0), hashed: store?.hashed ?? 0, added: store?.added ?? 0, addedBytes: store?.addedBytes ?? 0 }
    return { path, manifest, files: count, bytes, blobs, removed }
  } catch (error) {
    await rm(partial, { force: true })
    throw error
  } finally {
    await rm(dbCopy, { force: true })
  }
}

// 置く場所のバックアップを、新しいものから keep 個だけ残す（名前の日時の順）。消した場所を返す
export async function pruneBackups(outDir: string, keep: number): Promise<string[]> {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('keep は 1 以上の整数にしてください')
  const names = (await readdir(outDir)).filter((name) => NAME_PATTERN.test(name)).sort().reverse()
  const removed: string[] = []
  for (const name of names.slice(keep)) {
    await rm(join(outDir, name), { force: true })
    removed.push(join(outDir, name))
  }
  return removed
}

export interface RestoreOptions {
  archive: string
  // 復元先。ないか空のフォルダだけ（今のワークスペースを上書きしない）
  workspace: string
  // Asset を入れていないバックアップのとき、Asset のファイルを探すフォルダ
  assetsFrom?: string
  // PDF・画像などの中身を別に置いたバックアップ（manifest の blobFiles）のとき、中身（<sha256>）を探すフォルダ
  blobsFrom?: string
}

export interface RestoreResult {
  workspace: string
  manifest: BackupManifest
  files: number
}

export async function restoreBackup(options: RestoreOptions): Promise<RestoreResult> {
  const target = resolve(options.workspace)
  const targetInfo = await stat(target).catch(() => null)
  if (targetInfo && (!targetInfo.isDirectory() || (await readdir(target)).length > 0)) {
    throw new Error(`復元先が空ではありません: ${target}（今のワークスペースは上書きしません。別の場所か、空のフォルダを指定してください）`)
  }
  const staging = join(dirname(target), `.${basename(target)}.restoring-${process.pid}-${Date.now()}`)
  try {
    const written = await extractTar(createReadStream(resolve(options.archive)).pipe(createGunzip()), staging)
    const manifestPath = join(staging, BACKUP_MANIFEST)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8').catch(() => '{}')) as Partial<BackupManifest>
    if (manifest.app !== 'canvcode' || typeof manifest.format !== 'number') throw new Error('CanvCode のバックアップではありません（canvcode-backup.json がありません）')
    if (manifest.format > FORMAT) throw new Error(`このバックアップは新しい形式です（${manifest.format}）。CanvCode を更新してから復元してください`)
    // 外に置いたファイルを戻す（manifest を消す前に。同じ名前のファイルを blobFiles から作らせない）
    const blobs = await restoreBlobs(Array.isArray(manifest.blobFiles) ? manifest.blobFiles : [], options.blobsFrom, staging)
    await rm(manifestPath)
    if (!manifest.includesAssets) await restoreAssets(manifest.assetFiles ?? [], options.assetsFrom, join(staging, '.canvcode', 'assets'))
    checkDb(join(staging, '.canvcode', 'workspace.db'))
    if (targetInfo) await rmdir(target)
    await mkdir(dirname(target), { recursive: true })
    await rename(staging, target)
    return { workspace: target, manifest: manifest as BackupManifest, files: written.length - 1 + blobs }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

// アーカイブの manifest だけを読む（アーカイブの最初のファイル。全体は展開しない）
export async function readBackupManifest(archive: string): Promise<BackupManifest> {
  const file = createReadStream(resolve(archive))
  const gunzip = createGunzip()
  // pipe は読む側の失敗を伝えないので、ここで伝える（伝えないと、ファイルがないときに待ち続ける）
  file.on('error', (error) => gunzip.destroy(error))
  file.pipe(gunzip)
  try {
    const first = await readFirstTarFile(gunzip, 256 * 1024 * 1024)
    const manifest = first?.path === BACKUP_MANIFEST ? (JSON.parse(first.data.toString('utf8')) as Partial<BackupManifest>) : null
    if (manifest?.app !== 'canvcode' || typeof manifest.format !== 'number') throw new Error(`CanvCode のバックアップではありません（canvcode-backup.json がありません）: ${archive}`)
    return manifest as BackupManifest
  } finally {
    file.destroy()
    gunzip.destroy()
  }
}

// 動いているサーバーの db を、読み取り専用で開いて写す。写しの変更番号などを返す
function snapshotDb(source: string, target: string): Pick<BackupManifest, 'rev' | 'schema' | 'rootCanvasId'> {
  const live = new DatabaseSync(source, { readOnly: true, timeout: 10_000 })
  try {
    live.prepare('VACUUM INTO ?').run(target)
  } finally {
    live.close()
  }
  const copy = new DatabaseSync(target, { readOnly: true })
  try {
    const meta = (key: string) => (copy.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null
    return { rev: Number(meta('rev') ?? 0), schema: Number(meta('schema') ?? 1), rootCanvasId: meta('root') }
  } finally {
    copy.close()
  }
}

function checkDb(path: string): void {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]
    if (rows.length !== 1 || rows[0].integrity_check !== 'ok') throw new Error(`復元した workspace.db が壊れています: ${rows.map((r) => r.integrity_check).join('; ')}`)
    if (!db.prepare("SELECT value FROM meta WHERE key = 'root'").get()) throw new Error('復元した workspace.db にルートの Canvas がありません')
  } finally {
    db.close()
  }
}

async function restoreAssets(names: string[], from: string | undefined, dir: string): Promise<void> {
  if (names.length === 0) return
  if (!from) throw new Error(`このバックアップには Asset（${names.length} 個）が入っていません。Asset を置いたフォルダを指定してください（--assets <フォルダ>）`)
  const missing: string[] = []
  await mkdir(dir, { recursive: true })
  for (const name of names) {
    if (name.includes('/') || name.includes('\\') || name.startsWith('.')) continue
    try {
      await copyFile(join(resolve(from), name), join(dir, name))
    } catch {
      missing.push(name)
    }
  }
  if (missing.length > 0) throw new Error(`Asset が見つかりません（${missing.length} 個）: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}`)
}

// バックアップに入れるファイル（ワークスペースからの相対パス。区切りは /）
// skip は、中を見ないフォルダ（バックアップを置く場所。ワークスペースの中にあるとき）
async function listWorkspace(workspace: string, skip: string[], assets: boolean, imports: boolean): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = join(dir, entry.name)
      if (skip.includes(full)) continue
      const rel = relative(workspace, full).split(sep).join('/')
      if (!keep(rel, entry.name, assets, imports)) continue
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) out.push(rel)
    }
  }
  await walk(workspace)
  return out
}

function keep(rel: string, name: string, assets: boolean, imports: boolean): boolean {
  if (isTemp(name)) return false
  const parts = rel.split('/')
  if (parts[0] !== '.canvcode') {
    // FileStore が扱わないもの（. で始まる名前・node_modules）は入れない
    return !name.startsWith('.') && name !== 'node_modules'
  }
  if (parts.length === 1) return true
  const top = parts[1]
  if (EXCLUDED_DATA.has(top) || top.endsWith('.bak')) return false
  if (top === 'assets' && (!assets || isPdfPreviewFile(name))) return false
  if (top === 'imports' && !imports) return false
  return true
}

// 書きかけの一時ファイル（files.ts は「.<名前>….tmp」、ほかは「<名前>.<pid>.<時刻>….tmp」、書き出し中の .partial）
export function isTemp(name: string): boolean {
  return name.endsWith('.tmp') || name.endsWith('.partial')
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}
