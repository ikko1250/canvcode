import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { restoreBackup } from './backup.ts'
import { describeBackupStatus, STALE_AFTER_MS } from './backupStatus.ts'
import { execRclone, planArchives, readBackupStatusFile, runBackupSync, type RcloneRunner } from './backupSync.ts'
import { RecordStore } from './records.ts'

// 定期バックアップと Drive へのアップロード。rclone は、一時フォルダを Drive に見立てた偽物に差し替える

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'canvcode-backup-sync-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const node = (id: string, parentId: string) => ({ typeName: 'node', id, type: 'geo', parentId, x: 0, y: 0, props: {} })
const HASH = 'b'.repeat(64)

function write(path: string, data: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, data)
}

function workspace(): { dir: string; store: RecordStore } {
  const dir = join(tempDir(), 'ws')
  const store = new RecordStore(join(dir, '.canvcode'))
  store.apply([node('node:a', store.rootCanvasId)], [])
  write(join(dir, 'メモ.md'), '# メモ\n')
  write(join(dir, '.canvcode', 'assets', `${HASH}.png`), 'png')
  write(join(dir, '.canvcode', 'assets', `${HASH}.json.1.2.tmp`), '{')
  return { dir, store }
}

// gdrive:<path> を root/<path> に置き換えて、rclone の about / lsf / copy / deletefile をまねる。
// copy は本物と同じく、--ignore-existing がなければ、送り先にあるファイルを上書きする
function fakeDrive() {
  const root = tempDir()
  const calls: string[][] = []
  const state = { down: false as false | string }
  const local = (path: string) => join(root, path.replace(/^gdrive:/, ''))
  const runner: RcloneRunner = async (args) => {
    calls.push(args)
    if (state.down) throw new Error(`rclone ${args[0]}: ${state.down}`)
    const [command, ...rest] = args
    if (command === 'about') return 'Total: 15 GiB\n'
    if (command === 'lsf') {
      const dir = local(rest[0])
      if (!existsSync(dir)) throw new Error('rclone lsf: error listing: directory not found')
      return readdirSync(dir).map((name) => `${name}\n`).join('')
    }
    if (command === 'copy') {
      const [src, dst] = rest
      const filesFrom = rest.indexOf('--files-from-raw')
      const names = filesFrom >= 0 ? readFileSync(rest[filesFrom + 1], 'utf8').split('\n').filter(Boolean) : readdirSync(src)
      mkdirSync(local(dst), { recursive: true })
      for (const name of names) {
        if (rest.includes('--exclude') && (name.endsWith('.tmp') || name.endsWith('.partial') || name.startsWith('.'))) continue
        if (rest.includes('--ignore-existing') && existsSync(join(local(dst), name))) continue
        copyFileSync(join(src, name), join(local(dst), name))
      }
      return ''
    }
    if (command === 'deletefile') {
      rmSync(local(rest[0]))
      return ''
    }
    throw new Error(`unknown command ${command}`)
  }
  return { root, calls, state, runner, list: (path: string) => (existsSync(join(root, path)) ? readdirSync(join(root, path)).sort() : []) }
}

const at = (iso: string) => () => new Date(iso)

