import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { backupTime, BACKUP_NAME_PATTERN, createBackup, fingerprintWorkspace, isTemp } from './backup.ts'
import { isPdfPreviewFile } from './pdfPreview.ts'
import { writeViaTemp } from './writeAtomic.ts'

// 定期バックアップと Google Drive へのアップロード（npm run backup:sync。systemd のタイマーから 5 分ごとに呼ぶ）。
// 1. 前のバックアップから変わっていれば、Asset を入れないバックアップ（--no-assets）を手元に作る（手元には keep 個まで）。
//    変わっていなければ作らない（指紋は backup.ts の fingerprintWorkspace）
// 2. rclone about で Drive につながるか確かめる（つながらなければ、ここで終えて状態ファイルに書く）
// 3. 手元と Drive のアーカイブの一覧から、Drive に残すものを決め（planArchives）、まだ送っていないものを rclone copy で送り、
//    残さないものを Drive から消す。前に送れなかった分は、変わっていなくても毎回ここで送り直す
// 4. Asset（.canvcode/assets）を、Drive の assets に追加だけで写す（消さない）。前に写したときから変わっていなければ写さない。
//    PDF のページの画像（<ハッシュ>.preview-v*）はサーバーが作り直せるので写さない
// 5. 結果を .canvcode/backup-status.json に書く。サーバーがそれを読んで、画面に Drive の未接続などを出す（backupStatus.ts）
// rclone はテストで差し替えられるように、引数を受け取る関数（RcloneRunner）で呼ぶ

export const BACKUP_STATUS_FILE = 'backup-status.json'
const LOCK_FILE = 'backup-sync.lock'
export const DEFAULT_REMOTE = 'gdrive:CanvCode-backup'
export const DEFAULT_KEEP = 96

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
// Drive に残すもの：2 日以内は 1 時間に 1 個、30 日以内は 1 日に 1 個（どちらも、その間でいちばん新しいもの）。
// それより古いものは消す。いちばん新しいものは、古くても必ず残す（変わらない日が続くと新しく作らないため）
const HOURLY_WINDOW = 2 * DAY
const DAILY_WINDOW = 30 * DAY

export type RcloneRunner = (args: string[], options: { timeoutMs: number }) => Promise<string>

export interface BackupStatusFile {
  version: 1
  // 最後に動いた時刻と、最後にすべて（バックアップ・Drive への送信）うまくいった時刻
  lastAttemptAt: string
  lastSuccessAt: string | null
  // 最後に動いたときの失敗（うまくいけば null）
  lastError: { step: 'archive' | 'drive' | 'upload' | 'assets' | 'lock'; message: string } | null
  drive: { ok: boolean; checkedAt: string; lastOkAt: string | null; error: string | null }
  // 最後に作ったアーカイブ（変わったかどうかを、この指紋と比べる）
  archive: { name: string; createdAt: string; rev: number; fingerprint: string } | null
  // 最後に Drive へ写し終えた Asset の指紋
  assetsFingerprint: string | null
  lastRun: { archived: boolean; uploaded: string[]; deletedRemote: string[]; removedLocal: string[] }
}

export interface BackupSyncOptions {
  workspace: string
  // 手元のアーカイブを置く場所（既定は <ワークスペース>/.canvcode/backups）
  outDir?: string
  remote?: string
  keep?: number
  rclone: RcloneRunner
  now?: () => Date
  log?: (message: string) => void
}

export interface BackupSyncResult {
  ok: boolean
  status: BackupStatusFile
}

export function statusPath(dataDir: string): string {
  return join(dataDir, BACKUP_STATUS_FILE)
}

export async function readBackupStatusFile(dataDir: string): Promise<BackupStatusFile | null> {
  try {
    const parsed = JSON.parse(await readFile(statusPath(dataDir), 'utf8')) as BackupStatusFile
    return parsed && parsed.version === 1 ? parsed : null
  } catch {
    return null
  }
}

