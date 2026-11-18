import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { renderMarkdownToSafeHtml } from '@canvcode/nodes/markdown'
import type { AiAnswer } from '@canvcode/canvas'
import { thinkingBlocks } from './thinking.ts'
import type { RunningQuestion } from './claudeClient.ts'

// 付箋で聞いた答えの中身（docs/canvas-answer-panel-plan.md の 4）。付箋の横のパネル（AnswerPopover）と、
// 右のパネルの質問のタブの答えで同じものを使う。
// - 本文はチャットと同じ Markdown の出し方（renderMarkdownToSafeHtml）
// - 質問の付箋の文字が送ったときと違えば、本文の上に知らせる
// - 関連する付箋：↗ と 1 行目。押すと、その付箋へ移る
// - 下に「続けて聞く」「会話で続ける」「Canvasに残す」（付箋を置けないとき（全画面のエディタ）は出さない）。
//   「会話で続ける」は小さなメニュー：「いまの会話『題』に入れる」（会話を選んでいれば）・「新しい会話にする」（docs/claude-chat-tab-plan.md の 6）
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
  // 会話で続ける（newThread なら新しい会話）。chatTitle は、いま会話のタブで選んでいる会話の題（なければ新しい会話だけ）
  onChat?(newThread: boolean): void
  chatTitle?: string | null
}) {
  const { answer, progress, error, questionChanged, related, onRelated, onContinue, onKeep, onStop, onChat, chatTitle } = props
  const [chatMenu, setChatMenu] = useState(false)
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
                  <span>↗ {note.label}</span>
                </button>
              ))}
            </div>
          )}
          {(onContinue || onKeep || onChat) && (
            <div className="answer-view-actions">
              {onContinue && (
                <button type="button" className="answer-view-continue" onClick={onContinue} title="この答えを踏まえて聞く付箋を、元の付箋の下に置く">
                  続けて聞く
                </button>
              )}
              {onChat && (
                <button
                  type="button"
                  className="answer-view-chat"
                  aria-haspopup="menu"
                  aria-expanded={chatMenu}
                  onClick={() => setChatMenu((open) => !open)}
                  title="この質問と答えを、会話に取り込んで続ける"
                >
                  会話で続ける
                </button>
              )}
              {onKeep && (
                <button type="button" className="answer-view-keep" onClick={onKeep} title="答えを書式付きのテキストにして、キャンバスに置く">
                  Canvasに残す
                </button>
              )}
              {onChat && chatMenu && (
                <ChatMenu
                  title={chatTitle ?? null}
                  onChoose={(newThread) => {
                    setChatMenu(false)
                    onChat(newThread)
                  }}
                  onClose={() => setChatMenu(false)}
                />
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

// 「会話で続ける」のメニュー。開いたら最初の項目にフォーカスし、Esc で閉じる（パネルは閉じない）。外を押すと閉じる
function ChatMenu(props: { title: string | null; onChoose(newThread: boolean): void; onClose(): void }) {
  const { title, onChoose, onClose } = props
  const menuRef = useRef<HTMLDivElement>(null)
  // 閉じる関数は描くたびに変わるので、ref から呼ぶ（effect は開いたときに 1 回だけ）
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })
  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true })
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && menuRef.current?.parentElement?.contains(e.target)) return
      closeRef.current()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [])
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.nativeEvent.isComposing) return
    e.preventDefault()
    e.stopPropagation()
    onClose()
  }
  return (
    <div ref={menuRef} className="answer-view-chat-menu" role="menu" onKeyDown={onKeyDown}>
      {title !== null && (
        <button type="button" role="menuitem" onClick={() => onChoose(false)}>
          <span>いまの会話『{oneLine(title)}』に入れる</span>
        </button>
      )}
      <button type="button" role="menuitem" onClick={() => onChoose(true)}>
        <span>新しい会話にする</span>
      </button>
    </div>
  )
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(line)
  return chars.length > 20 ? `${chars.slice(0, 19).join('')}…` : line
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