describe('runBackupSync', () => {
  it('creates an archive without assets, uploads it and mirrors the assets', async () => {
    const { dir, store } = workspace()
    const drive = fakeDrive()
    const result = await runBackupSync({ workspace: dir, rclone: drive.runner, now: at('2026-10-12T03:05:00.000Z') })
    store.close()
    expect(result.ok).toBe(true)
    expect(readdirSync(join(dir, '.canvcode', 'backups'))).toEqual(['canvcode-backup-2026-10-12T03-05-00-000Z.tar.gz'])
    expect(drive.list('CanvCode-backup/archives')).toEqual(['canvcode-backup-2026-10-12T03-05-00-000Z.tar.gz'])
    // Asset は一時ファイルを除いて写す
    expect(drive.list('CanvCode-backup/assets')).toEqual([`${HASH}.png`])
    const status = await readBackupStatusFile(join(dir, '.canvcode'))
    expect(status).toMatchObject({
      lastAttemptAt: '2026-10-12T03:05:00.000Z',
      lastSuccessAt: '2026-10-12T03:05:00.000Z',
      lastError: null,
      drive: { ok: true, lastOkAt: '2026-10-12T03:05:00.000Z', error: null },
      archive: { name: 'canvcode-backup-2026-10-12T03-05-00-000Z.tar.gz', rev: 1 },
      lastRun: { archived: true, uploaded: ['canvcode-backup-2026-10-12T03-05-00-000Z.tar.gz'] },
    })
    expect(drive.calls[0]).toEqual(['about', 'gdrive:'])
  })

  it('skips the archive when nothing changed, but still checks Drive', async () => {
    const { dir, store } = workspace()
    const drive = fakeDrive()
    await runBackupSync({ workspace: dir, rclone: drive.runner, now: at('2026-10-12T03:05:00.000Z') })
    drive.calls.length = 0
    const second = await runBackupSync({ workspace: dir, rclone: drive.runner, now: at('2026-10-12T03:10:00.000Z') })
    expect(second.ok).toBe(true)
    expect(second.status.lastRun.archived).toBe(false)
    expect(readdirSync(join(dir, '.canvcode', 'backups'))).toHaveLength(1)
    // Drive は確かめるが、送るものはなく、Asset も変わっていないので写さない
    expect(drive.calls.map((call) => call[0])).toEqual(['about', 'lsf'])
    expect(second.status.lastSuccessAt).toBe('2026-10-12T03:10:00.000Z')

    // レコードが変わったら作る
    store.apply([node('node:b', store.rootCanvasId)], [])
    const third = await runBackupSync({ workspace: dir, rclone: drive.runner, now: at('2026-10-12T03:15:00.000Z') })
    expect(third.status.lastRun.archived).toBe(true)
    expect(third.status.archive?.rev).toBe(2)

    // ファイルが変わっても作る
    write(join(dir, 'メモ.md'), '# メモ 2\n')
    const fourth = await runBackupSync({ workspace: dir, rclone: drive.runner, now: at('2026-10-12T03:20:00.000Z') })
    expect(fourth.status.lastRun.archived).toBe(true)
    store.close()
    // 同じ時間のうちは、Drive にはいちばん新しいものだけ残す
    expect(drive.list('CanvCode-backup/archives')).toEqual(['canvcode-backup-2026-10-12T03-20-00-000Z.tar.gz'])
    expect(readdirSync(join(dir, '.canvcode', 'backups'))).toHaveLength(3)
  })

  it('records a Drive failure, keeps the local archive and re-sends it later', async () => {
    const { dir, store } = workspace()
    const drive = fakeDrive()
    drive.state.down = "couldn't fetch token - maybe it has expired?"
    const failed = await runBackupSync({ workspace: dir, rclone: drive.runner, now: at('2026-10-12T03:05:00.000Z') })
    expect(failed.ok).toBe(false)
    expect(failed.status.lastRun.archived).toBe(true)
    expect(failed.status.lastSuccessAt).toBeNull()
    expect(failed.status.drive.ok).toBe(false)
    expect(failed.status.drive.error).toContain('rclone config reconnect')
    expect(failed.status.lastError?.step).toBe('drive')
    expect(describeBackupStatus(failed.status, Date.parse('2026-10-12T03:06:00.000Z'))).toMatchObject({ state: 'drive', lastSuccessAt: null })
    expect(drive.list('CanvCode-backup/archives')).toEqual([])

    // つながったら、変わっていなくても送り損ねた分を送る
    drive.state.down = false
    const retried = await runBackupSync({ workspace: dir, rclone: drive.runner, now: at('2026-10-12T03:10:00.000Z') })
    store.close()
    expect(retried.ok).toBe(true)
    expect(retried.status.lastRun.archived).toBe(false)
    expect(retried.status.lastRun.uploaded).toEqual(['canvcode-backup-2026-10-12T03-05-00-000Z.tar.gz'])
    expect(drive.list('CanvCode-backup/archives')).toEqual(['canvcode-backup-2026-10-12T03-05-00-000Z.tar.gz'])
    expect(drive.list('CanvCode-backup/assets')).toEqual([`${HASH}.png`])
    expect(retried.status.drive).toMatchObject({ ok: true, lastOkAt: '2026-10-12T03:10:00.000Z' })
    expect(describeBackupStatus(retried.status, Date.parse('2026-10-12T03:11:00.000Z')).state).toBe('ok')
  })

  it('records an upload failure after the check as a Drive error', async () => {
    const { dir, store } = workspace()
    const drive = fakeDrive()
    const runner: RcloneRunner = async (args, options) => {
      if (args[0] === 'copy') throw new Error('rclone copy: Post "https://www.googleapis.com/upload/drive/v3/files": dial tcp: i/o timeout')
      return drive.runner(args, options)
    }
    const result = await runBackupSync({ workspace: dir, rclone: runner, now: at('2026-10-12T03:05:00.000Z') })
    store.close()
    expect(result.ok).toBe(false)
    expect(result.status.lastError).toMatchObject({ step: 'upload' })
    expect(result.status.drive.ok).toBe(false)
    expect(result.status.drive.error).toContain('i/o timeout')
  })

  it('does not count its own status file as a change', async () => {
    const { dir, store } = workspace()
    const drive = fakeDrive()
    await runBackupSync({ workspace: dir, rclone: drive.runner, now: at('2026-10-12T03:05:00.000Z') })
    const again = await runBackupSync({ workspace: dir, rclone: drive.runner, now: at('2026-10-12T03:10:00.000Z') })
    store.close()
    expect(again.status.lastRun.archived).toBe(false)
    expect(existsSync(join(dir, '.canvcode', 'backup-sync.lock'))).toBe(false)
  })

  it('keeps at most `keep` archives locally', async () => {
    const { dir, store } = workspace()
    const drive = fakeDrive()
    for (let i = 0; i < 4; i++) {
      store.apply([node(`node:k${i}`, store.rootCanvasId)], [])
      await runBackupSync({ workspace: dir, rclone: drive.runner, keep: 2, now: at(`2026-10-12T0${i}:00:00.000Z`) })
    }
    store.close()
    expect(readdirSync(join(dir, '.canvcode', 'backups'))).toEqual(['canvcode-backup-2026-10-12T02-00-00-000Z.tar.gz', 'canvcode-backup-2026-10-12T03-00-00-000Z.tar.gz'])
    // Drive には 1 時間に 1 個ずつ残る
    expect(drive.list('CanvCode-backup/archives')).toHaveLength(4)
  })
})