export async function runBackupSync(options: BackupSyncOptions): Promise<BackupSyncResult> {
  const workspace = resolve(options.workspace)
  const dataDir = join(workspace, '.canvcode')
  const outDir = resolve(options.outDir ?? join(dataDir, 'backups'))
  const remote = (options.remote ?? DEFAULT_REMOTE).replace(/\/+$/, '')
  const keep = options.keep ?? DEFAULT_KEEP
  const now = options.now ?? (() => new Date())
  const log = options.log ?? (() => {})
  const rclone = options.rclone
  const previous = await readBackupStatusFile(dataDir)
  const startedAt = now()
  const status: BackupStatusFile = {
    version: 1,
    lastAttemptAt: startedAt.toISOString(),
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    lastError: null,
    drive: previous?.drive ?? { ok: false, checkedAt: startedAt.toISOString(), lastOkAt: null, error: null },
    archive: previous?.archive ?? null,
    assetsFingerprint: previous?.assetsFingerprint ?? null,
    lastRun: { archived: false, uploaded: [], deletedRemote: [], removedLocal: [] },
  }
  const fail = (step: NonNullable<BackupStatusFile['lastError']>['step'], error: unknown) => {
    const message = errorMessage(error)
    log(`失敗しました（${step}）：${message}`)
    // 最初の失敗を残す（Drive の失敗はあとの段で上書きしない）
    status.lastError ??= { step, message }
  }

  const unlock = await lock(join(dataDir, LOCK_FILE))
  if (!unlock) {
    // ほかの backup:sync が動いている。状態ファイルはそちらが書くので、ここでは書かない
    log('ほかの backup:sync が動いているので、何もしません')
    return { ok: true, status: previous ?? status }
  }
  try {
    // 1. 変わっていれば手元にアーカイブを作る
    try {
      const fingerprint = await fingerprintWorkspace(workspace, outDir)
      const last = status.archive
      const lastExists = last ? await exists(join(outDir, last.name)) : false
      if (last && lastExists && last.fingerprint === fingerprint.hash) {
        log(`変わっていないので、アーカイブは作りません（変更番号 ${fingerprint.rev}、前回 ${last.name}）`)
      } else {
        const created = await createBackup({ workspace, outDir, assets: false, keep, now: now() })
        const name = created.path.slice(outDir.length + 1)
        status.archive = { name, createdAt: created.manifest.createdAt, rev: created.manifest.rev, fingerprint: fingerprint.hash }
        status.lastRun.archived = true
        status.lastRun.removedLocal = created.removed
        log(`アーカイブを作りました：${created.path}（変更番号 ${created.manifest.rev}）`)
        for (const path of created.removed) log(`・手元の古いアーカイブを消しました：${path}`)
      }
    } catch (error) {
      fail('archive', error)
    }

    // 2. Drive につながるか確かめる
    const checkedAt = now().toISOString()
    try {
      await rclone(['about', remoteRoot(remote)], { timeoutMs: 90_000 })
      status.drive = { ok: true, checkedAt, lastOkAt: checkedAt, error: null }
    } catch (error) {
      status.drive = { ok: false, checkedAt, lastOkAt: status.drive.lastOkAt, error: errorMessage(error) }
      fail('drive', error)
    }

    if (status.drive.ok) {
      // 3. アーカイブを送り、Drive の古いものを間引く
      try {
        const local = (await readdir(outDir).catch(() => [] as string[])).filter((name) => BACKUP_NAME_PATTERN.test(name))
        const remoteNames = await listRemote(rclone, `${remote}/archives`)
        const plan = planArchives(local, remoteNames, now().getTime())
        if (plan.upload.length > 0) {
          const list = join(outDir, `.upload-${process.pid}-${Date.now()}.tmp`)
          await writeFile(list, plan.upload.map((name) => `${name}\n`).join(''))
          try {
            await rclone(['copy', outDir, `${remote}/archives`, '--files-from-raw', list, '--no-traverse'], { timeoutMs: 30 * 60_000 })
          } finally {
            await rm(list, { force: true })
          }
          status.lastRun.uploaded = plan.upload
          for (const name of plan.upload) log(`・Drive に送りました：${name}`)
        }
        for (const name of plan.remove) {
          await rclone(['deletefile', `${remote}/archives/${name}`, '--drive-use-trash=false'], { timeoutMs: 5 * 60_000 })
          status.lastRun.deletedRemote.push(name)
          log(`・Drive の古いアーカイブを消しました：${name}`)
        }
      } catch (error) {
        markDriveError(status, error)
        fail('upload', error)
      }

      // 4. Asset を追加だけで写す
      if (status.drive.ok) {
        try {
          const assetsDir = join(dataDir, 'assets')
          const fingerprint = await fingerprintAssets(assetsDir)
          if (fingerprint !== null && fingerprint !== status.assetsFingerprint) {
            await rclone(['copy', assetsDir, `${remote}/assets`, '--exclude', '*.tmp', '--exclude', '*.partial', '--exclude', '.*', '--exclude', '*.preview-v*'], { timeoutMs: 60 * 60_000 })
            status.assetsFingerprint = fingerprint
            log('Asset を Drive に写しました')
          }
        } catch (error) {
          markDriveError(status, error)
          fail('assets', error)
        }
      }
    }

    if (!status.lastError) status.lastSuccessAt = now().toISOString()
    await writeStatus(dataDir, status)
    return { ok: !status.lastError, status }
  } finally {
    await unlock()
  }
}

