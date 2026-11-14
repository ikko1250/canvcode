import type { EffortLevel, ModelInfo, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

// 会話 1 つの Claude Code のプロセス（claude/jobs.ts が使う）。
// - query() を 1 回だけ呼び、prompt にメッセージを順に流す入れ物（InputQueue）を渡す（ストリーミング入力）。続きのメッセージはその入れ物に足す
// - 届いたメッセージはそのまま onMessage に渡す。バックグラウンドの作業の一覧（background_tasks_changed。届くたびに置き換える）だけはここで持つ
// - 閉じるときは入れ物を閉じる（stdin の終わり）。作業が残っていると CLI は終わらないので、そのときと、待っても終わらないときは abort する
// - 前の同じ会話のプロセスが終わる途中なら、それを待ってから query を立てる（同じ session を 2 つのプロセスで開かない）
// - モデルと effort（MAI-106）は、立てるときは Options で渡し、動いている間に変えるときは configure（setModel・applyFlagSettings）で変える。
//   変えている途中に送るメッセージは、変え終わってから流す（変えたあとのモデルで答えるように）。変えられなかったら（断られた・
//   CONFIGURE_TIMEOUT_MS のうちに答えがない）流さずに onRejected を呼ぶ。流す前に止めたメッセージは withdraw で取り消す

export interface SessionQuery extends AsyncIterable<SDKMessage> {
  // cancelQueued は、まだ答え始めていない（待っている）メッセージも取り消す（d.ts にはないが、SDK の Query は受け取る）
  interrupt(options?: { cancelQueued?: boolean }): Promise<unknown>
  stopTask(taskId: string): Promise<void>
  // ストリーミング入力のときだけ使える（MAI-106）。model を渡さなければ既定のモデル、effortLevel が null ならモデルの既定
  setModel(model?: string): Promise<void>
  applyFlagSettings(settings: { effortLevel?: EffortLevel | null }): Promise<void>
  supportedModels(): Promise<ModelInfo[]>
}

// モデルを変える問い合わせ（setModel・applyFlagSettings）の答えを待つ時間（ミリ秒。SDK の問い合わせには期限がない）
export const CONFIGURE_TIMEOUT_MS = 30_000

// 会話のモデルと effort（MAI-106）。model がなければ既定のモデル（サーバーの CANVCODE_CLAUDE_MODEL か、ワークスペースの設定）、
// effort がなければモデルの既定
export interface ModelSettings {
  model?: string
  effort?: EffortLevel
}

// 既定は Agent SDK の query（使うときに読み込むので Promise でもよい）
export type RunQuery = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => SessionQuery | Promise<SessionQuery>

export interface BackgroundTask {
  id: string
  description: string
  // local_agent（サブエージェント）・local_bash（コマンド）など
  type: string
}

export interface SessionHandlers {
  onMessage: (message: SDKMessage) => void
  onTasks: (tasks: BackgroundTask[]) => void
  // error は、for await が投げたとき（止めたときは undefined）。呼ぶときには、まだ tasks に最後の一覧が残っている
  onExit: (error: unknown) => void
}

// AsyncIterable<SDKUserMessage> の入れ物
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[] = []
  private wake: (() => void) | undefined
  private closed = false

  // uuid は、そのメッセージに答えるターンの assistant と result の user_message_uuids に返ってくる
  push(text: string, uuid: string): void {
    if (this.closed) throw new Error('the input is closed')
    this.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid: uuid as SDKUserMessage['uuid'] })
    this.wake?.()
  }

  close(): void {
    this.closed = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.queue.shift()
      if (next) {
        yield next
        continue
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
      this.wake = undefined
    }
  }
}

export class ClaudeSession {
  readonly exited: Promise<void>
  tasks: BackgroundTask[] = []
  // query を立てた（前のプロセスを待ち終えた）
  started = false
  // close() を呼んだ（終わるのは頼んだから）
  closing = false
  private readonly abort = new AbortController()
  private readonly input = new InputQueue()
  private query: SessionQuery | undefined
  // query を立てたら、それで解ける（立てられなかったら undefined）。configure は立つのを待ってから当てる
  private readonly queryReady: Promise<SessionQuery | undefined>
  private resolveQuery!: (query: SessionQuery | undefined) => void
  // モデルを変えている途中（送るメッセージはこれを待つ。変えられなかったらその理由で解ける）
  private configuring: Promise<Error | undefined> | undefined
  // 変え終わるのを待っているメッセージの uuid（withdraw で取り消せる）
  private readonly deferred = new Set<string>()
  private readonly configureTimeoutMs: number

