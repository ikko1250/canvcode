import { createReadStream } from 'node:fs'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isPdfPreviewFile } from './pdfPreview.ts'
import { forEachTextInDb, type RecordStore } from './records.ts'
import { writeViaTemp } from './writeAtomic.ts'

// どこからも参照されなくなった Asset の片付け。参照されなくなってから ASSET_GRACE_MS（30 日）経った Asset を、
// 原本・縮小版・<ハッシュ>.json・pages.json・.txt と一緒に消す。起動したときと、そのあと 1 時間ごとに走らせる（storageCleanup.ts）。
//
// 誤って消すのがいちばん困るので、参照は形を決めつけずに広く探す：Asset のハッシュ（64 桁の 16 進数。asset:<ハッシュ> の後ろ半分）が
// 次のどこかに文字列として現れれば「参照されている」とみなす（ノードの型や Markdown の書き方が増えても漏れない）。
// - workspace.db のすべての表のすべての行（ノード・File・引用の出典・ゴミ箱の中のもの〈レコードが残っている〉・
//   ゴミ箱のまとまりの持ち主の写し・AI の編集の記録（agent_ops。取り消したものも）・ref など）
// - 移行・片付けの前の写し（workspace.db.before-*.bak）と npm run snapshot の写し（snapshots/*.db）。戻したときに画像が欠けないように
// - ワークスペースのフォルダのファイル（.md・.py・.slide.md・.slide.json など。.canvcode・.git・node_modules と、
//   中に文字列として書けない画像・動画・圧縮ファイルなどを除く）
// - .canvcode/deleted/（ゴミ箱から完全に削除した .md / .py。手で戻せる）、.canvcode/files.json、.canvcode/ref-images/*.json
// 「参照されなくなった時刻」は .canvcode/asset-gc.json に覚える（初めて参照されていないと分かった時刻。また参照されたら忘れる）。
// - どれか 1 つでも読めなければ（ないものは除く）、その回は何も消さない
// - 参照されていなくても、ファイルが ASSET_GRACE_MS 以内に書かれた Asset（受け取ったばかり・縮小版を受け取った）は消さない
// - 消す直前に workspace.db が変わっていたら、もう一度読み直して確かめる
// - Canvas のサムネイル（thumbnails/）は Canvas ごとのもので、Asset から作ったものではないので、ここでは扱わない

const DAY_MS = 24 * 60 * 60 * 1000
export const ASSET_GRACE_MS = 30 * DAY_MS
export const ASSET_GC_STATE = 'asset-gc.json'
// 書きかけの一時ファイル（<名前>.<pid>.<時刻>….tmp）は、これより新しければ触れない
const TEMP_GRACE_MS = 60 * 60 * 1000

const ASSET_FILE = /^([0-9a-f]{64})\./
const HEX_RUN = /[0-9a-fA-F]{64,}/g
// 中に参照を文字列として書けないファイル（画像・音声・動画・PDF・フォント・圧縮ファイル）。読むと時間がかかるだけなので読まない
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.tif', '.tiff', '.heic',
  '.mp3', '.wav', '.ogg', '.flac', '.m4a', '.mp4', '.mov', '.webm', '.mkv', '.avi',
  '.pdf', '.woff', '.woff2', '.ttf', '.otf',
  '.gz', '.tgz', '.zip', '.ricbackup', '.7z', '.xz', '.bz2', '.zst', '.rar',
])
// ワークスペースのフォルダで、中を見ないフォルダ
const SKIPPED_DIRS = new Set(['.git', 'node_modules'])

interface GcState {
  version: 1
  // ハッシュ → 参照されていないと初めて分かった時刻（ミリ秒）
  unreferencedSince: Record<string, number>
}

export interface AssetSweepOptions {
  workspace: string
  dataDir: string
  records: RecordStore
  now?: number
  graceMs?: number
}

export interface AssetSweepResult {
  // Asset の数・参照されているもの・参照されていないが待っているもの
  assets: number
  referenced: number
  waiting: number
  // 消した Asset のハッシュ
  removed: string[]
}

// テキストの中から、探している Asset のハッシュを見つける。64 桁より長い 16 進数の並びは、その中に含まれていれば見つけたことにする
export class HashFinder {
  readonly found = new Set<string>()
  private readonly wanted: Set<string>

