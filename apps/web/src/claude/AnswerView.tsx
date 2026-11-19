import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { renderMarkdownToSafeHtml } from '@canvcode/nodes/markdown'
import type { AiAnswer } from '@canvcode/canvas'
import { thinkingBlocks } from './thinking.ts'
import type { JobEvent, RunningQuestion } from './claudeClient.ts'
import { runningText, toolLabel } from './toolGroups.ts'

// 付箋で聞いた答えの中身（docs/canvas-answer-panel-plan.md の 4）。付箋の横のパネル（AnswerPopover）と、
// 右のパネルの質問のタブの答えで同じものを使う。
// - 本文はチャットと同じ Markdown の出し方（renderMarkdownToSafeHtml）
// - 質問の付箋の文字が送ったときと違えば、本文の上に知らせる
// - 関連する付箋：↗ と 1 行目。押すと、その付箋へ移る
// - 下に「続けて聞く」「会話で続ける」「Canvasに残す」（付箋を置けないとき（全画面のエディタ）は出さない）。
//   「会話で続ける」は小さなメニュー：「いまの会話「題」に入れる」（会話を選んでいれば）・「新しい会話にする」（docs/claude-chat-tab-plan.md の 6）
// - 答えを作っている間は、本文の代わりに、進み具合（読む → 調べる → 書く）と考えている中身と「やめる」
// - 失敗したら、前の答えがあればそれを出し、上に失敗のわけを 1 行出す
// - AI 付箋の作業（docs/ai-note-tasks-plan.md）：作業の間は、今していること・ツールの動き・Claude の途中の文と「止める」（task）。
//   報告（threadId のある答え）は、止まった・止めたときの 1 行、本文、変えたもの（Canvas の編集・ファイル・コマンド。たたんで出す）、
//   関連する付箋、「続けて頼む」「チャットで続ける」（その作業の会話を開く）「Canvasに残す」。前の Q&A の答えは今のまま

export interface RelatedNote {
  id: string
  // 付箋の 1 行目
  label: string
}

export type AnswerProgress = Pick<RunningQuestion, 'step' | 'searched' | 'thinking'>

// 付箋の作業の間の様子（動いているジョブの出来事。asking は許可を待っているか）
export interface TaskProgress {
  events: readonly JobEvent[]
  asking: boolean
}

// 作業の間に出すツールの動きの数（新しいものから）
const TASK_TOOL_LINES = 8

export function AnswerView(props: {
  answer: AiAnswer | null
  // 答えを作っている間
  progress: AnswerProgress | null
  // 付箋の作業の間
  task?: TaskProgress | null
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
  // 作業の報告の「チャットで続ける」：その作業の会話を開く
  onOpenThread?(threadId: string, jobId?: string): void
}) {
  const { answer, progress, task, error, questionChanged, related, onRelated, onContinue, onKeep, onStop, onChat, chatTitle, onOpenThread } = props
  const [chatMenu, setChatMenu] = useState(false)
  const html = useMemo(() => (answer ? renderMarkdownToSafeHtml(answer.body) : ''), [answer])
  if (task) return <TaskProgressView task={task} {...(onStop ? { onStop } : {})} />
  if (progress) return <AnswerProgressView progress={progress} {...(onStop ? { onStop } : {})} />
  // 作業の報告か（前の Q&A の答えには会話がない）
  const report = answer?.threadId ? answer : null
  return (
    <div className="answer-view">
      {error && <p className="answer-view-error">{report || !answer ? '頼めませんでした' : '答えられませんでした'}：{error}</p>}
      {answer ? (
        <>
          {report?.status === 'failed' && <p className="answer-view-error">作業が途中で止まりました{report.error ? `：${report.error}` : ''}</p>}
          {report?.status === 'cancelled' && <p className="answer-view-note">作業を止めました（ここまでの報告です）</p>}
          {questionChanged && <p className="answer-view-note">{report ? '付箋の文が変わっています（送り直すと、もう一度作業します）' : '質問が変わっています（送り直すと答え直します）'}</p>}
          <div className="answer-view-body claude-text" dangerouslySetInnerHTML={{ __html: html }} />
          {report?.changes && <TaskChanges changes={report.changes} />}
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
          {(onContinue || onKeep || onChat || (report && onOpenThread)) && (
            <div className="answer-view-actions">
              {onContinue && (
                <button
                  type="button"
                  className="answer-view-continue"
                  onClick={onContinue}
                  title={report ? 'この作業の続きを頼む付箋を、元の付箋の下に置く' : 'この答えを踏まえて聞く付箋を、元の付箋の下に置く'}
                >
                  {report ? '続けて頼む' : '続けて聞く'}
                </button>
              )}
              {report && onOpenThread && (
                <button type="button" className="answer-view-chat" onClick={() => onOpenThread(report.threadId!, report.jobId)} title="この作業の会話を、会話のタブで開いて続ける">
                  チャットで続ける
                </button>
              )}
              {!report && onChat && (
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
              {!report && onChat && chatMenu && (
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

// 作業の報告の「変えたもの」（たたんで出す。なければ出さない）
function TaskChanges(props: { changes: NonNullable<AiAnswer['changes']> }) {
  const { canvas, files, commands } = props.changes
  const count = canvas.length + files.length + commands.length
  if (count === 0) return null
  return (
    <details className="answer-view-changes">
      <summary>変えたもの {count} 件</summary>
      {canvas.length > 0 && (
        <div className="answer-view-changes-group">
          <div className="answer-view-changes-title">キャンバス</div>
          <ul>
            {canvas.map((edit) => (
              <li key={edit.batch} className={edit.undone ? 'undone' : undefined}>
                {edit.label}
                {edit.undone ? '（戻した）' : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {files.length > 0 && (
        <div className="answer-view-changes-group">
          <div className="answer-view-changes-title">ファイル（戻せません）</div>
          <ul>
            {files.map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {commands.length > 0 && (
        <div className="answer-view-changes-group">
          <div className="answer-view-changes-title">コマンド</div>
          <ul>
            {commands.map((command) => (
              <li key={command}>
                <code>{command}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </details>
  )
}

// 付箋の作業の間：今していること（許可を待っていれば、そう出す）と「止める」、ツールの動き（新しいものから）、Claude の途中の文
function TaskProgressView(props: { task: TaskProgress; onStop?(): void }) {
  const { task, onStop } = props
  const tools = task.events.flatMap((event) => (event.kind === 'tool' ? [event] : [])).slice(-TASK_TOOL_LINES).reverse()
  const lastText = [...task.events].reverse().find((event): event is Extract<JobEvent, { kind: 'text' }> => event.kind === 'text')?.text.trim()
  return (
    <div className="answer-view answer-view-running">
      <div className="answer-view-steps" aria-label="進み具合">
        <span className={`answer-view-step current${task.asking ? ' asking' : ''}`}>
          ● {task.asking ? '許可を待っています（作業のタブで答えてください）' : runningText(task.events, false)}
        </span>
        {onStop && (
          <button type="button" className="answer-view-stop" onClick={onStop} title="この作業を止める">
            止める
          </button>
        )}
      </div>
      <div className="answer-thinking">
        {tools.length === 0 && !lastText ? (
          <p className="answer-thinking-empty">作業を始めています…</p>
        ) : (
          <>
            {lastText && <p>{lastText}</p>}
            {tools.length > 0 && (
              <div className="answer-thinking-tool">
                {tools.map((tool, i) => (
                  <div key={i} title={tool.name}>
                    {toolLabel(tool.name)}
                    {tool.detail ? `：${tool.detail}` : ''}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
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
          <span>いまの会話「{oneLine(title)}」に入れる</span>
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
