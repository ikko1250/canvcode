import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

// 会話 1 つの Claude Code のプロセス（claude/jobs.ts が使う）。
// - query() を 1 回だけ呼び、prompt にメッセージを順に流す入れ物（InputQueue）を渡す（ストリーミング入力）。続きのメッセージはその入れ物に足す
// - 届いたメッセージはそのまま onMessage に渡す。バックグラウンドの作業の一覧（background_tasks_changed。届くたびに置き換える）だけはここで持つ
// - 閉じるときは入れ物を閉じる（stdin の終わり）。作業が残っていると CLI は終わらないので、そのときと、待っても終わらないときは abort する
// - 前の同じ会話のプロセスが終わる途中なら、それを待ってから query を立てる（同じ session を 2 つのプロセスで開かない）

export interface SessionQuery extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>
  stopTask(taskId: string): Promise<void>
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

  push(text: string): void {
    if (this.closed) throw new Error('the input is closed')
    this.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })
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

  constructor(run: RunQuery, options: Options, handlers: SessionHandlers, after?: Promise<void>) {
    this.exited = this.read(run, options, handlers, after)
  }

  send(text: string): void {
    this.input.push(text)
  }

  // 今のターンだけを止める（バックグラウンドの作業は残る。perTaskStopAffordance）
  async interrupt(): Promise<void> {
    await this.query?.interrupt()
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
    this.input.close()
    handlers.onExit(failure)
    this.tasks = []
  }
}
