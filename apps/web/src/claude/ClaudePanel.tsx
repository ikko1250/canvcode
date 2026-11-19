import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { OWN_KEYS_ATTRIBUTE, firstLine, fitTurns } from '@canvcode/canvas'
import { AnswerError, requestAnswer, type AnswerRequest } from './answer.ts'
import { ChatComposer, type ComposeMode } from './ChatComposer.tsx'
import { ChatHeader } from './ChatHeader.tsx'
import { ChatLog } from './ChatLog.tsx'
import {
  chatThreads,
  jobsOfThread,
  questionsOfThread,
  useClaudeState,
  type BackgroundTask,
  type ClaudeClient,
  type ChatQuestion,
  type ClaudeJob,
  type ImportedQuestion,
  type PendingPermission,
} from './claudeClient.ts'
import { loadSetting, sameSetting, saveSetting, settingOf, type ModelSetting } from './modelChoice.ts'
import { answerOfEvents, toolLabel } from './toolGroups.ts'

// 画面から Claude Code に頼むチャット（キャンバスの右に並べる）。
// - キャンバスでは、右上の「質問」と C で開くのは質問のタブ（QuestionPanel）で、会話（このチャット）は上の「会話｜質問」のタブで行き来する。
//   「Claude に頼む…」（Ctrl+Alt+Enter）・全画面のエディタの「Claude」は、チャットを直接開く（全画面のエディタでは、タブを出さない）
// - 1 つの会話（thread）を見せる。送ると、その会話の続きとして頼む（上の ＋ で切る）。会話はサーバーの SQLite に残り、
//   題の ▾ で開く一覧から前の会話に戻れる（中身は選んだときに読む）。開いたときは、少し前（RECENT_MS 以内）に動いた会話を見せる。
//   上の並び（ChatHeader）・会話の欄（ChatLog）・入力欄（ChatComposer）に分ける（docs/claude-chat-tab-plan.md）
// - 選んでいる場所（ref）を添えられる。右クリックの「Claude に頼む…」で開くと、選んでいた場所が添えてある
// - Claude Code が許可を求めてきた呼び出し（auto mode が決められなかった Bash など）は、入力欄のすぐ上に警告の色のカードで並べ、
//   「断る」「許可する」で答える。1 つのキーでは許可しない（許可のボタンにフォーカスを置かない）。答えないと、サーバーがしばらくして断る
// - バックグラウンドで動いている作業（サブエージェント・コマンド）は「⚙ 動作中の作業 N件 ▾」の 1 行にたたみ、開くと 1 つずつ止められる。
//   「全部止める」は会話のプロセスごと止める（2 回押す）。作業が動いていても送れる（答えを書いている最中だけ送れない）。
//   作業が終わって Claude が自分で続けたジョブは、吹き出しでなく小さく見せる
// - Canvas の編集は、ほかの AI の編集と同じく画面の下に「AI：…［元に戻す］」が出る（AgentToasts）
// - パネルの中のキー入力は、キャンバスのショートカットに渡さない（data-own-keys）。押したらパネルにフォーカスを移すので、
//   回答を選んで Delete や矢印キーを押しても、キャンバスで選んでいるノードは消えも動きもしない
// - 送るボタンの横で、モデルと effort を選べる（MAI-106。ModelPicker）。会話ごとに覚え（前の会話を開くと、その会話の最後の依頼の値に戻る）、
//   新しい会話は、ブラウザに覚えた最後に選んだ値から始める。答えの右に、頼んだモデルと effort の札を出す
// - 答えの「📌 付箋に切り出す」（キャンバスでだけ）：その答えを添えた AI 付箋を、いま開いている Canvas に置く（onCutToNote。会話には何も足さない）。
//   付箋の札の ↗ で戻ってきたら（reveal）、その会話を選び、そのジョブまでスクロールして、少しのあいだ色を付ける
// - 付箋の質問を取り込む（答えの「会話で続ける」。importRequest）：入力欄の上に「付箋の質問を取り込みます「質問」 ×」の札を置く。
//   取り込むだけでは Claude を動かさず、次に送る文と一緒に渡す（imports）。取り込めるのは 1 度に 1 つ。会話の欄には、そのジョブの頼んだ文の上にカードを出す
// - 入力欄の「会話｜質問」（キャンバスでだけ）：「質問」で送ると、その 1 つだけ会話に入れずに聞く（POST /api/claude/answer。Web だけを使い、
//   前の答えとして、会話の最後の終わったジョブを添える）。送っても「質問」のまま（docs/ai-note-tasks-plan.md の E）。会話の欄に、聞いた時刻の位置で
//   質問と答えをそのまま出す（答えを作っている間は進み具合と考えている中身と「やめる」）。会話を選ばずに聞いたら、サーバーが新しい会話を作り、それを選ぶ

