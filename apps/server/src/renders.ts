import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebSocket } from 'ws'
import type { Box } from '@canvcode/core'
import { HttpError } from './files.ts'
import { MAX_REF_IMAGE_BYTES, pngSize } from './refImages.ts'
import type { SyncHub, TabInfo } from './sync.ts'

// Canvas を画像にする（MAI-89。docs/canvas-image-plan.md の 4）。サーバーは描かず、開いているタブに頼む。
// - AI の render_canvas（mcp.ts）が request を呼ぶ。描けるタブ（hello の features に render があるもの）を選び、
//   WebSocket で { type: 'render', attempt, canvasId, rev, target, maxEdge } を送る
// - タブは描いて、PUT /api/renders/<attempt> で答える。PNG なら成功（範囲などは query）、JSON（{ error, retry? }）なら失敗
// - attempt の id は 128 ビットの乱数で、頼んだタブにだけ送る。頼み直すたびに作り直し、1 回答えたら（成功・失敗・打ち切り）消す
//   （前のタブから遅れて届いた答えは 404）。/api/ の下なので、ほかの API と同じく Host と Origin を確かめる（index.ts）
// - 1 回 attemptTimeoutMs で打ち切って次のタブに頼む。タブが閉じたら、すぐ次に頼む。全体で totalTimeoutMs まで。
//   全体の期限はジョブごとのタイマーで守る（答えの本文をとても遅く送るタブがいても、request はその時間で終わる）。
//   期限を過ぎたら、待っている頼みを消し、読みかけの答えは捨てて、その接続を閉じる
// - 画像はメモリーにだけ置く（ファイルには書かない）
// 画面を開ける人なら、render を名乗るタブを作ってどんな PNG でも返せる。ただ、その人は今でも Canvas を書き換えられるので、
// 信頼の範囲は広がらない（AI に見せる画像は、Canvas のレコードと同じ重みで扱う）

export type RenderTarget = { kind: 'rect'; rect: Box } | { kind: 'nodes'; ids: string[] } | { kind: 'slide'; id: string } | { kind: 'canvas' }

export interface RenderRequest {
  canvasId: string
  target: RenderTarget
  // 長い辺の画素（AI）
  maxEdge: number
  // 描く前に、タブが受け取っているべき変更番号
  rev: number
}

export interface RenderResult {
  png: Buffer
  width: number
  height: number
  // 描いた範囲（ワールド座標）と、1 ワールド単位あたりの画素
  box: Box
  scale: number
  // タブが描いたときの変更番号
  rev: number
  capped: boolean
  empty: boolean
  incomplete: string[]
  missing: string[]
}

export type RenderErrorCode = 'no-tab' | 'timeout' | 'busy' | 'failed'