describe('runBackupSync with files kept outside the archive', () => {
  const sha256 = (data: string) => createHash('sha256').update(data).digest('hex')
  const ARCHIVE = 'canvcode-backup-2026-10-12T03-05-00-000Z.tar.gz'
  const archiveAt = (time: string) => `canvcode-backup-2026-10-12T${time.replace(':', '-')}-00-000Z.tar.gz`
  // rclone の呼び出しを、コマンドと相手のフォルダにする
  const steps = (calls: string[][]) => calls.map((call) => (call[0] === 'copy' ? `copy ${call[2]}` : call[0] === 'lsf' ? `lsf ${call[1]}` : call[0]))

  // PDF を 1 つ足したワークスペース（前に書いたことにして、ハッシュを覚えさせる）
  function workspaceWithPdf(): { dir: string; store: RecordStore; pdf: string } {
    const { dir, store } = workspace()
    const pdf = join(dir, 'research', 'sources', '論文.pdf')
    write(pdf, 'pdf-1')
    utimesSync(pdf, 1_700_000_000, 1_700_000_000)
    return { dir, store, pdf }
  }

  it('sends the contents before the archive, and the archive restores from what is on Drive', async () => {
    const { dir, store } = workspaceWithPdf()
    const drive = fakeDrive()
    const result = await runBackupSync({ workspace: dir, rclone: drive.runner, now: at('2026-10-12T03:05:00.000Z') })
    store.close()
    expect(result.ok).toBe(true)
    // 中身（blobs）→ アーカイブ → Asset の順に送る。アーカイブを送る前に、Drive の中身の一覧を確かめる
    expect(steps(drive.calls)).toEqual(['about', 'copy gdrive:CanvCode-backup/blobs', 'lsf gdrive:CanvCode-backup/archives', 'lsf gdrive:CanvCode-backup/blobs', 'copy gdrive:CanvCode-backup/archives', 'copy gdrive:CanvCode-backup/assets'])
    // 中身は、Drive にある名前を上書きしない
    expect(drive.calls.find((call) => call[0] === 'copy' && call[2].endsWith('/blobs'))).toContain('--ignore-existing')
    // ハッシュの控え（.index.json）は送らない
    expect(drive.list('CanvCode-backup/blobs')).toEqual([sha256('pdf-1')])
    expect(readdirSync(join(dir, '.canvcode', 'backup-blobs')).sort()).toEqual(['.index.json', sha256('pdf-1')].sort())
    expect(result.status.blobsFingerprint).toEqual(expect.any(String))

    // Drive にあるものだけで戻せる
    const target = join(tempDir(), 'restored')
    await restoreBackup({ archive: join(drive.root, 'CanvCode-backup', 'archives', ARCHIVE), workspace: target, assetsFrom: join(drive.root, 'CanvCode-backup', 'assets'), blobsFrom: join(drive.root, 'CanvCode-backup', 'blobs') })
    expect(readFileSync(join(target, 'research', 'sources', '論文.pdf'), 'utf8')).toBe('pdf-1')
    expect(readFileSync(join(target, 'メモ.md'), 'utf8')).toBe('# メモ\n')
    expect(readFileSync(join(target, '.canvcode', 'assets', `${HASH}.png`), 'utf8')).toBe('png')
  })

  it('does not count the stored contents as a change, and never deletes them', async () => {
    const { dir, store, pdf } = workspaceWithPdf()
    const drive = fakeDrive()
    await runBackupSync({ workspace: dir, rclone: drive.runner, now: at('2026-10-12T03:05:00.000Z') })
    drive.calls.length = 0
    const second = await runBackupSync({ workspace: dir, rclone: drive.runner, now: at('2026-10-12T03:10:00.000Z') })
    expect(second.status.lastRun.archived).toBe(false)
    expect(drive.calls.map((call) => call[0])).toEqual(['about', 'lsf'])

    // PDF が変わったら、新しい中身だけが増える。前の中身は、手元にも Drive にも残る
    writeFileSync(pdf, 'pdf-2')
    utimesSync(pdf, 1_700_000_100, 1_700_000_100)
    const third = await runBackupSync({ workspace: dir, rclone: drive.runner, now: at('2026-10-12T03:15:00.000Z') })
    store.close()
    expect(third.status.lastRun.archived).toBe(true)
    expect(drive.list('CanvCode-backup/blobs')).toEqual([sha256('pdf-1'), sha256('pdf-2')].sort())
    expect(readdirSync(join(dir, '.canvcode', 'backup-blobs')).filter((name) => !name.startsWith('.')).sort()).toEqual([sha256('pdf-1'), sha256('pdf-2')].sort())
    expect(drive.calls.some((call) => call[0] === 'deletefile' && call[1].includes('/blobs'))).toBe(false)
  })

  it('holds the archive back while the contents cannot be sent, and sends both later', async () => {
    const { dir, store } = workspaceWithPdf()
    const drive = fakeDrive()
    // Drive に、間引かれるはずの古いアーカイブを置いておく
    const old = 'canvcode-backup-2026-08-01T00-00-00-000Z.tar.gz'
    write(join(drive.root, 'CanvCode-backup', 'archives', old), 'old')
    let blobsDown = true
    const runner: RcloneRunner = async (args, options) => {
      if (blobsDown && args[0] === 'copy' && args[2].endsWith('/blobs')) throw new Error('rclone copy: googleapi: Error 403: Rate Limit Exceeded')
      return drive.runner(args, options)
    }
    const failed = await runBackupSync({ workspace: dir, rclone: runner, now: at('2026-10-12T03:05:00.000Z') })
    expect(failed.ok).toBe(false)
    expect(failed.status.lastError).toMatchObject({ step: 'upload' })
    expect(failed.status.lastRun).toMatchObject({ archived: true, uploaded: [], deletedRemote: [] })
    expect(failed.status.blobsFingerprint).toBeNull()
    // アーカイブは送らず、Drive の古いものも消さない
    expect(drive.list('CanvCode-backup/archives')).toEqual([old])
    expect(drive.list('CanvCode-backup/blobs')).toEqual([])
    expect(drive.calls.map((call) => call[0])).toEqual(['about'])
    expect(describeBackupStatus(failed.status, Date.parse('2026-10-12T03:06:00.000Z')).state).toBe('drive')

    // 送れるようになったら、変わっていなくても、中身を送ってからアーカイブを送る
    blobsDown = false
    drive.calls.length = 0
    const retried = await runBackupSync({ workspace: dir, rclone: runner, now: at('2026-10-12T03:10:00.000Z') })
    store.close()
    expect(retried.ok).toBe(true)
    expect(retried.status.lastRun).toMatchObject({ archived: false, uploaded: [ARCHIVE], deletedRemote: [old] })
    expect(steps(drive.calls).slice(0, 5)).toEqual(['about', 'copy gdrive:CanvCode-backup/blobs', 'lsf gdrive:CanvCode-backup/archives', 'lsf gdrive:CanvCode-backup/blobs', 'copy gdrive:CanvCode-backup/archives'])
    expect(drive.list('CanvCode-backup/blobs')).toEqual([sha256('pdf-1')])
    expect(drive.list('CanvCode-backup/archives')).toEqual([ARCHIVE])
  })

  it('sends the contents again when the remote changes', async () => {
    const { dir, store } = workspaceWithPdf()
    const drive = fakeDrive()
    await runBackupSync({ workspace: dir, rclone: drive.runner, now: at('2026-10-12T03:05:00.000Z') })
    // 送り先を変える。手元の中身は増えていないが、新しい送り先には 1 つもない
    write(join(dir, 'メモ.md'), '# メモ 2\n')
    const moved = await runBackupSync({ workspace: dir, rclone: drive.runner, remote: 'gdrive:Other', now: at('2026-10-12T03:10:00.000Z') })
    store.close()
    expect(moved.ok).toBe(true)
    expect(drive.list('Other/blobs')).toEqual([sha256('pdf-1')])
    expect(drive.list('Other/assets')).toEqual([`${HASH}.png`])
    // 同じ時間のうちは、いちばん新しいものだけを送る
    expect(drive.list('Other/archives')).toEqual([archiveAt('03:10')])
    const target = join(tempDir(), 'restored')
    await restoreBackup({ archive: join(drive.root, 'Other', 'archives', archiveAt('03:10')), workspace: target, assetsFrom: join(drive.root, 'Other', 'assets'), blobsFrom: join(drive.root, 'Other', 'blobs') })
    expect(readFileSync(join(target, 'research', 'sources', '論文.pdf'), 'utf8')).toBe('pdf-1')
  })

  it('sends the contents again when they have disappeared from Drive, before sending the archive', async () => {
    const { dir, store } = workspaceWithPdf()
    const drive = fakeDrive()
    await runBackupSync({ workspace: dir, rclone: drive.runner, now: at('2026-10-12T03:05:00.000Z') })
    rmSync(join(drive.root, 'CanvCode-backup', 'blobs', sha256('pdf-1')))
    write(join(dir, 'メモ.md'), '# メモ 2\n')
    drive.calls.length = 0
    const second = await runBackupSync({ workspace: dir, rclone: drive.runner, now: at('2026-10-12T03:10:00.000Z') })
    store.close()
    expect(second.ok).toBe(true)
    // 手元の中身は増えていないので最初は送らず、アーカイブを送る前の確かめで足りないと分かって送り直す
    expect(steps(drive.calls)).toEqual(['about', 'lsf gdrive:CanvCode-backup/archives', 'lsf gdrive:CanvCode-backup/blobs', 'copy gdrive:CanvCode-backup/blobs', 'lsf gdrive:CanvCode-backup/blobs', 'copy gdrive:CanvCode-backup/archives', 'deletefile'])
    expect(drive.list('CanvCode-backup/blobs')).toEqual([sha256('pdf-1')])
    expect(drive.list('CanvCode-backup/archives')).toEqual([archiveAt('03:10')])
  })

  it('never overwrites a content on Drive, even when the local copy went bad', async () => {
    const { dir, store } = workspaceWithPdf()
    const drive = fakeDrive()
    await runBackupSync({ workspace: dir, rclone: drive.runner, now: at('2026-10-12T03:05:00.000Z') })
    // 手元の中身が、同じ大きさのまま壊れた。そのあと、別の PDF が増えて中身を送る回が来る
    writeFileSync(join(dir, '.canvcode', 'backup-blobs', sha256('pdf-1')), 'pdf-X')
    const added = join(dir, 'research', 'sources', '追加.pdf')
    write(added, 'pdf-2')
    utimesSync(added, 1_700_000_000, 1_700_000_000)
    const second = await runBackupSync({ workspace: dir, rclone: drive.runner, now: at('2026-10-12T03:10:00.000Z') })
    store.close()
    expect(second.ok).toBe(true)
    expect(drive.list('CanvCode-backup/blobs')).toEqual([sha256('pdf-1'), sha256('pdf-2')].sort())
    expect(readFileSync(join(drive.root, 'CanvCode-backup', 'blobs', sha256('pdf-1')), 'utf8')).toBe('pdf-1')
  })

  it('does not send an archive whose contents are gone locally, and still sends the others', async () => {
    const { dir, store, pdf } = workspaceWithPdf()
    const drive = fakeDrive()
    // Drive につながらない間に、アーカイブ A（pdf-1 を指す）ができる
    drive.state.down = 'dial tcp: no such host'
    await runBackupSync({ workspace: dir, rclone: drive.runner, now: at('2026-10-12T03:05:00.000Z') })
    // PDF が変わり、前の中身が手元からなくなった
    writeFileSync(pdf, 'pdf-2')
    utimesSync(pdf, 1_700_000_100, 1_700_000_100)
    rmSync(join(dir, '.canvcode', 'backup-blobs', sha256('pdf-1')))
    drive.state.down = false
    const second = await runBackupSync({ workspace: dir, rclone: drive.runner, now: at('2026-10-12T04:05:00.000Z') })
    store.close()
    // A は戻せないので送らない。今の状態のアーカイブ B は送れているので、失敗にはしない
    expect(second.ok).toBe(true)
    expect(second.status.lastRun.uploaded).toEqual([archiveAt('04:05')])
    expect(drive.list('CanvCode-backup/archives')).toEqual([archiveAt('04:05')])
    expect(drive.list('CanvCode-backup/blobs')).toEqual([sha256('pdf-2')])
  })

  it('fails when the newest archive cannot be sent, and makes a new one on the next run', async () => {
    const { dir, store } = workspaceWithPdf()
    const drive = fakeDrive()
    drive.state.down = 'dial tcp: no such host'
    await runBackupSync({ workspace: dir, rclone: drive.runner, now: at('2026-10-12T03:05:00.000Z') })
    // まだ送っていないアーカイブが指す中身が、手元からなくなった（ワークスペースは変わっていない）
    rmSync(join(dir, '.canvcode', 'backup-blobs', sha256('pdf-1')))
    drive.state.down = false
    const second = await runBackupSync({ workspace: dir, rclone: drive.runner, now: at('2026-10-12T03:10:00.000Z') })
    expect(second.ok).toBe(false)
    expect(second.status.lastRun).toMatchObject({ archived: false, uploaded: [] })
    expect(second.status.lastError).toMatchObject({ step: 'upload' })
    expect(second.status.lastError?.message).toContain('足りません')
    expect(second.status.drive.ok).toBe(true)
    expect(second.status.archive).toBeNull()
    expect(drive.list('CanvCode-backup/archives')).toEqual([])
    expect(describeBackupStatus(second.status, Date.parse('2026-10-12T03:11:00.000Z')).state).toBe('failed')

    // 次の回は、変わっていなくてもアーカイブを作り直し、今のファイルから中身を置き直して送る
    const third = await runBackupSync({ workspace: dir, rclone: drive.runner, now: at('2026-10-12T03:15:00.000Z') })
    store.close()
    expect(third.ok).toBe(true)
    expect(third.status.lastRun).toMatchObject({ archived: true, uploaded: [archiveAt('03:15')] })
    expect(drive.list('CanvCode-backup/blobs')).toEqual([sha256('pdf-1')])
    expect(drive.list('CanvCode-backup/archives')).toEqual([archiveAt('03:15')])
    const target = join(tempDir(), 'restored')
    await restoreBackup({ archive: join(drive.root, 'CanvCode-backup', 'archives', archiveAt('03:15')), workspace: target, assetsFrom: join(drive.root, 'CanvCode-backup', 'assets'), blobsFrom: join(drive.root, 'CanvCode-backup', 'blobs') })
    expect(readFileSync(join(target, 'research', 'sources', '論文.pdf'), 'utf8')).toBe('pdf-1')
  })
})