// 添える場所。refId が null の間は保存している
export interface ClaudeAttachment {
  label: string
  refId: string | null
}

// 付箋に切り出す会話の答え（App が会話の札を添えた AI 付箋を置く）。会話の質問の答えなら、jobId の代わりに questionId と、添えた前の答え
export interface ChatAnswerCut {
  threadId: string
  jobId?: string
  questionId?: string
  // 会話の題
  title: string
  // 頼んだ文と答え（Markdown）
  question: string
  answer: string
  previous?: { question: string; answer: string }[]
}

// 付箋の質問を取り込む（答えの「会話で続ける」）。newThread なら新しい会話にし、そうでなければ threadId の会話（メニューに出した「いまの会話」）に入れる。
// n が変わるたびに取り込む
export interface ChatImportRequest {
  item: ImportedQuestion
  newThread: boolean
  threadId?: string
  n: number
}

// 会話のそのジョブ（会話の質問なら、そのカード）へ戻る（付箋の会話の札の ↗・質問のタブの「↗ 会話へ移動」）。n が変わるたびに戻る
export interface ChatReveal {
  threadId: string
  jobId?: string
  questionId?: string
  n: number
}

const RECENT_MS = 30 * 60_000
// 戻ったジョブに色を付けておく時間
const HIGHLIGHT_MS = 2400
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
  // パネルが見えている置き場所（MAI-102。App がパネルの DOM をキャンバスの右と全画面のエディタの右半分の間で移す。隠しているなら null）。
  // 変わったら、会話の欄と入力欄のスクロールを戻す（DOM を移したり隠したりすると先頭に戻り、scroll イベントも来ないため）
  placement?: Element | null
  // 隠しているか（付箋の答えのパネルを見せている間。閉じずに隠すので、書きかけの文と選んでいた会話が残る）
  hidden?: boolean
  onAttachSelection(): void
  onClearAttachment(): void
  onClose(): void
  // 上の「会話｜質問」のタブ（キャンバスでだけ渡す。全画面のエディタでは、チャットだけを出す）
  tabs?: ReactNode
  // 答えを付箋に切り出す（キャンバスでだけ渡す）
  onCutToNote?(cut: ChatAnswerCut): void
  // 会話のそのジョブへ戻る
  reveal?: ChatReveal | null
  // 付箋の質問を取り込む
  importRequest?: ChatImportRequest | null
  // 見ている会話が変わった（答えの「会話で続ける」に、いまの会話の題を出すため）
  onThreadChange?(thread: { threadId: string; title: string } | null): void
  // 会話の欄のカードの ↗：取り込んだ付箋の質問へ（キャンバスでだけ渡す）
  onOpenImport?(item: ImportedQuestion): void
  // 会話の質問を作業のタブで開く（キャンバスでだけ渡す。渡したときだけ、入力欄に「会話｜質問」を出す。会話の欄からは使わない）
  onOpenQuestion?(id: string): void
}

