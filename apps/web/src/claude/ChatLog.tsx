import { useEffect, useMemo, useState } from 'react'
import { renderMarkdownToSafeHtml } from '@canvcode/nodes/markdown'
import { AnswerView } from './AnswerView.tsx'
import type { ChatQuestion, ClaudeJob, Effort, ImportedQuestion, JobEvent, ModelCatalog, PermissionAnswer, RunningQuestion } from './claudeClient.ts'
import { settingLabel, settingOf } from './modelChoice.ts'
import { answerOfEvents, groupEvents, groupLabel, runningText, toolLabel, type ToolGroup } from './toolGroups.ts'

// 会話の欄（docs/claude-chat-tab-plan.md の 2）。ジョブごとに、頼んだ文の吹き出しと、Claude の答え。
// - 頼んだ文は右寄せの吹き出し。添えた所は「📍 名前」の札（前のジョブで名前がなければ ref の id）。
//   バックグラウンドの作業が終わって Claude が続けたジョブは、小さな 1 行
// - 文章のあいだに続けて並んだ作業は「▸ 読んだ・調べた 4件」の 1 行にたたむ（押すと開く）。誤りは、たたまずに出す。
//   動いているジョブの最後のまとまりは、たたんだ行の下に最後の 1 行を出す（何をしているかが見えるように）
// - 動いている間は、最後のツールから「キャンバスを編集しています…」のように出し、横に「止める」
// - 答え（そのジョブの文章をつないだもの）にマウスを乗せると、下に「📌 付箋に切り出す」「コピー」と、右にモデルの札
//   （かかった時間と費用はツールチップ）。タッチの端末では、初めから出す。失敗・止めたときは 1 行で出す
// - 付箋から取り込んだ質問（imports）は、そのジョブの頼んだ文の上に「付箋の質問を取り込みました「質問」とその答え ↗ 付箋へ」のカード
// - 会話の質問（入力欄の「質問」で、会話に入れずに聞いたもの。docs/ai-note-tasks-plan.md の E）は、聞いた時刻の位置に、
//   「質問」の印を付けた吹き出しと、答え（Markdown）をそのまま出す。答えを作っている間は、進み具合と考えている中身と「やめる」。
//   答えには「📌 付箋に切り出す」「コピー」とモデルの札。答えられなかった・やめたときは 1 行

export interface ChatLogProps {
  jobs: readonly ClaudeJob[]
  catalog: ModelCatalog | undefined
  // 画面で許可を待っているジョブと、待っている問い合わせの id
  askingJobs: ReadonlySet<string>
  pendingIds: ReadonlySet<string>
  onCancel(job: ClaudeJob): void
  // 付箋に切り出す（全画面のエディタでは渡さない）
  onCutToNote?(job: ClaudeJob, answer: string): void
  // 会話の質問（聞いた順）と、答えを作っているものの進み具合（id → 動いている質問）
  questions?: readonly ChatQuestion[]
  questionProgress?: ReadonlyMap<string, RunningQuestion>
  onStopQuestion?(id: string): void
  // 会話の質問の答えを付箋に切り出す（全画面のエディタでは渡さない）
  onCutQuestion?(question: ChatQuestion): void
  // 取り込んだ質問のカードの ↗（全画面のエディタでは渡さない）
  onOpenImport?(item: ImportedQuestion): void
}

export function ChatLog(props: ChatLogProps) {
  const { jobs, catalog, askingJobs, pendingIds, onCancel, onCutToNote, questions = [], questionProgress, onStopQuestion, onCutQuestion, onOpenImport } = props
  // ジョブと会話の質問を、時刻の順に並べる（同じ時刻ならジョブを先に）
  const items = useMemo(
    () =>
      [...jobs.map((job) => ({ at: job.createdAt, job })), ...questions.map((question) => ({ at: question.createdAt, question }))].sort(
        (a, b) => a.at - b.at || ('job' in a ? -1 : 1) - ('job' in b ? -1 : 1),
      ),
    [jobs, questions],
  )
  return (
    <>
      {items.map((item) =>
        'job' in item ? (
          <JobView
            key={item.job.id}
            job={item.job}
            catalog={catalog}
            asking={askingJobs.has(item.job.id)}
            pendingIds={pendingIds}
            onCancel={() => onCancel(item.job)}
            {...(onCutToNote ? { onCutToNote: (answer: string) => onCutToNote(item.job, answer) } : {})}
            {...(onOpenImport ? { onOpenImport } : {})}
          />
        ) : (
          <QuestionView
            key={item.question.id}
            question={item.question}
            progress={questionProgress?.get(item.question.id) ?? null}
            catalog={catalog}
            {...(onStopQuestion ? { onStop: () => onStopQuestion(item.question.id) } : {})}
            {...(onCutQuestion ? { onCutToNote: () => onCutQuestion(item.question) } : {})}
          />
        ),
      )}
    </>
  )
}

