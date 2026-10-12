// 定期バックアップ（サーバーの backupSync.ts）の状態を、画面に出す言葉にする。
// サーバーの GET /api/backup-status が返すもの（apps/server/src/backupStatus.ts の BackupStatusView と同じ形）
export type BackupStatusView =
  | { state: 'none' }
  | {
      state: 'ok' | 'drive' | 'failed' | 'stale'
      lastAttemptAt: string
      lastSuccessAt: string | null
      driveLastOkAt: string | null
      error: string | null
    }

export const BACKUP_STATUS_URL = '/api/backup-status'

export interface BackupNotice {
  kind: 'drive' | 'failed' | 'stale'
  // アイコンの横に出す短い言葉
  label: string
  // ホバーで出す説明（クリックすると details を出す）
  title: string
  details: string[]
}

// 知らせることがなければ null（うまくいっている・定期バックアップを入れていない）
export function backupNotice(view: BackupStatusView | null, formatTime: (iso: string) => string = defaultTime): BackupNotice | null {
  if (!view || view.state === 'none' || view.state === 'ok') return null
  const success = view.lastSuccessAt ? formatTime(view.lastSuccessAt) : 'まだありません'
  const reason = view.error ?? '不明'
  const attempted = formatTime(view.lastAttemptAt)
  if (view.state === 'drive') {
    return {
      kind: 'drive',
      label: 'Drive 未接続',
      title: `Google Drive に接続できません（最終成功: ${success}、理由: ${reason}）`,
      details: [`最終成功: ${success}`, `最後に試した時刻: ${attempted}`, `理由: ${reason}`, '手元のバックアップは作り続け、つながったら送り直します'],
    }
  }
  if (view.state === 'failed') {
    return {
      kind: 'failed',
      label: 'バックアップ失敗',
      title: `バックアップに失敗しています（最終成功: ${success}、理由: ${reason}）`,
      details: [`最終成功: ${success}`, `最後に試した時刻: ${attempted}`, `理由: ${reason}`],
    }
  }
  return {
    kind: 'stale',
    label: 'バックアップ停止',
    title: `バックアップが動いていません（最後に動いた時刻: ${attempted}、最終成功: ${success}）`,
    details: [`最後に動いた時刻: ${attempted}`, `最終成功: ${success}`, '15 分以上動いていません。systemctl --user status canvcode-backup.timer を確かめてください'],
  }
}

function defaultTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