  constructor(wanted: Iterable<string>) {
    this.wanted = new Set(wanted)
  }

  get done(): boolean {
    return this.found.size === this.wanted.size
  }

  scan(text: string): void {
    if (this.done) return
    for (const match of text.matchAll(HEX_RUN)) {
      const run = match[0].toLowerCase()
      if (run.length === 64) {
        if (this.wanted.has(run)) this.found.add(run)
      } else {
        for (const hash of this.wanted) if (!this.found.has(hash) && run.includes(hash)) this.found.add(hash)
      }
    }
  }
}

export async function sweepUnusedAssets(options: AssetSweepOptions): Promise<AssetSweepResult> {
  const { workspace, dataDir, records } = options
  const now = options.now ?? Date.now()
  const grace = options.graceMs ?? ASSET_GRACE_MS
  const assetsDir = join(dataDir, 'assets')
  const statePath = join(dataDir, ASSET_GC_STATE)

  // 1. Asset ごとのファイル
  const names = await readdirOrEmpty(assetsDir)
  const groups = new Map<string, string[]>()
  for (const name of names) {
    const match = ASSET_FILE.exec(name)
    if (!match) continue
    const list = groups.get(match[1]) ?? []
    list.push(name)
    groups.set(match[1], list)
  }
  // 書きかけの一時ファイルしかないもの（受け取っている途中）は数えない
  const hashes = [...groups].filter(([, files]) => files.some((name) => !isTemp(name))).map(([hash]) => hash)
  const result: AssetSweepResult = { assets: hashes.length, referenced: 0, waiting: 0, removed: [] }

  // 2. 参照を探す。時間のかかるファイルを先に読み、workspace.db は最後に読む（消す直前の状態に近いように）
  const finder = new HashFinder(hashes)
  if (hashes.length > 0) {
    await scanWorkspaceFiles(workspace, finder)
    await scanDirectory(join(dataDir, 'deleted'), finder)
    await scanFileIfExists(join(dataDir, 'files.json'), finder)
    for (const name of await readdirOrEmpty(join(dataDir, 'ref-images'))) if (name.endsWith('.json')) await scanFileIfExists(join(dataDir, 'ref-images', name), finder)
    for (const path of await databaseCopies(dataDir)) scanDatabaseCopy(path, finder)
  }
  let scannedRev = records.rev
  if (hashes.length > 0) scanLiveDatabase(records, finder)

  // 3. 参照されなくなった時刻を更新し、ASSET_GRACE_MS 経ったものを選ぶ
  const state = await readState(statePath)
  const next: GcState = { version: 1, unreferencedSince: {} }
  const expired: string[] = []
  for (const hash of hashes) {
    if (finder.found.has(hash)) continue
    const saved = state.unreferencedSince[hash]
    // 時計が戻ったときは、今から数え直す
    const since = typeof saved === 'number' && Number.isFinite(saved) && saved <= now ? saved : now
    next.unreferencedSince[hash] = since
    if (now - since >= grace) expired.push(hash)
  }

  // 4. 消す（最近書かれたファイルがあるものは除く）
  for (const hash of expired) {
    const files = groups.get(hash) ?? []
    // ファイルの時刻は実際の時計で比べる
    if (!(await allOlderThan(assetsDir, files, Date.now() - grace))) continue
    // 読んだあとで workspace.db が変わっていたら（ノードが置かれた、など）、読み直す
    if (records.rev !== scannedRev) {
      scannedRev = records.rev
      const recheck = new HashFinder(expired.filter((h) => !result.removed.includes(h)))
      scanLiveDatabase(records, recheck)
      for (const found of recheck.found) {
        finder.found.add(found)
        delete next.unreferencedSince[found]
      }
      if (recheck.found.has(hash)) continue
    }
    try {
      await removeAsset(assetsDir, hash, files)
      result.removed.push(hash)
      delete next.unreferencedSince[hash]
    } catch (error) {
      console.error('failed to remove an unused asset', hash, error)
    }
  }
  result.referenced = finder.found.size
  result.waiting = Object.keys(next.unreferencedSince).length
  await writeViaTemp(`${statePath}.${process.pid}.${Date.now()}.tmp`, statePath, JSON.stringify(next))
  return result
}

// ---- 参照を探す ----

