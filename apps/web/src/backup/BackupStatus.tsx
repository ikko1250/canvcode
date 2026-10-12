import { useEffect, useRef, useState } from 'react'
import { BACKUP_STATUS_URL, backupNotice, type BackupStatusView } from './backupStatus.ts'

// 右上の「保存済み」「未接続」の隣に出す、定期バックアップのアイコン。
// Google Drive につながらない・バックアップに失敗している・バックアップが動いていないときだけ出す。
// ホバーで説明（title）、クリックで詳しい説明を開く。状態はサーバーの /api/backup-status を 1 分ごとと、
// サーバーにつながり直したとき・タブが前に出たときに読む
const POLL_MS = 60_000

export function BackupStatus(props: { serverOnline: boolean }) {
  const { serverOnline } = props
  const [view, setView] = useState<BackupStatusView | null>(null)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // 開いた説明は、ほかの場所を押すか Esc で閉じる
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => {
    // サーバーにつながり直したときにも読み直す（読めなければ前に読んだものを出しておく）
    let cancelled = false
    const load = () => {
      fetch(BACKUP_STATUS_URL, { cache: 'no-store' })
        .then((response) => (response.ok ? (response.json() as Promise<BackupStatusView>) : null))
        .then((next) => {
          if (!cancelled && next) setView(next)
        })
        .catch(() => {})
    }
    load()
    const timer = window.setInterval(load, POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [serverOnline])

  const notice = backupNotice(view)
  if (!notice) return null
  return (
    <div className="backup-status-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`backup-status ${notice.kind}`}
        title={notice.title}
        aria-label={notice.title}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {notice.kind === 'stale' ? <ClockIcon /> : <CloudOffIcon />}
      </button>
      {open && (
        <div className="backup-status-detail" role="dialog" aria-label={notice.label}>
          <div className="backup-status-detail-title">{notice.title.replace(/（.*$/, '')}</div>
          {notice.details.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      )}
    </div>
  )
}

function CloudOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 18h10.5a4 4 0 0 0 1.3-7.8A6 6 0 0 0 8.2 7.4" />
      <path d="M5.6 9.4A4.5 4.5 0 0 0 7 18" />
      <path d="M3 3l18 18" />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}
