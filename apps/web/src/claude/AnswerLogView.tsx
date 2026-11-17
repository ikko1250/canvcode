import { useEffect, useRef } from 'react'
import { thinkingBlocks, type AnswerLogEntry } from './answerLog.ts'

// 付箋の答えのパネル（AnswerPanel）に出す、付箋で聞いた答え（キャンバスの AI）の記録（answerLog.ts）。
// - 一覧：回答中のもの（くるくる。押すと、考えている中身だけを見る）と、画面を開いてから終わったもの（新しい方から 3 つ。「回答終了」と「答えへ移る」）
// - 「過去の答え」：それより前に終わったもの（畳んである）
// - 考えている中身の表示（AnswerThinking）は、一覧の下に出す（一覧は縮める。「← 一覧に戻る」で閉じる）

// 帯に「回答終了」として残す数
const RECENT_COUNT = 3

const KIND_LABELS: Record<AnswerLogEntry['kind'], string> = { ask: '質問', rewrite: '書き直し', 'follow-up': '続き' }

export function AnswerStrip(props: {
  entries: readonly AnswerLogEntry[]
  // 画面を開いた時刻（これより後に終わったものを帯に出す）
  since: number
  viewing: string | null
  onView(id: string | null): void
  onJump(entry: AnswerLogEntry): void
  onClear(): void
}) {
  const { entries, since, viewing, onView, onJump, onClear } = props
  if (entries.length === 0) return null
  const running = entries.filter((entry) => entry.status === 'running')
  const finished = entries.filter((entry) => entry.status !== 'running')
  const recent = finished.filter((entry) => (entry.finishedAt ?? entry.startedAt) >= since).slice(0, RECENT_COUNT)
  const past = finished.filter((entry) => !recent.includes(entry))
  const row = (entry: AnswerLogEntry, timeWithDate: boolean) => (
    <div key={entry.id} className={`answer-row answer-row-${entry.status}${viewing === entry.id ? ' answer-row-viewing' : ''}`}>
      <button type="button" className="answer-row-main" onClick={() => onView(viewing === entry.id ? null : entry.id)} title="Claude が考えたことを見る">
        {entry.status === 'running' ? <span className="claude-spinner" aria-hidden="true" /> : null}
        <span className="answer-row-status">{statusLabel(entry)}</span>
        <span className="answer-row-label">
          {KIND_LABELS[entry.kind]}：{entry.label}
        </span>
        <span className="answer-row-time">{timeLabel(entry.startedAt, timeWithDate)}</span>
      </button>
      {entry.status === 'done' && entry.frameId && (
        <button type="button" className="answer-row-jump" onClick={() => onJump(entry)} title="答えのフレームへ移る">
          答えへ移る
        </button>
      )}
    </div>
  )
  return (
    <div className="answer-strip" aria-label="付箋の答え">
      {running.map((entry) => row(entry, false))}
      {recent.map((entry) => row(entry, false))}
      {past.length > 0 && (
        <details className="answer-past">
          <summary>過去の答え（{past.length}）</summary>
          <div className="answer-past-list">{past.map((entry) => row(entry, true))}</div>
          <button type="button" className="answer-past-clear" onClick={onClear} title="終わった答えの記録を消す（キャンバスの答えは消えません）">
            記録を消す
          </button>
        </details>
      )}
    </div>
  )
}

// 考えている中身だけを見る（回答中なら流れてくる）。段落と、調べている語・読んでいるページの行（「― 」で始まる行）に分けて出し、
// 間は CSS でそろえる（届いた文字の空の行の数によらない）
export function AnswerThinking(props: { entry: AnswerLogEntry; onBack(): void; onJump(entry: AnswerLogEntry): void }) {
  const { entry, onBack, onJump } = props
  const bodyRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const body = bodyRef.current
    if (body && stick.current) body.scrollTop = body.scrollHeight
  }, [entry.thinking])
  return (
    <div className="answer-thinking-view">
      <div className="answer-thinking-head">
        <button type="button" onClick={onBack}>
          ← 一覧に戻る
        </button>
        <span className="answer-thinking-title">
          {statusLabel(entry)}：{entry.label}
        </span>
        {entry.status === 'done' && entry.frameId && (
          <button type="button" onClick={() => onJump(entry)}>
            答えへ移る
          </button>
        )}
      </div>
      {entry.error && <p className="answer-thinking-error">{entry.error}</p>}
      <div
        className="answer-thinking"
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {entry.thinking ? (
          thinkingBlocks(entry.thinking).map((block, i) =>
            block.kind === 'tool' ? (
              <div key={i} className="answer-thinking-tool">
                {block.lines.map((line, j) => (
                  <div key={j}>{line}</div>
                ))}
              </div>
            ) : (
              <p key={i}>{block.text}</p>
            ),
          )
        ) : (
          <p className="answer-thinking-empty">
            {entry.status === 'running'
              ? '考えています…（考えている中身は、届きしだい出ます。effort が Medium 以下だと、考えずに答えることが多い）'
              : '考えた中身は届きませんでした（Claude が考えずに答えました。effort を High 以上にすると、考えることが多い）'}
          </p>
        )}
      </div>
    </div>
  )
}

function statusLabel(entry: AnswerLogEntry): string {
  switch (entry.status) {
    case 'running':
      return '回答中'
    case 'done':
      return '回答終了'
    case 'failed':
      return '失敗'
    case 'cancelled':
      return 'やめた'
  }
}

function timeLabel(time: number, withDate: boolean): string {
  const date = new Date(time)
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return withDate ? `${date.getMonth() + 1}/${date.getDate()} ${hm}` : hm
}
