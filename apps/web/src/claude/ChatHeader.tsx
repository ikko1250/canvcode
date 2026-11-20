import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ThreadSummary } from './claudeClient.ts'
import { ThreadMenu } from './ThreadMenu.tsx'

// 会話のタブの上の並び（docs/claude-chat-tab-plan.md の 1）。
// - 1 段目：「会話｜質問」のタブ（全画面のエディタでは「チャット」）、＋（新しい会話）、⋯（この会話のメニュー）、×
//   ⋯ の中は「この会話を消す」（2 回押す。動いている依頼・作業・待っている許可があれば押せない）
// - 2 段目：会話の題と ▾。押すと会話の一覧（ThreadMenu）。まだ送っていない新しい会話の題は「新しい会話」

export function ChatHeader(props: {
  tabs?: ReactNode
  threads: readonly ThreadSummary[]
  // 見ている会話（ない＝新しい会話）
  thread: ThreadSummary | undefined
  // 動いている依頼・作業・待っている許可がある（消せない）
  busy: boolean
  onChoose(threadId: string | null): void
  onNew(): void
  onDelete(threadId: string): void
  onClose(): void
  // 増えたら、開いている会話の一覧とメニューを閉じる（パネルを閉じたとき。開き直したときに、開いたまま出さない）
  closeRequest?: number
}) {
  const { tabs, threads, thread, busy, onChoose, onNew, onDelete, onClose, closeRequest } = props
  const [listing, setListing] = useState(false)
  const [menu, setMenu] = useState(false)
  // 「この会話を消す」を 1 回押した
  const [confirmDelete, setConfirmDelete] = useState(false)
  const titleRef = useRef<HTMLButtonElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // 会話を替えたら、メニューと消す確かめをやめる
  const threadId = thread?.threadId ?? null
  const [menuFor, setMenuFor] = useState(threadId)
  if (menuFor !== threadId) {
    setMenuFor(threadId)
    setMenu(false)
    setConfirmDelete(false)
  }
  const [seenCloseRequest, setSeenCloseRequest] = useState(closeRequest)
  if (closeRequest !== seenCloseRequest) {
    setSeenCloseRequest(closeRequest)
    setListing(false)
    setMenu(false)
    setConfirmDelete(false)
  }

  // 開いたら、メニューの項目にフォーカスする（押せなければメニューに）
  useEffect(() => {
    if (!menu) return
    const item = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? menuRef.current
    item?.focus({ preventScroll: true })
  }, [menu])

  // メニューの外を押したら閉じる
  useEffect(() => {
    if (!menu) return
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && (menuRef.current?.contains(e.target) || moreRef.current?.contains(e.target))) return
      setMenu(false)
      setConfirmDelete(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [menu])

  const closeList = (focus = true) => {
    setListing(false)
    if (focus) titleRef.current?.focus({ preventScroll: true })
  }
  const closeMenu = () => {
    setMenu(false)
    setConfirmDelete(false)
    moreRef.current?.focus({ preventScroll: true })
  }

  return (
    <div className="claude-panel-header claude-chat-header">
      <div className="claude-panel-header-row">
        {tabs ?? <strong>チャット</strong>}
        <button type="button" className="claude-icon-button claude-new" onClick={onNew} title="新しい会話を始める" aria-label="新しい会話">
          ＋
        </button>
        <div className="claude-more">
          <button
            ref={moreRef}
            type="button"
            className="claude-icon-button"
            aria-label="この会話のメニュー"
            aria-haspopup="menu"
            aria-expanded={menu}
            disabled={!thread}
            title={thread ? 'この会話のメニュー' : 'まだ送っていない会話です'}
            onClick={() => {
              setMenu((open) => !open)
              setConfirmDelete(false)
            }}
          >
            ⋯
          </button>
          {menu && thread && (
            <div
              ref={menuRef}
              className="claude-more-menu"
              role="menu"
              tabIndex={-1}
              onKeyDown={(e) => {
                if ((e.key !== 'Escape' && e.key !== 'Tab') || e.nativeEvent.isComposing) return
                e.preventDefault()
                e.stopPropagation()
                closeMenu()
              }}
            >
              <button
                type="button"
                role="menuitem"
                className={confirmDelete ? 'claude-danger' : undefined}
                disabled={busy}
                onClick={() => {
                  if (!confirmDelete) return setConfirmDelete(true)
                  setMenu(false)
                  setConfirmDelete(false)
                  onDelete(thread.threadId)
                  titleRef.current?.focus({ preventScroll: true })
                }}
                title={busy ? '動いている依頼と作業を止めてから消せます' : 'この会話を消す（もう一度押すと消します）'}
              >
                {confirmDelete ? '本当に消す' : 'この会話を消す'}
              </button>
              {busy && <div className="claude-more-note">動いている依頼・作業・許可を待っているものを止めてから消せます</div>}
            </div>
          )}
        </div>
        <button type="button" className="claude-icon-button claude-close" onClick={onClose} title="閉じる（Esc）" aria-label="閉じる">
          ×
        </button>
      </div>
      <div className="claude-thread-title">
        <button
          ref={titleRef}
          type="button"
          className="claude-thread-button"
          aria-haspopup="listbox"
          aria-expanded={listing}
          title="会話を替える"
          onClick={() => setListing((open) => !open)}
        >
          <span className="claude-thread-name">{thread ? oneLine(thread.title) : '新しい会話'}</span>
          <span className="claude-thread-caret" aria-hidden="true">
            ▾
          </span>
        </button>
        {listing && (
          <ThreadMenu
            threads={threads}
            current={threadId}
            onChoose={(id) => {
              closeList()
              onChoose(id)
            }}
            onClose={(focusBack) => closeList(focusBack)}
          />
        )}
      </div>
    </div>
  )
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