// 会話の質問（会話に入れずに聞いたもの。Web と、キャンバス・ファイルを読むだけのツールを使う）：「質問」の印の吹き出しと、答え
function QuestionView(props: {
  question: ChatQuestion
  progress: RunningQuestion | null
  catalog: ModelCatalog | undefined
  onStop?(): void
  onCutToNote?(): void
}) {
  const { question, progress, catalog, onStop, onCutToNote } = props
  return (
    <div className={`claude-job claude-question ${question.status}`} data-question-id={question.id}>
      <div className="claude-prompt question">
        <div className="claude-prompt-tag" title="会話には入れずに聞いた質問（Web と、キャンバス・ファイルを読むだけのツールを使う）">質問</div>
        <div className="claude-prompt-text">{question.question}</div>
      </div>
      {question.status === 'running' ? (
        <AnswerView
          answer={null}
          progress={progress ?? { step: 'read', searched: false, thinking: '' }}
          questionChanged={false}
          related={[]}
          onRelated={() => undefined}
          {...(onStop ? { onStop } : {})}
        />
      ) : question.status === 'done' && question.body !== undefined ? (
        <>
          <MarkdownText text={question.body} />
          <QuestionActions question={question} answer={question.body} catalog={catalog} {...(onCutToNote ? { onCutToNote } : {})} />
        </>
      ) : question.status === 'done' ? (
        // 答えたと届いたが、答えをまだ読んでいない（読み直している）
        <div className="claude-status">答えを読み込んでいます…</div>
      ) : (
        <div className={`claude-status ${question.status}`}>
          {question.status === 'cancelled' ? 'やめました' : `答えられませんでした${question.error ? `：${question.error}` : ''}`}
        </div>
      )}
    </div>
  )
}

// 会話の質問の答えの操作：「📌 付箋に切り出す」「コピー」と、右にモデルの札
function QuestionActions(props: { question: ChatQuestion; answer: string; catalog: ModelCatalog | undefined; onCutToNote?(): void }) {
  const { question, answer, catalog, onCutToNote } = props
  const [copied, setCopied] = useState<'done' | 'failed' | null>(null)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(null), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])
  return (
    <div className="claude-answer-actions">
      {onCutToNote && (
        <button type="button" className="claude-answer-cut" onClick={onCutToNote} title="この質問と答えを添えた AI 付箋を、いま開いている Canvas に置く（会話には何も足さない）">
          📌 付箋に切り出す
        </button>
      )}
      <button type="button" className="claude-answer-copy" onClick={() => void copyText(answer).then((ok) => setCopied(ok ? 'done' : 'failed'))} title="答えを Markdown のままコピーする">
        {copied === 'done' ? 'コピーしました' : copied === 'failed' ? 'コピーできませんでした' : 'コピー'}
      </button>
      <span className="claude-answer-model" title="会話には入れずに答えた（Web と、キャンバス・ファイルを読むだけのツールを使う）">
        {settingLabel(catalog, { ...(question.model ? { model: question.model } : {}), ...(question.effort ? { effort: question.effort as Effort } : {}) })}
      </span>
    </div>
  )
}