// ワークスペースのフォルダのファイル（.canvcode・.git・node_modules・中に文字列を書けないファイルを除く。シンボリックリンクはたどらない）
async function scanWorkspaceFiles(workspace: string, finder: HashFinder): Promise<void> {
  const walk = async (dir: string, top: boolean): Promise<void> => {
    if (finder.done) return
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (top && entry.name === '.canvcode') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await walk(path, false)
      } else if (entry.isFile() && !BINARY_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        await scanFileIfExists(path, finder)
      }
    }
  }
  await walk(workspace, true)
}

// フォルダの中のファイル（サブフォルダも。なければ何もしない）
async function scanDirectory(dir: string, finder: HashFinder): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await scanDirectory(path, finder)
    else if (entry.isFile()) await scanFileIfExists(path, finder)
  }
}

// ファイルを少しずつ読んで探す（大きなファイルもメモリに載せない）。16 進数の文字は 1 バイトなので latin1 で読む。
// かたまりの境目をまたぐハッシュを見落とさないよう、前のかたまりの終わりの 63 文字を次に足す。読む前に消えたファイルは飛ばす
async function scanFileIfExists(path: string, finder: HashFinder): Promise<void> {
  if (finder.done) return
  let carry = ''
  try {
    for await (const chunk of createReadStream(path, { encoding: 'latin1', highWaterMark: 1024 * 1024 })) {
      const text = carry + (chunk as string)
      finder.scan(text)
      if (finder.done) return
      carry = text.slice(-63)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

// 移行・片付けの前の写しと、npm run snapshot の写し
async function databaseCopies(dataDir: string): Promise<string[]> {
  const out: string[] = []
  for (const name of await readdirOrEmpty(dataDir)) if (/^workspace\.db\.before-.+\.bak$/.test(name)) out.push(join(dataDir, name))
  for (const name of await readdirOrEmpty(join(dataDir, 'snapshots'))) if (name.endsWith('.db')) out.push(join(dataDir, 'snapshots', name))
  return out
}

function scanDatabaseCopy(path: string, finder: HashFinder): void {
  if (finder.done) return
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    forEachTextInDb(db, (text) => finder.scan(text))
  } finally {
    db.close()
  }
}

function scanLiveDatabase(records: RecordStore, finder: HashFinder): void {
  // done でも読む（読めることを確かめる）
  const { records: rows } = records.forEachText((text) => finder.scan(text))
  // ルートの Canvas は必ずある。1 行も読めなければ、何かがおかしいので消さない
  if (rows === 0) throw new Error('workspace.db has no records')
}

// ---- 状態と削除 ----

async function readState(path: string): Promise<GcState> {
  try {
    const saved = JSON.parse(await readFile(path, 'utf8')) as Partial<GcState>
    if (saved.version === 1 && saved.unreferencedSince && typeof saved.unreferencedSince === 'object') return { version: 1, unreferencedSince: saved.unreferencedSince }
  } catch {
    // ない・壊れている：今から数え直す（消すのが遅れるだけ）
  }
  return { version: 1, unreferencedSince: {} }
}

async function allOlderThan(dir: string, files: string[], cutoff: number): Promise<boolean> {
  for (const name of files) {
    // PDF のページの画像は、参照されていなくても起動したときなどに作られる（作り直せる）ので、時刻を見ない
    if (isTemp(name) || isPdfPreviewFile(name)) continue
    const info = await stat(join(dir, name)).catch(() => null)
    if (info && info.mtimeMs > cutoff) return false
  }
  return true
}

// <ハッシュ>.json を先に消す（一覧と配信からすぐに消える）。書きかけの一時ファイルは、古いものだけ消す
async function removeAsset(dir: string, hash: string, files: string[]): Promise<void> {
  const meta = `${hash}.json`
  const ordered = [...files.filter((name) => name === meta), ...files.filter((name) => name !== meta)]
  for (const name of ordered) {
    if (isTemp(name)) {
      const info = await stat(join(dir, name)).catch(() => null)
      if (!info || Date.now() - info.mtimeMs < TEMP_GRACE_MS) continue
    }
    await rm(join(dir, name), { force: true })
  }
}

function isTemp(name: string): boolean {
  return name.endsWith('.tmp')
}

async function readdirOrEmpty(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