describe('planArchives', () => {
  const name = (iso: string) => `canvcode-backup-${iso.replace(/[:.]/g, '-')}.tar.gz`
  const now = Date.parse('2026-10-12T12:00:00.000Z')

  it('keeps one per hour within 2 days, one per day within 30 days, and drops older ones', () => {
    const remote = [
      name('2026-10-12T11:50:00.000Z'),
      name('2026-10-12T11:05:00.000Z'), // 同じ時間の古いほう：消す
      name('2026-10-12T10:30:00.000Z'),
      name('2026-10-10T13:00:00.000Z'), // 2 日以内（47 時間前）
      name('2026-10-09T20:00:00.000Z'), // 2 日より前：その日のいちばん新しいもの
      name('2026-10-09T08:00:00.000Z'), // 同じ日の古いほう：消す
      name('2026-09-20T08:00:00.000Z'),
      name('2026-09-01T08:00:00.000Z'), // 30 日より前：消す
      'notes.txt',
      'canvcode-backup-strange.tar.gz', // 時刻を読めないものは消さない
    ]
    const local = [name('2026-10-12T11:55:00.000Z'), name('2026-10-12T11:50:00.000Z'), name('2026-10-12T09:59:00.000Z')]
    const plan = planArchives(local, remote, now)
    expect(plan.upload).toEqual([name('2026-10-12T09:59:00.000Z'), name('2026-10-12T11:55:00.000Z')])
    expect(plan.remove).toEqual([name('2026-09-01T08:00:00.000Z'), name('2026-10-09T08:00:00.000Z'), name('2026-10-12T11:05:00.000Z'), name('2026-10-12T11:50:00.000Z')])
  })

  it('always keeps the newest archive even when it is old', () => {
    const old = name('2026-08-01T00:00:00.000Z')
    const older = name('2026-07-01T00:00:00.000Z')
    const plan = planArchives([old], [older], now)
    expect(plan.upload).toEqual([old])
    expect(plan.remove).toEqual([older])
  })
})