// 取り込んだ付箋の質問（会話の質問）のカード
function ImportCard(props: { item: ImportedQuestion; onOpen?(): void }) {
  const { item, onOpen } = props
  const chat = !!item.questionId
  return (
    <div className="claude-import-card">
      <div className="claude-import-card-head">{chat ? '会話の質問を取り込みました' : '付箋の質問を取り込みました'}</div>
      <div className="claude-import-card-line">
        <span className="claude-import-card-text">
          <strong>「{item.label}」</strong>とその答え
        </span>
        {onOpen && (
        <button type="button" className="claude-link" onClick={onOpen} title={chat ? '質問のタブで、この答えを見る' : 'その Canvas に移って、付箋の横に答えを開く'}>
          ↗ {chat ? '質問へ' : '付箋へ'}
          </button>
        )}
      </div>
    </div>
  )
}

function JobView(props: {
  job: ClaudeJob
  catalog: ModelCatalog | undefined
  asking: boolean
  pendingIds: ReadonlySet<string>
  onCancel(): void
  onCutToNote?(answer: string): void
  onOpenImport?(item: ImportedQuestion): void
}) {
  const { job, catalog, asking, pendingIds, onCancel, onCutToNote, onOpenImport } = props
  const running = job.status === 'running'
  const items = useMemo(() => groupEvents(job.events, running), [job.events, running])
  const answer = useMemo(() => answerOfEvents(job.events), [job.events])
  // 答えの出来事があった問い合わせ（答えのない「尋ねた」を見分けるため）
  const answered = useMemo(() => new Set(job.events.flatMap((event) => (event.kind === 'answer' ? [event.id] : []))), [job.events])
  // 答えのないまま、ジョブもプロセスも終わった（サーバーが落ちたなど）
  const lost = (event: JobEvent) => event.kind === 'ask' && !running && !answered.has(event.id) && !pendingIds.has(event.id)
  return (
    <div className="claude-job" data-job-id={job.id}>
      {job.imports?.map((item, i) => <ImportCard key={i} item={item} {...(onOpenImport ? { onOpen: () => onOpenImport(item) } : {})} />)}
      {job.origin === 'background' ? (
        <div className="claude-wake">{job.prompt}。Claude が続けました</div>
      ) : (
        <div className="claude-prompt">
          <div className="claude-prompt-text">{job.prompt}</div>
          {job.refId && (
            <div className="claude-prompt-ref" title={job.refId}>
              📍 {job.refLabel ?? job.refId}
            </div>
          )}
        </div>
      )}
      {items.map((item, i) =>
        item.kind === 'text' ? (
          <MarkdownText key={i} text={item.text} />
        ) : item.kind === 'error' ? (
          <div key={i} className="claude-error">
            {item.message}
          </div>
        ) : (
          <ToolGroupView key={i} group={item} lost={lost} />
        ),
      )}
      {running ? (
        <div className="claude-status running">
          <span className="claude-spinner" aria-hidden="true" />
          <span className="claude-status-text">{runningText(job.events, asking)}</span>
          <button type="button" className="claude-link" onClick={onCancel}>
            止める
          </button>
        </div>
      ) : job.status === 'done' ? (
        <AnswerActions job={job} answer={answer} catalog={catalog} {...(onCutToNote ? { onCutToNote } : {})} />
      ) : (
        <div className={`claude-status ${job.status}`}>{statusText(job, catalog)}</div>
      )}
    </div>
  )
}

function MarkdownText(props: { text: string }) {
  const html = useMemo(() => renderMarkdownToSafeHtml(props.text), [props.text])
  return <div className="claude-text" dangerouslySetInnerHTML={{ __html: html }} />
}

// 作業のまとまり：「▸ 読んだ・調べた 4件」。押すと 1 行ずつ開く。動いているジョブの最後のまとまりは、閉じていても最後の 1 行を出す
function ToolGroupView(props: { group: ToolGroup; lost(event: JobEvent): boolean }) {
  const { group, lost } = props
  const [open, setOpen] = useState(false)
  const last = group.events[group.events.length - 1]
  return (
    <div className={`claude-tools${open ? ' open' : ''}`}>
      <button type="button" className="claude-tools-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> {groupLabel(group)}
      </button>
      {open ? (
        <div className="claude-tools-list">
          {group.events.map((event, i) => (
            <EventView key={i} event={event} lost={lost(event)} />
          ))}
        </div>
      ) : (
        group.live && last && <EventView event={last} lost={false} />
      )}
    </div>
  )
}