  constructor(run: RunQuery, options: Options, handlers: SessionHandlers, after?: Promise<void>, configureTimeoutMs = CONFIGURE_TIMEOUT_MS) {
    this.configureTimeoutMs = configureTimeoutMs
    this.queryReady = new Promise((resolve) => (this.resolveQuery = resolve))
    this.exited = this.read(run, options, handlers, after)
  }

  // onRejected は、モデルを変えられずに流さなかったとき
  send(text: string, uuid: string, onRejected?: (error: Error) => void): void {
    const configuring = this.configuring
    if (!configuring) {
      this.input.push(text, uuid)
      return
    }
    // モデルを変え終わってから流す（そのあいだに取り消した・プロセスが終わったなら流さない。次の依頼は新しいプロセスで続ける）
    this.deferred.add(uuid)
    void configuring.then((error) => {
      if (!this.deferred.delete(uuid)) return
      if (error) {
        onRejected?.(error)
        return
      }
      try {
        this.input.push(text, uuid)
      } catch {
        // 入れ物が閉じている
      }
    })
  }

  // モデルを変え終わるのを待っているメッセージを取り消す（流す前なら true。もう流したなら false）
  withdraw(uuid: string): boolean {
    return this.deferred.delete(uuid)
  }

  // プロセスのモデルと effort を変える（MAI-106。次に送るメッセージから効く）。query を立てる前なら、立つのを待ってから当てる。
  // 変えられなくても（古い CLI など）、送るのは止めない
  configure(settings: ModelSettings): void {
    const answer = <T>(request: Promise<T>): Promise<T> => {
      let timer: NodeJS.Timeout | undefined
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Claude Code did not answer in time')), this.configureTimeoutMs)
      })
      return Promise.race([request, late]).finally(() => clearTimeout(timer))
    }
    const done: Promise<Error | undefined> = (this.configuring ?? Promise.resolve(undefined))
      .then(() => this.queryReady)
      .then(async (query) => {
        if (!query) return undefined
        await answer(query.setModel(settings.model))
        await answer(query.applyFlagSettings({ effortLevel: settings.effort ?? null }))
        return undefined
      })
      .catch((error: unknown) => {
        console.error('Claude のモデルを変えられませんでした', error)
        return error instanceof Error ? error : new Error(String(error))
      })
      .finally(() => {
        if (this.configuring === done) this.configuring = undefined
      })
    this.configuring = done
  }

  // 使えるモデルの一覧（query を立てたあとだけ）
  async supportedModels(): Promise<ModelInfo[] | undefined> {
    return this.query?.supportedModels()
  }

  // 今のターンだけを止める（バックグラウンドの作業は残る。perTaskStopAffordance）。cancelQueued なら、待っているメッセージも取り消す
  async interrupt(cancelQueued = false): Promise<void> {
    await this.query?.interrupt(cancelQueued ? { cancelQueued: true } : undefined)
  }

  async stopTask(taskId: string): Promise<void> {
    await this.query?.stopTask(taskId)
  }

  // 閉じて、終わるのを待つ。作業が残っていればすぐ止め、なければ入れ物を閉じて graceMs 待ち、終わらなければ止める
  async close(graceMs: number): Promise<void> {
    this.closing = true
    this.input.close()
    if (this.tasks.length > 0 || graceMs <= 0) this.abort.abort()
    let timer: NodeJS.Timeout | undefined
    const grace = new Promise<false>((resolve) => {
      timer = setTimeout(resolve, graceMs, false)
    })
    const ended = await Promise.race([this.exited.then(() => true), grace])
    clearTimeout(timer)
    if (ended) return
    this.abort.abort()
    await this.exited
  }

  private async read(run: RunQuery, options: Options, handlers: SessionHandlers, after: Promise<void> | undefined): Promise<void> {
    let failure: unknown
    try {
      if (after) await after
      if (!this.abort.signal.aborted) {
        this.query = await run({ prompt: this.input, options: { ...options, abortController: this.abort } })
        this.started = true
        this.resolveQuery(this.query)
        for await (const message of this.query) {
          if (message.type === 'system' && message.subtype === 'background_tasks_changed') {
            // ambient は動きではないもの（見張りなど）
            this.tasks = message.tasks.filter((task) => !task.ambient).map((task) => ({ id: task.task_id, description: task.description, type: task.task_type }))
            handlers.onTasks(this.tasks)
            continue
          }
          handlers.onMessage(message)
        }
      }
    } catch (error) {
      if (!this.abort.signal.aborted) failure = error
    }
    this.resolveQuery(undefined)
    this.input.close()
    handlers.onExit(failure)
    this.tasks = []
  }
}
