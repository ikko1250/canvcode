import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBackupStatusFile, type BackupStatusFile } from './backupSync.ts'

// 定期バックアップ（backupSync.ts）の状態を画面に渡す（GET /api/backup-status）。
// 画面は「未接続」の表示の隣に、Drive に送れていないときなどのアイコンを出す（apps/web/src/BackupStatus.tsx）
// - none：状態ファイルがない（定期バックアップを入れていない）。何も出さない
// - ok：最後に動いたときにうまくいった
// - drive：Google Drive につながらない（rclone の失敗・認証切れ・ネットワーク）
// - failed：手元のアーカイブを作れなかった
// - stale：STALE_AFTER_MS より長く動いていない（タイマーが止まっている）

export const BACKUP_STATUS_PATH = '/api/backup-status'
export const STALE_AFTER_MS = 15 * 60 * 1000

export type BackupStatusView =
  | { state: 'none' }
  | {
      state: 'ok' | 'drive' | 'failed' | 'stale'
      lastAttemptAt: string
      lastSuccessAt: string | null
      driveLastOkAt: string | null
      error: string | null
    }

export function describeBackupStatus(status: BackupStatusFile | null, now: number): BackupStatusView {
  if (!status) return { state: 'none' }
  const base = { lastAttemptAt: status.lastAttemptAt, lastSuccessAt: status.lastSuccessAt, driveLastOkAt: status.drive.lastOkAt }
  const attempted = Date.parse(status.lastAttemptAt)
  if (Number.isNaN(attempted) || now - attempted > STALE_AFTER_MS) return { state: 'stale', ...base, error: status.lastError?.message ?? null }
  if (!status.drive.ok) return { state: 'drive', ...base, error: status.drive.error ?? status.lastError?.message ?? null }
  if (status.lastError) return { state: 'failed', ...base, error: status.lastError.message }
  return { state: 'ok', ...base, error: null }
}

export async function handleBackupStatus(req: IncomingMessage, res: ServerResponse, pathname: string, dataDir: string): Promise<boolean> {
  if (pathname !== BACKUP_STATUS_PATH) return false
  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'method not allowed' }))
    return true
  }
  const view = describeBackupStatus(await readBackupStatusFile(dataDir), Date.now())
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(view))
  return true
}
