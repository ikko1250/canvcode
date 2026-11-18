import { useEffect, useMemo, useRef } from 'react'
import { renderMarkdownToSafeHtml } from '@canvcode/nodes/markdown'
import type { AiAnswer } from '@canvcode/canvas'
import { thinkingBlocks } from './answerLog.ts'
import type { RunningQuestion } from './claudeClient.ts'

// 付箋で聞いた答えの中身（docs/canvas-answer-panel-plan.md の 4）。付箋の横のパネル（AnswerPopover）と、
// 右のパネルの質問のタブの答えで同じものを使う。
// - 本文はチャットと同じ Markdown の出し方（renderMarkdownToSafeHtml）
// - 質問の付箋の文字が送ったときと違えば、本文の上に知らせる
// - 関連する付箋：↗ と 1 行目。押すと、その付箋へ移る
// - 下に「続けて聞く」「Canvasに残す」（付箋を置けないとき（全画面のエディタ）は出さない）
// - 答えを作っている間は、本文の代わりに、進み具合（読む → 調べる → 書く）と考えている中身と「やめる」
// - 失敗したら、前の答えがあればそれを出し、上に失敗のわけを 1 行出す

export interface RelatedNote {
  id: string
  // 付箋の 1 行目
  label: string
}

export type AnswerProgress = Pick<RunningQuestion, 'step' | 'searched' | 'thinking'>

export function AnswerView(props: {
  answer: AiAnswer | null
  // 答えを作っている間
  progress: AnswerProgress | null
  error?: string
  questionChanged: boolean
  related: readonly RelatedNote[]
  onRelated(id: string): void
  onContinue?(): void
  onKeep?(): void
  onStop?(): void
}) {
  const { answer, progress, error, questionChanged, related, onRelated, onContinue, onKeep, onStop } = props
  const html = useMemo(() => (answer ? renderMarkdownToSafeHtml(answer.body) : ''), [answer])
  if (progress) return <AnswerProgressView progress={progress} {...(onStop ? { onStop } : {})} />
  return (
    <div className="answer-view">
      {error && <p className="answer-view-error">答えられませんでした：{error}</p>}
      {answer ? (
        <>
          {questionChanged && <p className="answer-view-note">質問が変わっています（送り直すと答え直します）</p>}
          <div className="answer-view-body claude-text" dangerouslySetInnerHTML={{ __html: html }} />
          {related.length > 0 && (
            <div className="answer-view-related">
              <div className="answer-view-related-title">関連する付箋</div>
              {related.map((note) => (
                <button key={note.id} type="button" className="answer-view-related-note" onClick={() => onRelated(note.id)} title="この付箋へ移る">
                  ↗ {note.label}
                </button>
              ))}
            </div>
          )}
          {(onContinue || onKeep) && (
            <div className="answer-view-actions">
              {onContinue && (
                <button type="button" className="answer-view-continue" onClick={onContinue} title="この答えを踏まえて聞く付箋を、元の付箋の下に置く">
                  続けて聞く
                </button>
              )}
              {onKeep && (
                <button type="button" className="answer-view-keep" onClick={onKeep} title="答えを書式付きのテキストにして、キャンバスに置く">
                  Canvasに残す
                </button>
              )}
            </div>
          )}
        </>
      ) : (
        !error && <p className="answer-view-note">まだ答えがありません</p>
      )}
    </div>
  )
}

const STEPS: readonly { step: AnswerProgress['step']; label: string }[] = [
  { step: 'read', label: '読む' },
  { step: 'search', label: '調べる' },
  { step: 'write', label: '書く' },
]

// 進み具合（✓ 済んだ・● 今・薄い まだ／調べなかった）と、考えている中身
function AnswerProgressView(props: { progress: AnswerProgress; onStop?(): void }) {
  const { progress, onStop } = props
  const bodyRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const body = bodyRef.current
    if (body && stick.current) body.scrollTop = body.scrollHeight
  }, [progress.thinking])
  const current = STEPS.findIndex((step) => step.step === progress.step)
  return (
    <div className="answer-view answer-view-running">
      <div className="answer-view-steps" aria-label="進み具合">
        {STEPS.map((step, i) => {
          const skipped = step.step === 'search' && !progress.searched && current > i
          const state = skipped ? 'skipped' : i < current ? 'done' : i === current ? 'current' : 'todo'
          return (
            <span key={step.step} className={`answer-view-step ${state}`}>
              {state === 'done' ? '✓ ' : state === 'current' ? '● ' : ''}
              {step.label}
              {i < STEPS.length - 1 && <span className="answer-view-step-arrow"> → </span>}
            </span>
          )
        })}
        {onStop && (
          <button type="button" className="answer-view-stop" onClick={onStop} title="Claude に頼むのをやめる">
            やめる
          </button>
        )}
      </div>
      <div
        className="answer-thinking"
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {progress.thinking ? (
          thinkingBlocks(progress.thinking).map((block, i) =>
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
          <p className="answer-thinking-empty">考えています…（考えている中身は、届きしだい出ます）</p>
        )}
      </div>
    </div>
  )
}
