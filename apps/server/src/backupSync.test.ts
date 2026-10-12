import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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

// gdrive:<path> を root/<path> に置き換えて、rclone の about / lsf / copy / deletefile をまねる
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