function EventView(props: { event: JobEvent; lost: boolean }) {
  const { event, lost } = props
  if (event.kind === 'tool') {
    return (
      <div className="claude-tool">
        {toolLabel(event.name)}
        {event.detail && <span className="claude-tool-detail">{event.detail}</span>}
      </div>
    )
  }
  if (event.kind === 'denied') return <div className="claude-tool denied">断りました：{event.reason}</div>
  if (event.kind === 'task') return <div className={`claude-tool task ${event.status}`}>{`${TASK_TEXT[event.status]}：${event.description}`}</div>
  if (event.kind === 'ask') {
    return (
      <div className="claude-tool ask">
        許可を求めました{event.agent ? `（サブエージェント「${event.agent}」）` : ''}：<span className="claude-tool-detail">{truncate(event.detail, 200)}</span>
        {lost && '（答えないまま途切れました）'}
      </div>
    )
  }
  if (event.kind === 'answer') return <div className={`claude-tool answer ${event.result}`}>{ANSWER_TEXT[event.result]}</div>
  if (event.kind === 'error') return <div className="claude-error">{event.message}</div>
  return null
}

// 答えの操作：「📌 付箋に切り出す」「コピー」と、右にモデルの札（かかった時間と費用はツールチップ）
function AnswerActions(props: { job: ClaudeJob; answer: string; catalog: ModelCatalog | undefined; onCutToNote?(answer: string): void }) {
  const { job, answer, catalog, onCutToNote } = props
  const [copied, setCopied] = useState<'done' | 'failed' | null>(null)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(null), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])
  const cost = costText(job)
  return (
    <div className="claude-answer-actions">
      {answer && onCutToNote && (
        <button type="button" className="claude-answer-cut" onClick={() => onCutToNote(answer)} title="この答えを添えた AI 付箋を、いま開いている Canvas に置く（会話には何も足さない）">
          📌 付箋に切り出す
        </button>
      )}
      {answer && (
        <button
          type="button"
          className="claude-answer-copy"
          onClick={() => void copyText(answer).then((ok) => setCopied(ok ? 'done' : 'failed'))}
          title="答えを Markdown のままコピーする"
        >
          {copied === 'done' ? 'コピーしました' : copied === 'failed' ? 'コピーできませんでした' : 'コピー'}
        </button>
      )}
      <span className="claude-answer-model" title={cost || undefined} tabIndex={cost ? 0 : undefined}>
        {settingLabel(catalog, settingOf(job))}
      </span>
    </div>
  )
}

// かかった時間と費用（「3.2 秒・$0.05」）
function costText(job: Pick<ClaudeJob, 'durationMs' | 'costUsd'>): string {
  const parts: string[] = []
  if (job.durationMs !== undefined) parts.push(`${(job.durationMs / 1000).toFixed(1)} 秒`)
  if (job.costUsd !== undefined && job.costUsd > 0) parts.push(`$${job.costUsd.toFixed(2)}`)
  return parts.join('・')
}

// 失敗・止めたときの 1 行（かかった時間と費用・選んだモデル）
function statusText(job: ClaudeJob, catalog: ModelCatalog | undefined): string {
  const parts = [costText(job), job.model || job.effort ? settingLabel(catalog, settingOf(job)) : ''].filter(Boolean)
  const detail = parts.length > 0 ? `（${parts.join('・')}）` : ''
  if (job.status === 'cancelled') return `止めました${detail}`
  return `失敗しました${detail}`
}

// クリップボードに載せる（使えなければ、選んだ文字のコピーで）
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    try {
      return document.execCommand('copy')
    } catch {
      return false
    } finally {
      area.remove()
    }
  }
}

const TASK_TEXT = { started: 'バックグラウンドで始めました', completed: '終わりました', failed: '失敗しました', stopped: '止めました' }

const ANSWER_TEXT: Record<PermissionAnswer, string> = {
  allowed: '許可しました',
  denied: '断りました',
  expired: '時間切れで断りました',
  cancelled: '止めたので取り消しました',
}

function truncate(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ')
  return line.length > max ? `${line.slice(0, max)}…` : line
}
