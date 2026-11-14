import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { OWN_KEYS_ATTRIBUTE } from '@canvcode/canvas'
import { renderMarkdownToSafeHtml } from '@canvcode/nodes/markdown'
import {
  jobsOfThread,
  useClaudeState,
  type BackgroundTask,
  type ClaudeClient,
  type ClaudeJob,
  type ModelCatalog,
  type JobEvent,
  type PendingPermission,
  type PermissionAnswer,
} from './claudeClient.ts'
import { ModelPicker } from './ModelPicker.tsx'
import { jobSettingLabel, loadSetting, sameSetting, saveSetting, settingOf, type ModelSetting } from './modelChoice.ts'

// 画面から Claude Code に頼むパネル（キャンバスの右に並べる）。
// - 1 つの会話（thread）を見せる。送ると、その会話の続きとして頼む（「新規」で切る）。会話はサーバーの SQLite に残り、
//   上の一覧から前の会話に戻れる（中身は選んだときに読む）。開いたときは、少し前（RECENT_MS 以内）に動いた会話を見せる
// - 選んでいる場所（ref）を添えられる。右クリックの「Claude に頼む…」で開くと、選んでいた場所が添えてある
// - Claude Code が許可を求めてきた呼び出し（auto mode が決められなかった Bash など）は、入力欄の上（作業の一覧の上）に並べ、
//   「断る」「許可する」で答える。1 つのキーでは許可しない（許可のボタンにフォーカスを置かない）。答えないと、サーバーがしばらくして断る
// - バックグラウンドで動いている作業（サブエージェント・コマンド）は入力欄の上に並べ、1 つずつ止められる。「全部止める」は会話のプロセスごと止める
//   （2 回押す）。作業が動いていても送れる（答えを書いている最中だけ送れない）。作業が終わって Claude が自分で続けたジョブは、吹き出しでなく小さく見せる
// - Canvas の編集は、ほかの AI の編集と同じく画面の下に「AI：…［元に戻す］」が出る（AgentToasts）
// - パネルの中のキー入力は、キャンバスのショートカットに渡さない（data-own-keys）。押したらパネルにフォーカスを移すので、
//   回答を選んで Delete や矢印キーを押しても、キャンバスで選んでいるノードは消えも動きもしない
// - 送るボタンの横で、モデルと effort を選べる（MAI-106。ModelPicker）。会話ごとに覚え（前の会話を開くと、その会話の最後の依頼の値に戻る）、
//   新しい会話は、ブラウザに覚えた最後に選んだ値から始める。終わった依頼の行に、選んで頼んだモデルと effort を添える

// 添える場所。refId が null の間は保存している
export interface ClaudeAttachment {
  label: string
  refId: string | null
}

const RECENT_MS = 30 * 60_000
const NO_TASKS: readonly BackgroundTask[] = []
const NO_PERMISSIONS: readonly PendingPermission[] = []

interface Props {
  client: ClaudeClient
  canvasId: string
  attachment: ClaudeAttachment | null
  // 増えたら入力欄にフォーカスする
  focusRequest: number
  // 入力欄に入れておく頼み方の下書き（n が変わるたびに入れ直す。「グラフを作る」の「Claude におまかせ」）
  draft?: { text: string; n: number } | null
  // パネルが見えている置き場所（MAI-102。App がパネルの DOM をキャンバスの右と全画面のエディタの右半分の間で移す）。
  // 変わったら、会話の欄と入力欄のスクロールを戻す（DOM を移すと先頭に戻り、scroll イベントも来ないため）
  placement?: Element | null
  onAttachSelection(): void
  onClearAttachment(): void
  onClose(): void
}

