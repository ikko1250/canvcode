import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import { OWN_KEYS_ATTRIBUTE, aiNoteMeta, firstLine, questionText, type AiAnswer, type AiNoteMeta, type Editor } from '@canvcode/canvas'
import type { NodeRecord } from '@canvcode/core'
import { AnswerView, type RelatedNote } from './AnswerView.tsx'
import { useClaudeState, type AnsweredNote, type AnsweredNoteDetail, type ClaudeClient, type Effort, type RunningQuestion } from './claudeClient.ts'
import { settingLabel } from './modelChoice.ts'
import type { SeenAnswers } from './seenAnswers.ts'
import { useNodesVersion } from './useNodesVersion.ts'

// 右のパネルの質問のタブ（docs/canvas-answer-panel-plan.md の 6）。付箋で聞いた質問を、どの Canvas からでも見る。
// - ① 一覧：上に「すべてのキャンバス ▾」。動作中（サーバーが流す動いている質問。ほかのタブ・端末で頼んだものも。進み具合と止めるボタン）と、
//   過去の回答（答えを持つ付箋。新しいものから。まだ見ていないものに青い点）。過去の回答はサーバーから読み（ほかの Canvas のものも）、
//   開いている Canvas のものは Editor から読む（書いたばかり・消したばかりでも合うように）
// - ② 答え：「← 一覧」、質問、Canvas と時刻、モデルの札、「↗ 付箋へ移動」、AnswerView（本文・関連する付箋・「続けて聞く」「Canvasに残す」）。
//   答えを作っている間は、進み具合と考えている中身と「やめる」。開いたら、その答えを見たことにする
// - ③ この場で続けて聞く：「続けて聞く」「Canvasに残す」は、元の付箋がいま開いている Canvas になければ、画面の真ん中に置く（App）
// - パネルの中のキー入力は、キャンバスに渡さない。Esc で閉じる（答えを見ていれば一覧に戻る）

// 答えた時刻を読み直すまで待つ時間（付箋に書いた答えがサーバーに届くまで。ミリ秒）
const REFETCH_AFTER_DONE_MS = 1500
const QUESTION_LABEL_LENGTH = 60
const RELATED_LABEL_LENGTH = 30

interface Viewing {
  noteId: string
  canvasId: string
}

