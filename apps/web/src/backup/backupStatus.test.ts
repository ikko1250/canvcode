import { describe, expect, it } from 'vitest'
import { backupNotice, type BackupStatusView } from './backupStatus.ts'

const time = (iso: string) => iso.slice(11, 16)
const base = { lastAttemptAt: '2026-10-12T03:05:00.000Z', lastSuccessAt: '2026-10-12T02:00:00.000Z', driveLastOkAt: '2026-10-12T02:00:00.000Z', error: null }

describe('backupNotice', () => {
  it('shows nothing when the backup works or is not set up', () => {
    expect(backupNotice(null)).toBeNull()
    expect(backupNotice({ state: 'none' })).toBeNull()
    expect(backupNotice({ state: 'ok', ...base })).toBeNull()
  })

  it('explains a Drive failure with the last success and the reason', () => {
    const view: BackupStatusView = { state: 'drive', ...base, error: 'rclone about: dial tcp: no such host' }
    const notice = backupNotice(view, time)
    expect(notice?.kind).toBe('drive')
    expect(notice?.title).toBe('Google Drive に接続できません（最終成功: 02:00、理由: rclone about: dial tcp: no such host）')
  })

  it('says when there has been no success yet', () => {
    expect(backupNotice({ state: 'drive', ...base, lastSuccessAt: null, error: 'x' }, time)?.title).toContain('最終成功: まだありません')
  })

  it('reports a failed or stopped backup', () => {
    expect(backupNotice({ state: 'failed', ...base, error: 'disk full' }, time)?.title).toBe('バックアップに失敗しています（最終成功: 02:00、理由: disk full）')
    const stale = backupNotice({ state: 'stale', ...base }, time)
    expect(stale?.kind).toBe('stale')
    expect(stale?.title).toBe('バックアップが動いていません（最後に動いた時刻: 03:05、最終成功: 02:00）')
  })
})