export function ClaudePanel(props: Props) {
  const { client, canvasId, attachment, focusRequest, draft, placement, hidden = false, onAttachSelection, onClearAttachment, onClose, tabs, onCutToNote, reveal } = props
  const { importRequest, onThreadChange, onOpenImport, onOpenQuestion } = props
  const state = useClaudeState(client)
  // 選んだ会話。null は新しい会話。開いたときに選ぶ最新の会話は、付箋の作業しかない会話を除く
  const [chosenId, setThreadId] = useState<string | null>(() => {
    const latest = chatThreads(client.state)[0]
    return latest && (latest.running || Date.now() - latest.updatedAt < RECENT_MS) ? latest.threadId : null
  })
  // 会話の一覧（付箋の作業しかない会話は出さない。付箋の「チャットで続ける」で開いた会話は、選んでいる間は入れる）
  const threads = useMemo(() => chatThreads(state, chosenId), [state, chosenId])
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 「全部止める」を 1 回押した会話（もう 1 回押すと止める）
  const [confirmStop, setConfirmStop] = useState<string | null>(null)
  // 送り方（「会話｜質問」）と、次に送る文と一緒に取り込む付箋の質問
  const [chosenMode, setMode] = useState<ComposeMode>('chat')
  // 「会話｜質問」を出さない所（全画面のエディタ）では、いつも会話で送る
  const mode: ComposeMode = onOpenQuestion ? chosenMode : 'chat'
  const [pendingImport, setPendingImport] = useState<ImportedQuestion | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => client.connect(), [client])
  useEffect(() => void client.loadModels(), [client, state.availability])
  // 隠している間に頼まれたら、見せたときにフォーカスする（付箋の答えのパネルから「チャット」で移ったとき）
  useEffect(() => {
    if (!hidden) inputRef.current?.focus({ preventScroll: true })
  }, [focusRequest, hidden])
  // 新しい下書きが来たら入力欄に入れる（描画の中で前の値と比べる。React の「props が変わったら state を合わせる」書き方）。
  // 閉じていたパネルは下書きと一緒に開く（初めから下書きがある）ので、null から比べて、開いたときも入れる
  const [seenDraft, setSeenDraft] = useState<typeof draft>(null)
  if (draft !== seenDraft) {
    setSeenDraft(draft)
    if (draft) setPrompt(draft.text)
  }
  // 付箋の質問を取り込む（答えの「会話で続ける」）。新しい会話にするなら会話を外す。送るのは、次に文を書いて送ったとき
  const [seenImport, setSeenImport] = useState<typeof importRequest>(null)
  if (importRequest !== seenImport) {
    setSeenImport(importRequest)
    if (importRequest) {
      if (importRequest.newThread) setThreadId(null)
      else if (importRequest.threadId) setThreadId(importRequest.threadId)
      setPendingImport(importRequest.item)
      setMode('chat')
    }
  }
  // 会話のそのジョブへ戻る（付箋の会話の札の ↗）。会話を選び、読んだあとでスクロールする（下の useEffect）
  const [seenReveal, setSeenReveal] = useState<typeof reveal>(null)
  const [revealing, setRevealing] = useState<ChatReveal | null>(null)
  if (reveal !== seenReveal) {
    setSeenReveal(reveal)
    if (reveal) {
      setThreadId(reveal.threadId)
      setRevealing(reveal)
    }
  }

  // 見ている会話。選んだ会話が消されていれば、新しい会話
  const thread = threads.find((t) => t.threadId === chosenId)
  const threadId = thread ? thread.threadId : null
  const threadTitle = thread?.title ?? null
  useEffect(() => {
    onThreadChange?.(threadId && threadTitle !== null ? { threadId, title: threadTitle } : null)
  }, [onThreadChange, threadId, threadTitle])
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
  // 見ている会話の中身を読む（つなぎ直したあとも読み直す）。選んだ会話が一覧にまだなくても読む
  // （付箋の作業の会話を「チャットで続ける」で開いたとき。読むと一覧に入る）
  useEffect(() => {
    if (chosenId && !state.loaded.has(chosenId)) void client.loadThread(chosenId)
  }, [client, chosenId, state.loaded])
  // 作業の知らせを受けただけで何も書かなかったターン（サブエージェントの報告のあとに CLI が起こす）は見せない
  const jobs = useMemo(
    () => (threadId ? jobsOfThread(state, threadId).filter((job) => !(job.origin === 'background' && job.status !== 'running' && job.events.length === 0)) : []),
    [state, threadId],
  )
  const running = jobs.find((job) => job.status === 'running')
  // 会話の質問（会話に入れずに聞いたもの）。会話の欄に、聞いた時刻の位置で混ぜる
  const sideQuestions = useMemo(() => (threadId ? questionsOfThread(state, threadId) : []), [state, threadId])
  // 答えを作っている会話の質問の進み具合と考えている中身（SSE で届く）
  const questionProgress = useMemo(() => new Map(state.questions.map((question) => [question.id, question])), [state.questions])
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
  // 会話の質問は、答えを作っている間の考えている中身と、届いた答えでも伸びる
  const eventTotal =
    jobs.reduce((n, job) => n + job.events.length, 0) +
    sideQuestions.reduce((n, question) => n + 1 + (question.body?.length ?? 0) + (questionProgress.get(question.id)?.thinking.length ?? 0), 0)

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
  // 会話の欄が狭まっても（許可のカード・作業の一覧が出た、入力欄の札が増えた）、下に付いていれば下のまま
  useEffect(() => {
    const log = logRef.current
    if (!log || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (stick.current) log.scrollTop = log.scrollHeight
    })
    observer.observe(log)
    return () => observer.disconnect()
  }, [])
  // 戻ったジョブまでスクロールし、少しのあいだ色を付ける（会話を読み終えて、ジョブが出てから）
  const revealId =
    revealing && revealing.threadId === threadId
      ? revealing.jobId
        ? jobs.find((job) => job.id === revealing.jobId)?.id
        : revealing.questionId
          ? sideQuestions.find((question) => question.id === revealing.questionId)?.id
          : undefined
      : undefined
  const revealLoaded = !!threadId && state.loaded.has(threadId)
  // 会話を読み終えても、そのジョブ（質問）がない（会話を消した・別の端末で消した）。ジョブも質問も指していなければ、会話を選ぶだけ
  if (revealing && revealing.threadId === threadId && !revealId && (revealLoaded || (!revealing.jobId && !revealing.questionId))) setRevealing(null)
  // 戻った所まで、出てから 1 回だけスクロールする（n で見分ける）。色は DOM の class で付け、HIGHLIGHT_MS で外す（描き直しても残る）
  const revealed = useRef<number | null>(null)
  useEffect(() => {
    if (!revealing || revealing.threadId !== threadId || hidden || !revealId || revealed.current === revealing.n) return
    revealed.current = revealing.n
    stick.current = false
    const el = logRef.current?.querySelector<HTMLElement>(`[data-job-id="${CSS.escape(revealId)}"], [data-question-id="${CSS.escape(revealId)}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'start' })
    el.classList.add('highlighted')
    window.setTimeout(() => el.classList.remove('highlighted'), HIGHLIGHT_MS)
  }, [revealing, revealId, threadId, hidden])

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e))

  const chooseThread = (id: string | null) => {
    setThreadId(id)
    setConfirmStop(null)
    setError(null)
    stick.current = true
  }

  const send = () => {
    if (mode === 'question') return ask()
    const text = prompt.trim()
    if (!text || sending || running || attachment?.refId === null) return
    setSending(true)
    setError(null)
    // 質問だけの会話で初めて頼むときは、最後に答えた質問と答えを取り込んで渡す（Claude Code は、その会話の質問を知らない）
    const asked = !pendingImport && thread && jobs.length === 0 ? [...sideQuestions].reverse().find((item) => item.status === 'done' && item.body) : undefined
    const carried: ImportedQuestion | null = asked ? { label: firstLine(asked.question), question: asked.question, answer: asked.body!, questionId: asked.id } : null
    client
      .start({
        prompt: text,
        canvasId,
        ...(attachment?.refId ? { refId: attachment.refId, refLabel: attachment.label } : {}),
        ...(thread ? { threadId: thread.threadId } : {}),
        ...settingOf(setting),
        ...(pendingImport ? { imports: [pendingImport] } : carried ? { imports: [carried] } : {}),
      })
      .then((job) => {
        setPrompt('')
        setThreadId(job.threadId)
        setPendingImport(null)
        stick.current = true
        onClearAttachment()
      })
      .catch(fail)
      .finally(() => setSending(false))
  }

  // 入力欄の「質問」：その 1 つだけ、会話に入れずに聞く。前の答えとして、会話の最後の終わったジョブ（頼んだ文と答え）を添え、
  // 添えた所は refs にする。答えはサーバーが claude.db に書き、会話の欄に出る。会話を選んでいなければ、サーバーが作った新しい会話を選ぶ。
  // サーバーが受けたら（start）入力欄を空ける（「質問」のまま）。受ける前の誤りは、入力欄の下に出す
  const ask = () => {
    const text = prompt.trim()
    if (!text || sending || attachment?.refId === null) return
    // 前の答え：会話の最後の終わったジョブ（バックグラウンドから続けたものは、頼んだ文がないので除く）。送る前に長さを収める（大きすぎて 413 にならないように）
    const previous = lastTurn()
    const request: AnswerRequest = {
      question: text,
      ...(previous ? { previous: fitTurns([previous]) } : {}),
      ...(attachment?.refId ? { refs: [{ label: attachment.label, refId: attachment.refId }] } : {}),
      source: { kind: 'chat', ...(thread ? { threadId: thread.threadId } : {}), label: firstLine(text) },
    }
    setSending(true)
    setError(null)
    let started = false
    let askedIn = thread?.threadId
    requestAnswer(request, settingOf(setting), {
      onStart: (_id, created) => {
        started = true
        setSending(false)
        setPrompt('')
        stick.current = true
        onClearAttachment()
        // 会話を選ばずに聞いた：サーバーが作った会話を一覧に入れて選ぶ（入力欄のモデルは、いま選んでいるもののまま。読むのは選んだあと）
        if (!askedIn && created) {
          const now = Date.now()
          client.addThread({ threadId: created, title: text, createdAt: now, updatedAt: now, jobCount: 0, running: false })
          setSettingFor(created)
          setThreadId(created)
          askedIn = created
        } else if (askedIn) {
          // 答えを作っている間も、質問の全文を出す（SSE の動いている質問は 1 行目だけ。サーバーは start の前に行を書いている）
          void client.reloadQuestions(askedIn)
        }
      },
    })
      // 答えが届いたら、会話の質問を読み直す（SSE の question-done でも読み直すが、つながっていなくても出るように）
      .then(() => {
        if (askedIn) void client.reloadQuestions(askedIn)
      })
      .catch((e: unknown) => {
        if (askedIn && started) void client.reloadQuestions(askedIn)
        if (e instanceof AnswerError && e.status === 499) return setSending(false)
        // 始まってからの誤り（答えられなかった）は、会話の欄の質問に出る
        if (started && askedIn) return
        setSending(false)
        fail(e)
      })
  }

  const remove = (id: string) => {
    client
      .deleteThread(id)
      .then(() => setThreadId((current) => (current === id ? null : current)))
      .catch(fail)
  }

  const stopAll = () => {
    if (!thread) return
    if (confirmStop !== thread.threadId) {
      setConfirmStop(thread.threadId)
      return
    }
    setConfirmStop(null)
    client.stopThread(thread.threadId).catch(fail)
  }

  const stopTask = (task: BackgroundTask) => {
    if (!thread) return
    client.stopTask(thread.threadId, task.id).catch(fail)
  }

  const answer = (permission: PendingPermission, decision: 'allow' | 'deny') => {
    if (!thread || answering.has(permission.id)) return
    setAnswering((ids) => new Set(ids).add(permission.id))
    setError(null)
    client.answerPermission(thread.threadId, permission.id, decision).catch((e: unknown) => {
      fail(e)
      // 送れなかったら、また押せるようにする（もう待っていない 404 なら、SSE で一覧から消える）
      setAnswering((ids) => {
        const next = new Set(ids)
        next.delete(permission.id)
        return next
      })
    })
  }

  // 前の答え：会話の最後に終わったもの（頼んだ文と答えのあるジョブか、答えた会話の質問。バックグラウンドから続けたジョブは、頼んだ文がないので除く）
  const lastTurn = (): { question: string; answer: string } | null => {
    const job = [...jobs].reverse().find((item) => item.status === 'done' && !item.origin && answerOfEvents(item.events))
    const question = [...sideQuestions].reverse().find((item) => item.status === 'done' && item.body)
    if (question && (!job || question.createdAt > job.createdAt)) return { question: question.question, answer: question.body! }
    return job ? { question: job.prompt, answer: answerOfEvents(job.events) } : null
  }

  const cutToNote = (job: ClaudeJob, text: string) => {
    if (!thread || !onCutToNote) return
    onCutToNote({ threadId: thread.threadId, jobId: job.id, title: thread.title, question: job.prompt, answer: text })
  }

  // 会話の質問の答えを付箋に切り出す（添えた前の答えも写す）
  const cutQuestionToNote = (question: ChatQuestion) => {
    if (!thread || !onCutToNote || question.body === undefined) return
    onCutToNote({ threadId: thread.threadId, questionId: question.id, title: thread.title, question: question.question, answer: question.body, previous: question.previous })
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
    <aside className="claude-panel" aria-label="Claude のチャット" hidden={hidden} tabIndex={-1} onKeyDown={onPanelKeyDown} {...{ [OWN_KEYS_ATTRIBUTE]: '' }}>
      <ChatHeader
        {...(tabs ? { tabs } : {})}
        threads={threads}
        thread={thread}
        busy={busy}
        onChoose={chooseThread}
        onNew={() => {
          chooseThread(null)
          inputRef.current?.focus({ preventScroll: true })
        }}
        onDelete={remove}
        onClose={onClose}
      />

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
        {thread && !state.loaded.has(thread.threadId) && jobs.length === 0 && sideQuestions.length === 0 && <p className="claude-hint">読み込んでいます…</p>}
        <ChatLog
          jobs={jobs}
          catalog={state.models}
          askingJobs={waiting.jobs}
          pendingIds={waiting.ids}
          onCancel={(job) => void client.cancel(job.id).catch(fail)}
          {...(onCutToNote ? { onCutToNote: cutToNote } : {})}
          questions={sideQuestions}
          questionProgress={questionProgress}
          onStopQuestion={(id) => void client.cancelQuestion(id).catch(fail)}
          {...(onCutToNote ? { onCutQuestion: cutQuestionToNote } : {})}
          {...(onOpenImport ? { onOpenImport } : {})}
        />
      </div>

      {thread && permissions.length > 0 && <PermissionList permissions={permissions} answering={answering} onAnswer={answer} />}

      {thread && tasks.length > 0 && (
        <TaskDrawer tasks={tasks} confirmStop={confirmStop === thread.threadId} onStop={stopTask} onStopAll={stopAll} onBlurStopAll={() => setConfirmStop(null)} />
      )}

      <ChatComposer
        inputRef={inputRef}
        prompt={prompt}
        placeholder={mode === 'question' ? 'この 1 つだけ、会話に入れずに聞く…' : thread ? '続けて頼む…' : 'Claude に頼む…'}
        attachment={attachment}
        importLabel={pendingImport?.label ?? null}
        importFromChat={!!pendingImport?.questionId}
        onClearImport={() => setPendingImport(null)}
        mode={mode}
        {...(onOpenQuestion ? { onMode: setMode } : {})}
        catalog={state.models}
        setting={setting}
        canSend={!!prompt.trim() && !sending && (mode === 'question' || !running) && attachment?.refId !== null}
        error={error}
        onPrompt={setPrompt}
        onKeyDown={onKeyDown}
        onScroll={(e) => (scrolled.current.input = e.currentTarget.scrollTop)}
        onAttachSelection={onAttachSelection}
        onClearAttachment={onClearAttachment}
        onSetting={chooseSetting}
        onSend={send}
      />
    </aside>
  )
}

// 画面で許可を待っている問い合わせ（古いものが上）。入力欄のすぐ上に、警告の色のカードで出す。断る判断の材料なので、コマンドは切らずに全部出す。
// 許可のボタンにはフォーカスを置かず、1 つのキーで許可できるようにはしない。残りの時間は 15 秒ごとに描き直す
export function PermissionList(props: {
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
    <div className="claude-permissions" role="region" aria-label={`許可を待っています（${permissions.length}）`}>
      {permissions.length > 1 && <div className="claude-permissions-count">許可を待っています（{permissions.length}）</div>}
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

// バックグラウンドで動いている作業：「⚙ 動作中の作業 N件 ▾」の 1 行にたたみ、押すと一覧（1 つずつの「止める」と「全部止める」（2 回押す））
function TaskDrawer(props: {
  tasks: readonly BackgroundTask[]
  confirmStop: boolean
  onStop(task: BackgroundTask): void
  onStopAll(): void
  onBlurStopAll(): void
}) {
  const { tasks, confirmStop, onStop, onStopAll, onBlurStopAll } = props
  const [open, setOpen] = useState(false)
  return (
    <div className={`claude-tasks${open ? ' open' : ''}`} role="region" aria-label="バックグラウンドの作業">
      <button type="button" className="claude-tasks-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="claude-tasks-title">⚙ 動作中の作業 {tasks.length}件</span>
        <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="claude-tasks-list">
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
          <div className="claude-task claude-task-all">
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
        </div>
      )}
    </div>
  )
}

function taskTypeLabel(type: string): string {
  if (type === 'local_agent') return 'サブエージェント'
  if (type === 'local_bash') return 'コマンド'
  return '作業'
}