export function QuestionPanel(props: {
  claude: ClaudeClient
  // いま開いている Canvas の Editor
  editor: Editor
  seen: SeenAnswers
  hidden: boolean
  // 増えたら、パネルにフォーカスする
  focusRequest: number
  tabs: ReactNode
  canvasTitle(canvasId: string): string
  // 付箋を置けるか（キャンバスを見ているとき）
  canPlace: boolean
  onOpenNote(canvasId: string, noteId: string): void
  onContinue(canvasId: string, noteId: string, meta: AiNoteMeta): void
  onKeep(canvasId: string, noteId: string, body: string): void
  onClose(): void
}) {
  const { claude, editor, seen, hidden, focusRequest, tabs, canvasTitle, canPlace, onOpenNote, onContinue, onKeep, onClose } = props
  const state = useClaudeState(claude)
  useSyncExternalStore(seen.subscribe, seen.getSnapshot)
  const nodesVersion = useNodesVersion(editor)
  const panelRef = useRef<HTMLElement>(null)
  const [filter, setFilter] = useState<'all' | 'here'>('all')
  const [viewing, setViewing] = useState<Viewing | null>(null)
  const [past, setPast] = useState<readonly AnsweredNote[]>([])
  const [detail, setDetail] = useState<AnsweredNoteDetail | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!hidden) panelRef.current?.focus({ preventScroll: true })
  }, [focusRequest, hidden])

  // 過去の回答を読む（開いたとき・絞り方を変えたとき・質問が終わったとき（付箋に書いた答えが届くのを待って、もう一度））
  const here = editor.canvasId
  useEffect(() => {
    if (hidden) return
    let stale = false
    const load = () =>
      void claude.answeredNotes(filter === 'here' ? here : undefined).then(
        (list) => !stale && setPast(list),
        () => undefined,
      )
    load()
    const timer = window.setTimeout(load, REFETCH_AFTER_DONE_MS)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [claude, hidden, filter, here, state.finishedQuestions])

  // ほかの Canvas の答えを見ているときは、サーバーから読む
  useEffect(() => {
    if (hidden || !viewing || viewing.canvasId === here) return
    let stale = false
    void claude.answeredNote(viewing.noteId).then(
      (found) => !stale && setDetail(found),
      () => undefined,
    )
    return () => {
      stale = true
    }
  }, [claude, hidden, viewing, here, state.finishedQuestions])

  // 動いている質問があれば、経過時間を数え直す
  const running = state.questions.filter((question) => filter === 'all' || question.canvasId === here)
  const ticking = running.length > 0
  useEffect(() => {
    if (!ticking) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [ticking])

  // 開いている Canvas の答え（Editor から）と、ほかの Canvas の答え（サーバーから）
  const answered = useMemo(() => {
    void nodesVersion
    const local = [...editor.index.nodeIds()].flatMap((id) => {
      const node = editor.getNode(id)
      const answer = aiNoteMeta(node)?.answer
      return node && answer ? [answeredOf(node, answer, here, canvasTitle(here))] : []
    })
    return [...past.filter((item) => item.canvasId !== here), ...local].sort((a, b) => b.answeredAt - a.answeredAt)
  }, [editor, here, past, nodesVersion, canvasTitle])

  // 見ている答え
  const view = viewing ? viewData(viewing) : null
  const viewedAt = view?.answer?.answeredAt
  useEffect(() => {
    if (viewing && viewedAt !== undefined) seen.mark(viewing.noteId, viewedAt)
  }, [seen, viewing, viewedAt])

  function viewData(target: Viewing) {
    const question = state.questions.find((item) => item.noteId === target.noteId && item.canvasId === target.canvasId)
    if (target.canvasId === here) {
      const node = editor.getNode(target.noteId)
      const meta = aiNoteMeta(node)
      const answer = meta?.answer ?? null
      const related: RelatedNote[] = (answer?.related ?? []).flatMap((id) =>
        editor.getNode(id)?.type === 'note' ? [{ id, label: firstLine(questionText(editor, [id]), RELATED_LABEL_LENGTH) }] : [],
      )
      const changed = answer ? questionText(editor, [target.noteId, ...(answer.questionIds ?? [])]) !== answer.question : false
      return { question, meta, answer, related, changed, gone: !node }
    }
    const found = detail?.noteId === target.noteId ? detail : null
    const meta = found ? aiNoteMeta({ id: found.noteId, typeName: 'node', type: 'note', meta: { ai: found.ai } } as unknown as NodeRecord) : null
    return { question, meta, answer: meta?.answer ?? null, related: found?.related ?? [], changed: false, gone: false }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented || e.nativeEvent.isComposing || e.key !== 'Escape') return
    e.preventDefault()
    if (viewing) setViewing(null)
    else onClose()
  }

  const shown = answered.filter((item) => filter === 'all' || item.canvasId === here)
  return (
    <aside
      ref={panelRef}
      className="question-panel"
      aria-label="付箋で聞いた質問"
      hidden={hidden}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      {...{ [OWN_KEYS_ATTRIBUTE]: '' }}
    >
      <div className="claude-panel-header">
        {tabs}
        <button type="button" className="claude-close" onClick={onClose} title="閉じる（Esc）" aria-label="閉じる">
          ×
        </button>
      </div>

      {viewing && view ? (
        <div className="question-detail">
          <div className="question-detail-head">
            <button type="button" className="question-back" onClick={() => setViewing(null)}>
              ← 一覧
            </button>
          </div>
          <div className="question-detail-title">「{view.answer ? firstLine(view.answer.question, QUESTION_LABEL_LENGTH) : (view.question?.label ?? '')}」</div>
          <div className="question-detail-meta">
            <span>
              {canvasTitle(viewing.canvasId)}
              {view.answer ? ` ・ ${timeLabel(view.answer.answeredAt, now)}` : ''}
            </span>
            {modelLabel(state.models, view.question ?? view.answer) && <span className="question-model">{modelLabel(state.models, view.question ?? view.answer)}</span>}
          </div>
          <button type="button" className="question-open-note" onClick={() => onOpenNote(viewing.canvasId, viewing.noteId)} disabled={view.gone}>
            ↗ 付箋へ移動
          </button>
          <AnswerView
            answer={view.answer}
            progress={view.question ?? null}
            questionChanged={view.changed}
            related={view.related}
            onRelated={(id) => onOpenNote(viewing.canvasId, id)}
            {...(canPlace && view.answer && view.meta
              ? {
                  onContinue: () => onContinue(viewing.canvasId, viewing.noteId, view.meta!),
                  onKeep: () => onKeep(viewing.canvasId, viewing.noteId, view.answer!.body),
                }
              : {})}
            {...(view.question ? { onStop: () => void claude.cancelQuestion(view.question!.id).catch(() => undefined) } : {})}
          />
        </div>
      ) : (
        <div className="question-list">
          <select className="question-filter" value={filter} onChange={(e) => setFilter(e.target.value as 'all' | 'here')} aria-label="どの Canvas の質問を出すか">
            <option value="all">すべてのキャンバス</option>
            <option value="here">いま開いているキャンバス</option>
          </select>
          {running.length === 0 && shown.length === 0 && (
            <p className="claude-hint">
              付箋で聞いた質問は、まだありません。付箋に書いて送るか、付箋を右クリックして「Claude に聞く」を選ぶと、ここに並びます（どの Canvas
              で聞いたものも）。
            </p>
          )}
          {running.length > 0 && (
            <section className="question-section">
              <div className="question-section-title">動作中（{running.length}）</div>
              {running.map((question) => (
                <div key={question.id} className="question-row running">
                  <button type="button" className="question-row-main" onClick={() => setViewing({ noteId: question.noteId, canvasId: question.canvasId })}>
                    <span className="claude-spinner" aria-hidden="true" />
                    <span className="question-row-text">
                      <span className="question-row-label">「{question.label}」</span>
                      <span className="question-row-meta">
                        {canvasTitle(question.canvasId)} ・ {elapsedLabel(question.startedAt, now)}
                      </span>
                      <span className="question-row-steps">{stepsLabel(question)}</span>
                    </span>
                  </button>
                  <button type="button" className="question-row-stop" onClick={() => void claude.cancelQuestion(question.id).catch(() => undefined)} title="やめる" aria-label="やめる">
                    ■
                  </button>
                </div>
              ))}
            </section>
          )}
          {shown.length > 0 && (
            <section className="question-section">
              <div className="question-section-title">過去の回答</div>
              {shown.map((item) => {
                const unread = !seen.isSeen(item.noteId, item.answeredAt)
                return (
                  <div key={item.noteId} className={`question-row${unread ? ' unread' : ''}`}>
                    <button type="button" className="question-row-main" onClick={() => setViewing({ noteId: item.noteId, canvasId: item.canvasId })}>
                      <span className="question-row-dot" aria-label={unread ? 'まだ見ていない' : undefined} />
                      <span className="question-row-text">
                        <span className="question-row-label">「{item.question}」</span>
                        <span className="question-row-meta">
                          {item.canvasTitle || canvasTitle(item.canvasId)} ・ {timeLabel(item.answeredAt, now)}
                        </span>
                      </span>
                    </button>
                  </div>
                )
              })}
            </section>
          )}
        </div>
      )}
    </aside>
  )
}