// Drive に残すものを決める。local / remote はアーカイブの名前。
// upload：手元にあって Drive になく、残すもの。remove：Drive にあって残さないもの（名前から時刻を読めないものは消さない）
export function planArchives(local: string[], remote: string[], now: number): { keep: string[]; upload: string[]; remove: string[] } {
  const all = [...new Set([...local, ...remote])]
    .map((name) => ({ name, time: backupTime(name) }))
    .filter((entry): entry is { name: string; time: number } => entry.time !== null)
    .sort((a, b) => b.time - a.time || (a.name < b.name ? 1 : -1))
  const keep = new Set<string>()
  const hours = new Set<number>()
  const days = new Set<number>()
  for (const [index, { name, time }] of all.entries()) {
    const age = now - time
    // 新しい順に見るので、その時間・その日に最初に出会ったものが、その間でいちばん新しい
    if (index === 0) keep.add(name)
    if (age <= HOURLY_WINDOW) {
      const hour = Math.floor(time / HOUR)
      if (!hours.has(hour)) keep.add(name)
      hours.add(hour)
    }
    if (age <= DAILY_WINDOW) {
      const day = Math.floor(time / DAY)
      if (!days.has(day)) keep.add(name)
      days.add(day)
    }
  }
  const remoteSet = new Set(remote)
  const upload = local.filter((name) => keep.has(name) && !remoteSet.has(name)).sort()
  const remove = remote.filter((name) => backupTime(name) !== null && !keep.has(name)).sort()
  return { keep: [...keep].sort(), upload, remove }
}

// rclone を実際に呼ぶ（bin は rclone の場所）。失敗したら、rclone のエラー出力の最後の数行を投げる
export function execRclone(bin = 'rclone', flags: string[] = ['--contimeout', '15s', '--timeout', '120s', '--retries', '2', '--low-level-retries', '3']): RcloneRunner {
  return (args, { timeoutMs }) =>
    new Promise((resolvePromise, reject) => {
      execFile(bin, [...args, ...flags], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (!error) {
          resolvePromise(stdout)
          return
        }
        const lines = String(stderr)
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
        const killed = (error as { killed?: boolean }).killed
        const detail = killed ? `${Math.round(timeoutMs / 1000)} 秒で終わらなかったので止めました` : lines.slice(-3).join(' / ') || error.message
        reject(new Error(`rclone ${args[0]}: ${detail}`))
      })
    })
}

function remoteRoot(remote: string): string {
  const colon = remote.indexOf(':')
  return colon >= 0 ? remote.slice(0, colon + 1) : remote
}

async function listRemote(rclone: RcloneRunner, path: string): Promise<string[]> {
  try {
    const out = await rclone(['lsf', path, '--files-only'], { timeoutMs: 5 * 60_000 })
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((name) => BACKUP_NAME_PATTERN.test(name))
  } catch (error) {
    // 初めてで、まだフォルダがない
    if (/directory not found/i.test(errorMessage(error))) return []
    throw error
  }
}

// Asset の名前と大きさの指紋（Asset のフォルダがなければ null）
async function fingerprintAssets(dir: string): Promise<string | null> {
  const names = await readdir(dir).catch(() => null)
  if (!names) return null
  const hash = createHash('sha256')
  for (const name of names.filter((name) => !isTemp(name) && !name.startsWith('.') && !isPdfPreviewFile(name)).sort()) {
    const info = await stat(join(dir, name)).catch(() => null)
    if (info?.isFile()) hash.update(`${name}\t${info.size}\t${Math.round(info.mtimeMs)}\n`)
  }
  return hash.digest('hex')
}

function markDriveError(status: BackupStatusFile, error: unknown): void {
  status.drive = { ...status.drive, ok: false, error: errorMessage(error) }
}

async function writeStatus(dataDir: string, status: BackupStatusFile): Promise<void> {
  const path = statusPath(dataDir)
  await writeViaTemp(`${path}.${process.pid}.${Date.now()}.tmp`, path, `${JSON.stringify(status, null, 2)}\n`)
}

// 同じワークスペースで backup:sync が重ならないようにする。取れなければ null。
// 前の backup:sync が落ちて残った鍵（そのプロセスがもういない、または 2 時間より古い）は取り直す
async function lock(path: string): Promise<(() => Promise<void>) | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx')
      await handle.writeFile(String(process.pid))
      await handle.close()
      return () => rm(path, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const info = await stat(path).catch(() => null)
      const pid = Number(await readFile(path, 'utf8').catch(() => ''))
      const stale = !info || Date.now() - info.mtimeMs > 2 * HOUR || !Number.isInteger(pid) || pid <= 0 || !alive(pid)
      if (!stale) return null
      await rm(path, { force: true })
    }
  }
  return null
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // 認証が切れたとき（トークンの期限切れ・取り消し）は、直し方を添える
  if (/token|oauth|invalid_grant|unauthori[sz]ed/i.test(message) && !message.includes('rclone config reconnect')) {
    return `${message}（認証が切れているかもしれません。rclone config reconnect gdrive: で認証し直してください）`
  }
  return message
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}