export class RenderError extends Error {
  readonly code: RenderErrorCode
  constructor(code: RenderErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export interface RenderBrokerOptions {
  attemptTimeoutMs?: number
  totalTimeoutMs?: number
  // 終わっていない頼みの上限
  maxPending?: number
}

// タブが返す PNG の大きさの上限（canvasImage.ts の IMAGE_MAX_PIXELS と同じ。iPad の Safari の canvas の上限）
const MAX_PIXELS = 16_777_216
// 失敗の JSON の大きさの上限
const MAX_ERROR_BYTES = 4096
const RENDER_PATH = /^\/api\/renders\/([^/]+)$/

interface Job {
  request: RenderRequest
  // 頼んだタブ（同じタブには 2 度頼まない）
  tried: Set<WebSocket>
  deadline: number
  // 最後の失敗の理由（全部のタブで駄目だったときに返す）
  lastFailure: string | null
  // 終わったか（答えた・断った・期限を過ぎた）。終わったあとに届いた答えは捨てる
  done: boolean
  // 全体の期限のタイマー
  timer: ReturnType<typeof setTimeout> | null
  // 読んでいる途中の答え（期限を過ぎたら閉じる）
  reading: Set<IncomingMessage>
  // どちらも 1 回だけ効く（2 回目からは何もしない）
  resolve(result: RenderResult): void
  reject(error: RenderError): void
}

interface Attempt {
  id: string
  job: Job
  socket: WebSocket
  timer: ReturnType<typeof setTimeout>
}

export class RenderBroker {
  private readonly hub: SyncHub
  private readonly options: Required<RenderBrokerOptions>
  private readonly jobs = new Set<Job>()
  private readonly attempts = new Map<string, Attempt>()
  private readonly unlisten: () => void

  constructor(hub: SyncHub, options: RenderBrokerOptions = {}) {
    this.hub = hub
    this.options = {
      attemptTimeoutMs: options.attemptTimeoutMs ?? 20_000,
      totalTimeoutMs: options.totalTimeoutMs ?? 45_000,
      maxPending: options.maxPending ?? 4,
    }
    this.unlisten = hub.onClose((socket) => this.closed(socket))
  }

  dispose(): void {
    this.unlisten()
    for (const job of [...this.jobs]) job.reject(new RenderError('failed', 'The server is shutting down.'))
    for (const attempt of this.attempts.values()) clearTimeout(attempt.timer)
    this.attempts.clear()
  }

  // 描けるタブがあるか（MCP の答えを早く返すため）
  hasTabs(): boolean {
    return this.hub.tabs().some((tab) => tab.features.has('render'))
  }

  request(request: RenderRequest): Promise<RenderResult> {
    if (this.jobs.size >= this.options.maxPending) {
      return Promise.reject(new RenderError('busy', `Already rendering ${this.jobs.size} images. Try again in a moment.`))
    }
    return new Promise((resolve, reject) => {
      const job: Job = {
        request,
        tried: new Set(),
        deadline: Date.now() + this.options.totalTimeoutMs,
        lastFailure: null,
        done: false,
        timer: null,
        reading: new Set(),
        resolve: (result) => {
          if (this.finish(job)) resolve(result)
        },
        reject: (error) => {
          if (this.finish(job)) reject(error)
        },
      }
      // 全体の期限。答えを読んでいる途中でも、ここで終える
      const seconds = Math.round(this.options.totalTimeoutMs / 1000)
      job.timer = setTimeout(() => job.reject(new RenderError('timeout', this.giveUpMessage(job, `timed out after ${seconds} s`))), this.options.totalTimeoutMs)
      this.jobs.add(job)
      this.next(job)
    })
  }

  // PUT /api/renders/<attempt>：タブの答え。扱わないパスなら false
  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    const match = RENDER_PATH.exec(path)
    if (!match) return false
    if (req.method !== 'PUT') {
      sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    let id = ''
    try {
      id = decodeURIComponent(match[1])
    } catch {
      // 読めない id は、ないものとして扱う
    }
    const attempt = this.attempts.get(id)
    if (!attempt) {
      sendJson(res, 404, { error: 'no such render request' })
      return true
    }
    // 答えを読み始めたら、この頼みは打ち切らない（読み終えるまでに、ほかのタブへ頼み直さない）。
    // 全体の期限（ジョブのタイマー）は効いたままで、過ぎたら読みかけの答えを捨てて接続を閉じる
    const { job } = attempt
    clearTimeout(attempt.timer)
    this.attempts.delete(id)
    // 本文を読んでいる間だけ「読みかけ」にする（期限を過ぎたら、この接続を閉じる）
    const read = async (max: number): Promise<Buffer> => {
      job.reading.add(req)
      try {
        return await readBody(req, max)
      } finally {
        job.reading.delete(req)
      }
    }
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim()
    try {
      if (type === 'image/png') {
        const body = await read(MAX_REF_IMAGE_BYTES)
        if (job.done) return ended(res)
        job.resolve(parseResult(body, new URL(req.url ?? '/', 'http://localhost').searchParams, job.request))
        sendJson(res, 201, { ok: true })
      } else if (type === 'application/json') {
        const body = await read(MAX_ERROR_BYTES)
        if (job.done) return ended(res)
        const answer = JSON.parse(body.toString('utf8')) as { error?: unknown; retry?: unknown }
        const reason = typeof answer.error === 'string' && answer.error ? answer.error.slice(0, 500) : 'the tab could not render'
        this.failed(attempt, reason, answer.retry !== false)
        sendJson(res, 200, { ok: true })
      } else {
        this.failed(attempt, 'the tab sent an answer that is not a PNG', true)
        sendJson(res, 415, { error: 'png or json only' })
      }
    } catch (error) {
      // 期限を過ぎて閉じた接続（読みかけ）なら、もう何もしない
      if (job.done) return ended(res)
      const status = error instanceof HttpError ? error.status : 400
      const message = error instanceof Error ? error.message : 'invalid answer'
      this.failed(attempt, `the tab sent an invalid answer (${message})`, true)
      sendJson(res, status, { error: message })
    }
    return true
  }

  // ジョブを終える（全体の期限のタイマー・待っている頼みを消し、読みかけの答えの接続を閉じる）。もう終わっていれば false
  private finish(job: Job): boolean {
    if (job.done) return false
    job.done = true
    if (job.timer !== null) clearTimeout(job.timer)
    this.jobs.delete(job)
    for (const attempt of [...this.attempts.values()]) {
      if (attempt.job !== job) continue
      clearTimeout(attempt.timer)
      this.attempts.delete(attempt.id)
    }
    for (const req of job.reading) req.destroy()
    job.reading.clear()
    return true
  }

  // 次のタブに頼む。もうなければ、最後の理由で終える
  private next(job: Job): void {
    if (job.done) return
    const left = job.deadline - Date.now()
    if (left <= 0) return job.reject(new RenderError('timeout', this.giveUpMessage(job, 'timed out')))
    for (const tab of this.candidates(job)) {
      job.tried.add(tab.socket)
      const id = randomBytes(16).toString('base64url')
      const timer = setTimeout(() => {
        if (this.attempts.get(id) !== attempt) return
        this.attempts.delete(id)
        job.lastFailure = `a tab did not answer within ${Math.round(Math.min(this.options.attemptTimeoutMs, left) / 1000)} s`
        this.next(job)
      }, Math.min(this.options.attemptTimeoutMs, left))
      const attempt: Attempt = { id, job, socket: tab.socket, timer }
      this.attempts.set(id, attempt)
      const { canvasId, rev, target, maxEdge } = job.request
      if (this.hub.sendTo(tab.socket, { type: 'render', attempt: id, canvasId, rev, target, maxEdge })) return
      clearTimeout(timer)
      this.attempts.delete(id)
    }
    if (job.tried.size === 0) {
      return job.reject(new RenderError('no-tab', 'No CanvCode tab is open to render the canvas.'))
    }
    const code: RenderErrorCode = job.lastFailure?.startsWith('a tab did not answer') ? 'timeout' : 'failed'
    job.reject(new RenderError(code, this.giveUpMessage(job, job.lastFailure ?? 'failed')))
  }

  private failed(attempt: Attempt, reason: string, retry: boolean): void {
    if (attempt.job.done) return
    attempt.job.lastFailure = reason
    if (retry) this.next(attempt.job)
    else attempt.job.reject(new RenderError('failed', reason))
  }

  // 頼んだタブが閉じた：そのタブへの頼みは、すぐ次のタブに回す
  private closed(socket: WebSocket): void {
    for (const attempt of [...this.attempts.values()]) {
      if (attempt.socket !== socket) continue
      clearTimeout(attempt.timer)
      this.attempts.delete(attempt.id)
      attempt.job.lastFailure = 'the tab was closed while rendering'
      this.next(attempt.job)
    }
  }

  // 頼む順：その Canvas を見ている・読んだ・そのほかのタブ。それぞれ見えているものが先で、裏に回ったタブはそのあと。
  // 同じ順位なら、最後に見ている所を知らせてきたものが先
  private candidates(job: Job): TabInfo[] {
    const { canvasId } = job.request
    const rank = (tab: TabInfo): number => {
      const place = tab.presence?.canvasId === canvasId ? 0 : tab.scope === 'all' || tab.scope.has(canvasId) ? 1 : 2
      const hidden = tab.presence?.visible === false ? 3 : 0
      return place + hidden
    }
    return this.hub
      .tabs()
      .filter((tab) => tab.features.has('render') && !job.tried.has(tab.socket))
      .map((tab, order) => ({ tab, order }))
      .sort((a, b) => rank(a.tab) - rank(b.tab) || (b.tab.presence?.at ?? 0) - (a.tab.presence?.at ?? 0) || a.order - b.order)
      .map(({ tab }) => tab)
  }

  private giveUpMessage(job: Job, reason: string): string {
    const tabs = job.tried.size
    return `Could not render the canvas: ${reason} (asked ${tabs} tab${tabs === 1 ? '' : 's'}).`
  }
}

// タブが返した PNG と、描いた範囲など（query）。大きすぎる・壊れているものは Error
function parseResult(png: Buffer, query: URLSearchParams, request: RenderRequest): RenderResult {
  const size = pngSize(png)
  if (!size) throw new Error('not a png')
  // 長い辺で決めるので、丸めの 1 画素を超えて大きければ断る
  if (Math.max(size.width, size.height) > request.maxEdge + 1 || size.width * size.height > MAX_PIXELS) throw new Error('the png is larger than asked')
  const number = (key: string) => {
    const value = Number(query.get(key) ?? Number.NaN)
    if (!Number.isFinite(value)) throw new Error(`${key} is required`)
    return value
  }
  const box = { x: number('x'), y: number('y'), w: number('w'), h: number('h') }
  if (!(box.w > 0) || !(box.h > 0)) throw new Error('the box is empty')
  const scale = number('scale')
  const rev = number('rev')
  if (!(scale > 0) || !Number.isInteger(rev) || rev < 0) throw new Error('invalid scale or rev')
  const list = (key: string) => (query.get(key) ?? '').split(',').filter(Boolean).slice(0, 100)
  return {
    png,
    width: size.width,
    height: size.height,
    box,
    scale,
    rev,
    capped: query.get('capped') === '1',
    empty: query.get('empty') === '1',
    incomplete: list('incomplete'),
    missing: list('missing'),
  }
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > max) throw new HttpError(413, 'too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

// 終わったジョブへの答え（期限を過ぎた）。接続がまだ開いていれば、そう返す
function ended(res: ServerResponse): true {
  if (!res.headersSent && !res.destroyed) sendJson(res, 410, { error: 'the render request has ended' })
  return true
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