function answeredOf(node: NodeRecord, answer: AiAnswer, canvasId: string, canvasTitle: string): AnsweredNote {
  return {
    noteId: node.id,
    canvasId,
    canvasTitle,
    question: firstLine(answer.question, QUESTION_LABEL_LENGTH),
    model: answer.model,
    ...(answer.effort ? { effort: answer.effort } : {}),
    answeredAt: answer.answeredAt,
  }
}

function modelLabel(catalog: Parameters<typeof settingLabel>[0], source: { model?: string; effort?: string } | null | undefined): string {
  if (!source?.model) return ''
  return settingLabel(catalog, { model: source.model, ...(source.effort ? { effort: source.effort as Effort } : {}) })
}

// ✓ 読む → ● 調べる → 書く（調べなかったら「調べる」は出さない）
function stepsLabel(question: RunningQuestion): string {
  const order = ['read', 'search', 'write'] as const
  const labels = { read: '読む', search: '調べる', write: '書く' }
  const current = order.indexOf(question.step)
  return order
    .flatMap((step, i) => {
      if (step === 'search' && !question.searched && current > i) return []
      return [`${i < current ? '✓ ' : i === current ? '● ' : ''}${labels[step]}`]
    })
    .join(' → ')
}

// 経過時間（「たった今」「2分前」「1時間前」）
function elapsedLabel(time: number, now: number): string {
  const minutes = Math.floor((now - time) / 60_000)
  if (minutes < 1) return 'たった今'
  if (minutes < 60) return `${minutes}分前`
  return `${Math.floor(minutes / 60)}時間前`
}

// 時刻（今日なら「今日 14:20」、昨日なら「昨日」、ほかは「11/15」）
function timeLabel(time: number, now: number): string {
  const date = new Date(time)
  const today = new Date(now)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (time >= startOfToday) return `今日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (time >= startOfToday - 86_400_000) return '昨日'
  return `${date.getMonth() + 1}/${date.getDate()}`
}
