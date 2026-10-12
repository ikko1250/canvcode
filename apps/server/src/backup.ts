import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, rmdir, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import { extractTar, tarChunks, type TarEntry } from './tar.ts'

// ワークスペースのバックアップと復元（MAI-13 の「8. バックアップと書き出し」）。
// 1 つの .tar.gz に、ワークスペースを元に戻すのに要るものをまとめる。サーバーを動かしたままでよい。
// - workspace.db は VACUUM INTO で写す（WAL の中身も含め、ある時点で揃ったもの。動いているサーバーの書き込みを止めない）。
//   読み取り専用で開くので、動いている db には何も書かない
// - db を写してから、ほかのファイルを読む。Asset はハッシュの名前で書き換えも削除もしないので、
//   db が指している Asset は必ず入る（db より新しい Asset が余分に入ることはある）
// - .md / .py などのファイルは、一時ファイルに書いてから名前を変えて置かれる（files.ts）ので、書きかけを読むことはない。
//   書きかけの一時ファイル（.tmp、. で始まる名前）は入れない
// - 作り直せるもの・復元に要らないものは入れない：texmf（LuaTeX のキャッシュ）、v1 のスライドのキャッシュ、
//   移行のときの写し（*.bak）、snapshots・backups、db の -wal / -shm。
//   取り込んだ元の .ricbackup（imports）は大きいので、imports: true のときだけ入れる
// - assets: false にすると Asset（.canvcode/assets）を入れず、名前の一覧だけを入れる。Asset は書き換わらないので、
//   別に（rclone copy などで）増えた分だけ送っておき、復元するときにそのフォルダを渡す
// - 書き終えるまでは .partial の名前で置き、書き終えてから名前を変える（アップロードの道具が書きかけを拾わないように）

export const BACKUP_MANIFEST = 'canvcode-backup.json'
const FORMAT = 1
export const BACKUP_NAME_PATTERN = /^canvcode-backup-.+\.tar\.gz$/
const NAME_PATTERN = BACKUP_NAME_PATTERN

// .canvcode の中で入れないもの（キャッシュ・写し・db の本体（写しを別に入れる）・定期バックアップの状態（backupSync.ts））
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
  for (const file of await listWorkspace(workspace, resolve(outDir), true, false)) {
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
}

export interface BackupOptions {
  workspace: string
  // 置く場所（ワークスペースの中なら、そこはバックアップに入れない）
  outDir: string
  assets?: boolean
  imports?: boolean
  // 置く場所に残す数（古いものから消す）。省けば消さない
  keep?: number
  now?: Date
}

export interface BackupResult {
  path: string
  manifest: BackupManifest
  files: number
  bytes: number
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
    const files = await listWorkspace(workspace, outDir, includeAssets, includeImports)
    const assetFiles = includeAssets ? [] : (await readdir(join(dataDir, 'assets')).catch(() => [] as string[])).filter((name) => !isTemp(name)).sort()
    if (includeAssets) for (const file of files) if (file.startsWith('.canvcode/assets/')) assetFiles.push(file.slice('.canvcode/assets/'.length))
    const manifest: BackupManifest = {
      app: 'canvcode',
      format: FORMAT,
      createdAt: (options.now ?? new Date()).toISOString(),
      ...db,
      includesAssets: includeAssets,
      includesImports: includeImports,
      assetFiles,
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
    return { path, manifest, files: count, bytes, removed }
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
    await rm(manifestPath)
    if (!manifest.includesAssets) await restoreAssets(manifest.assetFiles ?? [], options.assetsFrom, join(staging, '.canvcode', 'assets'))
    checkDb(join(staging, '.canvcode', 'workspace.db'))
    if (targetInfo) await rmdir(target)
    await mkdir(dirname(target), { recursive: true })
    await rename(staging, target)
    return { workspace: target, manifest: manifest as BackupManifest, files: written.length - 1 }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
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
async function listWorkspace(workspace: string, outDir: string, assets: boolean, imports: boolean): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = join(dir, entry.name)
      if (full === outDir) continue
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
  if (top === 'assets' && !assets) return false
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