export function ClaudePanel(props: Props) {
  const { client, canvasId, attachment, focusRequest, draft, placement, onAttachSelection, onClearAttachment, onClose } = props
  const state = useClaudeState(client)
  const { threads } = state
  // 選んだ会話。null は新しい会話
  const [chosenId, setThreadId] = useState<string | null>(() => {
    const latest = client.state.threads[0]
    return latest && (latest.running || Date.now() - latest.updatedAt < RECENT_MS) ? latest.threadId : null
  })
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 「削除」を 1 回押した会話（もう 1 回押すと消す）
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  // 「全部止める」を 1 回押した会話（もう 1 回押すと止める）
  const [confirmStop, setConfirmStop] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => client.connect(), [client])
  useEffect(() => void client.loadModels(), [client, state.availability])
  useEffect(() => inputRef.current?.focus({ preventScroll: true }), [focusRequest])
  // 新しい下書きが来たら入力欄に入れる（描画の中で前の値と比べる。React の「props が変わったら state を合わせる」書き方）。
  // 閉じていたパネルは下書きと一緒に開く（初めから下書きがある）ので、null から比べて、開いたときも入れる
  const [seenDraft, setSeenDraft] = useState<typeof draft>(null)
  if (draft !== seenDraft) {
    setSeenDraft(draft)
    if (draft) setPrompt(draft.text)
  }

  // 見ている会話。選んだ会話が消されていれば、新しい会話
  const thread = threads.find((t) => t.threadId === chosenId)
  const threadId = thread ? thread.threadId : null
  // 次に送るときのモデルと effort（MAI-106）。会話を替えたら、その会話の値（新しい会話ならブラウザに覚えた値）にする
  const [setting, setSetting] = useState<ModelSetting>(() => (thread ? settingOf(thread) : loadSetting()))
  const [settingFor, setSettingFor] = useState<string | null>(threadId)
  if (settingFor !== threadId) {
    setSettingFor(threadId)
    const next = thread ? settingOf(thread) : loadSetting()
    if (!sameSetting(next, setting)) setSetting(next)
  }
  const chooseSetting = (next: ModelSetting) => {
    setSetting(next)
    saveSetting(next)
  }
  // 見ている会話の中身を読む（つなぎ直したあとも読み直す）
  useEffect(() => {
    if (threadId && !state.loaded.has(threadId)) void client.loadThread(threadId)
  }, [client, threadId, state.loaded])
  // 作業の知らせを受けただけで何も書かなかったターン（サブエージェントの報告のあとに CLI が起こす）は見せない
  const jobs = useMemo(
    () => (threadId ? jobsOfThread(state, threadId).filter((job) => !(job.origin === 'background' && job.status !== 'running' && job.events.length === 0)) : []),
    [state, threadId],
  )
  const running = jobs.find((job) => job.status === 'running')
  const tasks = thread?.tasks ?? NO_TASKS
  const permissions = thread?.permissions ?? NO_PERMISSIONS
  // 答えを書いているか、バックグラウンドの作業か、許可を待っている問い合わせがある（消せない）
  const busy = !!thread && (thread.running || tasks.length > 0 || permissions.length > 0)
  // 答えを送っている問い合わせ（SSE で一覧から消えるまで、ボタンを押せなくする）
  const [answering, setAnswering] = useState<ReadonlySet<string>>(() => new Set())
  // 待っている問い合わせの id と、許可を待っているジョブ（jobs と同じく state から読む。React Compiler が手書きの useMemo を保てるように）
  const waiting = useMemo(() => {
    const found = state.threads.find((t) => t.threadId === threadId)?.permissions ?? []
    return { ids: new Set(found.map((p) => p.id)), jobs: new Set(found.flatMap((p) => (p.jobId ? [p.jobId] : []))) }
  }, [state, threadId])
  const eventTotal = jobs.reduce((n, job) => n + job.events.length, 0)

  // 新しい出来事が来たら下までスクロールする（読み返しているとき＝下から離れているときは動かさない）
  const stick = useRef(true)
  // 最後にスクロールした位置（置き場所が変わったら戻す。MAI-102）
  const scrolled = useRef({ log: 0, input: 0 })
  useEffect(() => {
    if (!placement) return
    const log = logRef.current
    if (log) log.scrollTop = stick.current ? log.scrollHeight : scrolled.current.log
    if (inputRef.current) inputRef.current.scrollTop = scrolled.current.input
  }, [placement])
  useEffect(() => {
    const log = logRef.current
    if (log && stick.current) log.scrollTop = log.scrollHeight
  }, [eventTotal, jobs.length, threadId])

  const send = () => {
    const text = prompt.trim()
    if (!text || sending || running || attachment?.refId === null) return
    setSending(true)
    setError(null)
    client
      .start({
        prompt: text,
        canvasId,
        ...(attachment?.refId ? { refId: attachment.refId } : {}),
        ...(thread ? { threadId: thread.threadId } : {}),
        ...settingOf(setting),
      })
      .then((job) => {
        setPrompt('')
        setThreadId(job.threadId)
        stick.current = true
        onClearAttachment()
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSending(false))
  }

  const remove = () => {
    if (!thread) return
    if (confirmDelete !== thread.threadId) {
      setConfirmDelete(thread.threadId)
      return
    }
    setConfirmDelete(null)
    client
      .deleteThread(thread.threadId)
      .then(() => setThreadId(null))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  const stopAll = () => {
    if (!thread) return
    if (confirmStop !== thread.threadId) {
      setConfirmStop(thread.threadId)
      return
    }
    setConfirmStop(null)
    client.stopThread(thread.threadId).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  const stopTask = (task: BackgroundTask) => {
    if (!thread) return
    client.stopTask(thread.threadId, task.id).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  const answer = (permission: PendingPermission, decision: 'allow' | 'deny') => {
    if (!thread || answering.has(permission.id)) return
    setAnswering((ids) => new Set(ids).add(permission.id))
    setError(null)
    client.answerPermission(thread.threadId, permission.id, decision).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e))
      // 送れなかったら、また押せるようにする（もう待っていない 404 なら、SSE で一覧から消える）
      setAnswering((ids) => {
        const next = new Set(ids)
        next.delete(permission.id)
        return next
      })
    })
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

  // 入力欄の外のキー（入力欄の中は onKeyDown が扱う）。Esc で閉じる。Ctrl（⌘）+A は、ページ全体ではなく会話の欄の文字を選ぶ
  const onPanelKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented || e.nativeEvent.isComposing) return
    if (e.target instanceof Element && e.target.closest('textarea, input')) return
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a' && logRef.current) {
      e.preventDefault()
      document.getSelection()?.selectAllChildren(logRef.current)
    }
  }

  return (
    <aside className="claude-panel" aria-label="Claude" tabIndex={-1} onKeyDown={onPanelKeyDown} {...{ [OWN_KEYS_ATTRIBUTE]: '' }}>
      <div className="claude-panel-header">
        <strong>Claude</strong>
        <select
          className="claude-thread-select"
          value={threadId ?? ''}
          onChange={(e) => {
            setThreadId(e.target.value || null)
            setConfirmDelete(null)
            stick.current = true
          }}
          title="前の会話に戻る"
        >
          <option value="">新しい会話</option>
          {threads.map((t) => (
            <option key={t.threadId} value={t.threadId}>
              {t.running || (t.tasks?.length ?? 0) > 0 || (t.permissions?.length ?? 0) > 0 ? '● ' : ''}
              {truncate(t.title, 28)}
              {(t.permissions?.length ?? 0) > 0 ? '・許可待ち' : ''}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => setThreadId(null)} title="新しい会話を始める">
          新規
        </button>
        {thread && (
          <button
            type="button"
            className={confirmDelete === thread.threadId ? 'claude-danger' : undefined}
            disabled={busy}
            onClick={remove}
            onBlur={() => setConfirmDelete(null)}
            title={busy ? '動いている依頼と作業を止めてから消せます' : 'この会話を消す（もう一度押すと消します）'}
          >
            {confirmDelete === thread.threadId ? '消す' : '削除'}
          </button>
        )}
        <button type="button" className="claude-close" onClick={onClose} title="閉じる（Esc）" aria-label="閉じる">
          ×
        </button>
      </div>

      <div
        className="claude-log"
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget
          scrolled.current.log = el.scrollTop
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {!thread && (
          <p className="claude-hint">
            キャンバスを選んで右クリックの「Claude に頼む…」（Ctrl+Alt+Enter）で、選んだ場所を添えて頼めます。
            Claude は CanvCode の MCP で Canvas と文書を読み書きします。コマンド（Bash）は、Claude Code の auto mode
            が危なくないと判断したものを動かし、判断できなかったものはここで許可を求めます。
          </p>
        )}
        {thread && jobs.length === 0 && <p className="claude-hint">読み込んでいます…</p>}
        {jobs.map((job) => (
          <JobView
            key={job.id}
            job={job}
            catalog={state.models}
            asking={waiting.jobs.has(job.id)}
            pendingIds={waiting.ids}
            onCancel={() => void client.cancel(job.id)}
          />
        ))}
      </div>

      {thread && permissions.length > 0 && <PermissionList permissions={permissions} answering={answering} onAnswer={answer} />}

      {thread && tasks.length > 0 && (
        <TaskList tasks={tasks} confirmStop={confirmStop === thread.threadId} onStop={stopTask} onStopAll={stopAll} onBlurStopAll={() => setConfirmStop(null)} />
      )}

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
          onScroll={(e) => (scrolled.current.input = e.currentTarget.scrollTop)}
          onKeyDown={onKeyDown}
        />
        {error && <div className="claude-error">{error}</div>}
        <div className="claude-compose-actions">
          {running && (
            <button type="button" onClick={() => void client.cancel(running.id)}>
              止める
            </button>
          )}
          <ModelPicker catalog={state.models} setting={setting} onChange={chooseSetting} />
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

// 画面で許可を待っている問い合わせ（古いものが上）。断る判断の材料なので、コマンドは切らずに全部出す。
// 許可のボタンにはフォーカスを置かず、1 つのキーで許可できるようにはしない。残りの時間は 15 秒ごとに描き直す
function PermissionList(props: {
  permissions: readonly PendingPermission[]
  answering: ReadonlySet<string>
  onAnswer(permission: PendingPermission, decision: 'allow' | 'deny'): void
}) {
  const { permissions, answering, onAnswer } = props
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [])
  return (
    <div className="claude-permissions" role="region" aria-label="許可を待っています">
      <div className="claude-permissions-header">許可を待っています（{permissions.length}）</div>
      {permissions.map((permission) => (
        <div key={permission.id} className="claude-permission">
          <div className="claude-permission-title">
            <strong>{permission.name === 'Bash' ? 'コマンドを実行' : toolLabel(permission.name)}</strong>
            <span className="claude-permission-left">{leftText(permission.expiresAt - now)}</span>
          </div>
          <pre className="claude-permission-detail">{permission.detail}</pre>
          {permission.description && <div className="claude-permission-note">{permission.description}</div>}
          {permission.agent && <div className="claude-permission-note">サブエージェント「{permission.agent}」から</div>}
          {permission.reason && <div className="claude-permission-note">{permission.reason}</div>}
          <div className="claude-permission-actions">
            <button type="button" disabled={answering.has(permission.id)} onClick={() => onAnswer(permission, 'deny')}>
              断る
            </button>
            <button type="button" className="claude-allow" disabled={answering.has(permission.id)} onClick={() => onAnswer(permission, 'allow')}>
              許可する
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

// 断るまでの残りの時間
function leftText(ms: number): string {
  if (ms <= 0) return 'まもなく断ります'
  if (ms < 60_000) return `あと ${Math.ceil(ms / 1000)} 秒で断ります`
  return `あと ${Math.ceil(ms / 60_000)} 分で断ります`
}

// バックグラウンドで動いている作業の一覧
function TaskList(props: {
  tasks: readonly BackgroundTask[]
  confirmStop: boolean
  onStop(task: BackgroundTask): void
  onStopAll(): void
  onBlurStopAll(): void
}) {
  const { tasks, confirmStop, onStop, onStopAll, onBlurStopAll } = props
  return (
    <div className="claude-tasks" aria-label="バックグラウンドの作業">
      <div className="claude-tasks-header">
        <span className="claude-spinner" aria-hidden="true" />
        <span>バックグラウンドで動いている作業（{tasks.length}）</span>
        <button
          type="button"
          className={confirmStop ? 'claude-danger' : 'claude-link'}
          onClick={onStopAll}
          onBlur={onBlurStopAll}
          title="答えも作業も、この会話の Claude Code をまるごと止める（もう一度押すと止めます）"
        >
          {confirmStop ? '本当に全部止める' : '全部止める'}
        </button>
      </div>
      {tasks.map((task) => (
        <div key={task.id} className="claude-task">
          <span className="claude-task-name" title={task.description}>
            {taskTypeLabel(task.type)}：{task.description}
          </span>
          <button type="button" className="claude-link" onClick={() => onStop(task)} title="この作業だけを止める">
            止める
          </button>
        </div>
      ))}
    </div>
  )
}

// asking は、このジョブが画面で許可を待っているか。pendingIds は、会話で答えを待っている問い合わせの id
function JobView(props: { job: ClaudeJob; catalog: ModelCatalog | undefined; asking: boolean; pendingIds: ReadonlySet<string>; onCancel(): void }) {
  const { job, catalog, asking, pendingIds, onCancel } = props
  // 答えの出来事があった問い合わせ（答えのない「尋ねた」を見分けるため）
  const answered = useMemo(() => new Set(job.events.flatMap((event) => (event.kind === 'answer' ? [event.id] : []))), [job.events])
  return (
    <div className="claude-job">
      {job.origin === 'background' ? (
        <div className="claude-wake">{job.prompt}。Claude が続けました</div>
      ) : (
        <div className="claude-prompt">
          <div className="claude-prompt-text">{job.prompt}</div>
          {job.refId && <div className="claude-prompt-ref">選んだ場所：{job.refId}</div>}
        </div>
      )}
      {job.events.map((event, i) => (
        <EventView
          key={i}
          event={event}
          // 答えのないまま、ジョブもプロセスも終わった（サーバーが落ちたなど）
          lost={event.kind === 'ask' && job.status !== 'running' && !answered.has(event.id) && !pendingIds.has(event.id)}
        />
      ))}
      <div className={`claude-status ${job.status}`}>
        {job.status === 'running' ? (
          <>
            <span className="claude-spinner" aria-hidden="true" />
            {asking ? '許可を待っています…' : '考えています…'}
            <button type="button" className="claude-link" onClick={onCancel}>
              止める
            </button>
          </>
        ) : (
          statusText(job, jobSettingLabel(catalog, job))
        )}
      </div>
    </div>
  )
}

function EventView(props: { event: JobEvent; lost?: boolean }) {
  const { event, lost } = props
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
  if (event.kind === 'task') return <div className={`claude-tool task ${event.status}`}>{taskText(event)}</div>
  if (event.kind === 'ask') {
    return (
      <div className="claude-tool ask">
        許可を求めました{event.agent ? `（サブエージェント「${event.agent}」）` : ''}：
        <span className="claude-tool-detail">{truncate(event.detail, 200)}</span>
        {lost && '（答えないまま途切れました）'}
      </div>
    )
  }
  if (event.kind === 'answer') return <div className={`claude-tool answer ${event.result}`}>{ANSWER_TEXT[event.result]}</div>
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
  Agent: 'サブエージェントに任せる',
  Skill: 'スキルを使う',
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

const TASK_TEXT = { started: 'バックグラウンドで始めました', completed: '終わりました', failed: '失敗しました', stopped: '止めました' }

const ANSWER_TEXT: Record<PermissionAnswer, string> = {
  allowed: '許可しました',
  denied: '断りました',
  expired: '時間切れで断りました',
  cancelled: '止めたので取り消しました',
}

function taskText(event: Extract<JobEvent, { kind: 'task' }>): string {
  return `${TASK_TEXT[event.status]}：${event.description}`
}

function taskTypeLabel(type: string): string {
  if (type === 'local_agent') return 'サブエージェント'
  if (type === 'local_bash') return 'コマンド'
  return '作業'
}

// model は、選んで頼んだモデルと effort（既定なら添えない。MAI-106）
function statusText(job: ClaudeJob, model: string | undefined): string {
  const parts: string[] = []
  if (job.durationMs !== undefined) parts.push(`${(job.durationMs / 1000).toFixed(1)} 秒`)
  if (job.costUsd !== undefined && job.costUsd > 0) parts.push(`$${job.costUsd.toFixed(2)}`)
  if (model) parts.push(model)
  const detail = parts.length > 0 ? `（${parts.join('・')}）` : ''
  if (job.status === 'done') return `完了${detail}`
  if (job.status === 'cancelled') return `止めました${detail}`
  return `失敗しました${detail}`
}

function truncate(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ')
  return line.length > max ? `${line.slice(0, max)}…` : line
}
