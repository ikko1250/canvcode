import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { threadAsking, threadBusy, type ThreadSummary } from './claudeClient.ts'

// 会話の一覧（docs/claude-chat-tab-plan.md の 1）。会話の題の ▾ で開く。
// - いちばん上に「新しい会話」、その下に会話（新しいものから）。動いている会話に ●、許可を待っている会話に「許可待ち」
// - キーで選べる：↑↓ で移り、Enter で選び、Esc で閉じる（Esc は Claude のパネルを閉じるキーなので、ここで止める）。Home・End で端へ
// - 一覧の外を押すと閉じる

const TITLE_LENGTH = 40

export function ThreadMenu(props: {
  threads: readonly ThreadSummary[]
  // 見ている会話（null は新しい会話）
  current: string | null
  onChoose(threadId: string | null): void
  // focusBack：開いたボタンにフォーカスを戻すか（一覧の外を押して閉じたときは戻さない）
  onClose(focusBack: boolean): void
}) {
  const { threads, current, onChoose, onClose } = props
  const items: (string | null)[] = [null, ...threads.map((thread) => thread.threadId)]
  // 選んでいる行（会話の id。null は「新しい会話」）。消えたら、いちばん上
  const [activeId, setActiveId] = useState<string | null>(() => (items.includes(current) ? current : null))
  const active = Math.max(0, items.indexOf(activeId))
  const setActive = (update: (index: number) => number) => setActiveId(items[update(active)] ?? null)
  const listRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<(HTMLDivElement | null)[]>([])

  useEffect(() => {
    optionRefs.current[active]?.focus({ preventScroll: false })
  }, [active, activeId])

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && listRef.current?.contains(e.target)) return
      // 開いたボタンを押したときは、ボタンが閉じる
      if (e.target instanceof Element && e.target.closest('.claude-thread-button')) return
      onClose(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [onClose])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return
    const last = items.length - 1
    if (e.key === 'ArrowDown') setActive((i) => Math.min(last, i + 1))
    else if (e.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1))
    else if (e.key === 'Home') setActive(() => 0)
    else if (e.key === 'End') setActive(() => last)
    else if (e.key === 'Enter' || e.key === ' ') onChoose(items[active] ?? null)
    else if (e.key === 'Escape' || e.key === 'Tab') onClose(true)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div ref={listRef} className="claude-thread-menu" role="listbox" aria-label="会話" onKeyDown={onKeyDown}>
      {items.map((id, i) => {
        const thread = id === null ? undefined : threads.find((t) => t.threadId === id)
        const busy = thread ? threadBusy(thread) : false
        const asking = thread ? threadAsking(thread) : false
        return (
          <div
            key={id ?? 'new'}
            ref={(el) => {
              optionRefs.current[i] = el
            }}
            role="option"
            tabIndex={i === active ? 0 : -1}
            aria-selected={id === current}
            className={`claude-thread-option${id === null ? ' new' : ''}`}
            onClick={() => onChoose(id)}
            onMouseMove={() => i !== active && setActiveId(id)}
          >
            {id === null ? (
              <span className="claude-thread-option-title">＋ 新しい会話</span>
            ) : (
              <>
                <span className={`claude-thread-option-mark${busy ? ' busy' : ''}`} aria-hidden="true">
                  {busy ? '●' : ''}
                </span>
                {busy && <span className="claude-sr-only">動いています</span>}
                <span className="claude-thread-option-title">{truncate(thread?.title ?? '', TITLE_LENGTH)}</span>
                {asking && <span className="claude-thread-option-asking">許可待ち</span>}
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

function truncate(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(line)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : line
}