describe('describeBackupStatus', () => {
  it('reports a stopped timer as stale', async () => {
    const { dir, store } = workspace()
    const drive = fakeDrive()
    const { status } = await runBackupSync({ workspace: dir, rclone: drive.runner, now: at('2026-10-12T03:05:00.000Z') })
    store.close()
    const attempted = Date.parse('2026-10-12T03:05:00.000Z')
    expect(describeBackupStatus(status, attempted + STALE_AFTER_MS).state).toBe('ok')
    expect(describeBackupStatus(status, attempted + STALE_AFTER_MS + 1)).toMatchObject({ state: 'stale', lastAttemptAt: '2026-10-12T03:05:00.000Z' })
    expect(describeBackupStatus(null, attempted)).toEqual({ state: 'none' })
  })
})

describe('execRclone', () => {
  // PATH に置く代わりに、場所を渡す偽の rclone
  function script(body: string): string {
    const path = join(tempDir(), 'rclone')
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
    return path
  }

  it('returns stdout on success and passes the timeout flags', async () => {
    const bin = script('echo "$@"')
    const out = await execRclone(bin)(['about', 'gdrive:'], { timeoutMs: 5_000 })
    expect(out.trim()).toBe('about gdrive: --contimeout 15s --timeout 120s --retries 2 --low-level-retries 3')
  })

  it('throws the last lines of stderr on failure', async () => {
    const bin = script('echo "NOTICE: x" >&2\necho "Failed to about: couldn\'t connect: dial tcp: no such host" >&2\nexit 1')
    await expect(execRclone(bin)(['about', 'gdrive:'], { timeoutMs: 5_000 })).rejects.toThrow(/rclone about: NOTICE: x \/ Failed to about: couldn't connect/)
  })

  it('stops a hanging rclone', async () => {
    const bin = script('sleep 5')
    await expect(execRclone(bin)(['about', 'gdrive:'], { timeoutMs: 200 })).rejects.toThrow(/終わらなかった/)
  })
})
