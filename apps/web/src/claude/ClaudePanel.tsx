import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { renderMarkdownToSafeHtml } from '@canvcode/nodes/markdown'
import { threadsOf, useClaudeState, type ClaudeClient, type ClaudeJob, type JobEvent } from './claudeClient.ts'

// 画面から Claude Code に頼むパネル（キャンバスの右に並べる）。
// - 1 つの会話（thread）を見せる。送ると、その会話の続きとして頼む（「新しい会話」で切る）
// - 選んでいる場所（ref）を添えられる。右クリックの「Claude に頼む…」で開くと、選んでいた場所が添えてある
// - Canvas の編集は、ほかの AI の編集と同じく画面の下に「AI：…［元に戻す］」が出る（AgentToasts）

// 添える場所。refId が null の間は保存している
export interface ClaudeAttachment {
  label: string
  refId: string | null
}

interface Props {
  client: ClaudeClient
  canvasId: string
  attachment: ClaudeAttachment | null
  // 増えたら入力欄にフォーカスする
  focusRequest: number
  onAttachSelection(): void
  onClearAttachment(): void
  onClose(): void
}

export function ClaudePanel(props: Props) {
  const { client, canvasId, attachment, focusRequest, onAttachSelection, onClearAttachment, onClose } = props
  const { jobs } = useClaudeState(client)
  const threads = useMemo(() => threadsOf(jobs.values()), [jobs])
  // 見ている会話。null は新しい会話
  const [threadId, setThreadId] = useState<string | null>(() => threads[0]?.threadId ?? null)
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => client.connect(), [client])
  useEffect(() => inputRef.current?.focus({ preventScroll: true }), [focusRequest])

  const thread = threads.find((t) => t.threadId === threadId)
  const running = thread?.jobs.find((job) => job.status === 'running')
  const eventTotal = thread?.jobs.reduce((n, job) => n + job.events.length, 0) ?? 0

  // 新しい出来事が来たら下までスクロールする（読み返しているとき＝下から離れているときは動かさない）
  const stick = useRef(true)
  useEffect(() => {
    const log = logRef.current
    if (log && stick.current) log.scrollTop = log.scrollHeight
  }, [eventTotal, thread?.jobs.length, threadId])

  const send = () => {
    const text = prompt.trim()
    if (!text || sending || running || attachment?.refId === null) return
    setSending(true)
    setError(null)
    client
      .start({ prompt: text, canvasId, ...(attachment?.refId ? { refId: attachment.refId } : {}), ...(thread ? { threadId: thread.threadId } : {}) })
      .then((job) => {
        setPrompt('')
        setThreadId(job.threadId)
        stick.current = true
        onClearAttachment()
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSending(false))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter は改行。Ctrl（⌘）+Enter で送る。変換中の Enter は IME に任せる
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <aside className="claude-panel" aria-label="Claude">
      <div className="claude-panel-header">
        <strong>Claude</strong>
        <select
          className="claude-thread-select"
          value={threadId ?? ''}
          onChange={(e) => setThreadId(e.target.value || null)}
          title="会話を選ぶ（サーバーを再起動すると消えます）"
        >
          <option value="">新しい会話</option>
          {threads.map((t) => (
            <option key={t.threadId} value={t.threadId}>
              {truncate(t.jobs[0].prompt, 28)}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => setThreadId(null)} title="新しい会話を始める">
          新規
        </button>
        <button type="button" className="claude-close" onClick={onClose} title="閉じる（Esc）" aria-label="閉じる">
          ×
        </button>
      </div>

      <div
        className="claude-log"
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {!thread && (
          <p className="claude-hint">
            キャンバスを選んで右クリックの「Claude に頼む…」（Ctrl+Alt+Enter）で、選んだ場所を添えて頼めます。
            Claude は CanvCode の MCP で Canvas と文書を読み書きします（シェルは使えません）。
          </p>
        )}
        {thread?.jobs.map((job) => <JobView key={job.id} job={job} onCancel={() => void client.cancel(job.id)} />)}
      </div>

      <div className="claude-compose">
        {attachment ? (
          <div className="claude-attachment">
            <span>{attachment.refId === null ? `${attachment.label}（保存中…）` : `添付：${attachment.label}`}</span>
            <button type="button" onClick={onClearAttachment} aria-label="添付を外す" title="添付を外す">
              ×
            </button>
          </div>
        ) : (
          <button type="button" className="claude-attach" onClick={onAttachSelection} title="選んでいるノード（直前の範囲選択）を添える">
            ＋ 選んでいる所を添える
          </button>
        )}
        <textarea
          ref={inputRef}
          value={prompt}
          rows={3}
          placeholder={thread ? '続けて頼む…' : 'Claude に頼む…'}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {error && <div className="claude-error">{error}</div>}
        <div className="claude-compose-actions">
          {running && (
            <button type="button" onClick={() => void client.cancel(running.id)}>
              止める
            </button>
          )}
          <button
            type="button"
            className="claude-send"
            disabled={!prompt.trim() || sending || !!running || attachment?.refId === null}
            onClick={send}
            title="送る（Ctrl+Enter）"
          >
            送る
          </button>
        </div>
      </div>
    </aside>
  )
}

function JobView(props: { job: ClaudeJob; onCancel(): void }) {
  const { job, onCancel } = props
  return (
    <div className="claude-job">
      <div className="claude-prompt">
        <div className="claude-prompt-text">{job.prompt}</div>
        {job.refId && <div className="claude-prompt-ref">選んだ場所：{job.refId}</div>}
      </div>
      {job.events.map((event, i) => (
        <EventView key={i} event={event} />
      ))}
      <div className={`claude-status ${job.status}`}>
        {job.status === 'running' ? (
          <>
            <span className="claude-spinner" aria-hidden="true" />
            考えています…
            <button type="button" className="claude-link" onClick={onCancel}>
              止める
            </button>
          </>
        ) : (
          statusText(job)
        )}
      </div>
    </div>
  )
}

function EventView(props: { event: JobEvent }) {
  const { event } = props
  const html = useMemo(() => (event.kind === 'text' ? renderMarkdownToSafeHtml(event.text) : ''), [event])
  if (event.kind === 'text') return <div className="claude-text" dangerouslySetInnerHTML={{ __html: html }} />
  if (event.kind === 'tool') {
    return (
      <div className="claude-tool">
        {toolLabel(event.name)}
        {event.detail && <span className="claude-tool-detail">{event.detail}</span>}
      </div>
    )
  }
  if (event.kind === 'denied') return <div className="claude-tool denied">断りました：{event.reason}</div>
  return <div className="claude-error">{event.message}</div>
}

const TOOL_LABELS: Record<string, string> = {
  Read: 'ファイルを読む',
  Write: 'ファイルを書く',
  Edit: 'ファイルを直す',
  Glob: 'ファイルを探す',
  Grep: '中身を探す',
  WebSearch: 'Web を検索',
  WebFetch: 'Web のページを読む',
  list_documents: '文書の一覧',
  read_document: '文書を読む',
  create_document: '文書を作る',
  update_document: '文書を書き換える',
  edit_document: '文書を直す',
  resolve_reference: '選んだ場所を読む',
  get_canvas_format: 'Canvas の書き方を読む',
  list_canvases: 'Canvas の一覧',
  read_canvas: 'Canvas を読む',
  read_nodes: 'ノードを読む',
  edit_canvas: 'Canvas を編集',
  undo_canvas_edit: '編集を取り消す',
}

function toolLabel(name: string): string {
  const short = name.replace(/^mcp__canvcode__/, '')
  return TOOL_LABELS[short] ?? short
}

function statusText(job: ClaudeJob): string {
  const parts: string[] = []
  if (job.durationMs !== undefined) parts.push(`${(job.durationMs / 1000).toFixed(1)} 秒`)
  if (job.costUsd !== undefined && job.costUsd > 0) parts.push(`$${job.costUsd.toFixed(2)}`)
  const detail = parts.length > 0 ? `（${parts.join('・')}）` : ''
  if (job.status === 'done') return `完了${detail}`
  if (job.status === 'cancelled') return `止めました${detail}`
  return `失敗しました${detail}`
}

function truncate(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ')
  return line.length > max ? `${line.slice(0, max)}…` : line
}
