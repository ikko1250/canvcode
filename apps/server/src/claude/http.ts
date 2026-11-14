import type { IncomingMessage, ServerResponse } from 'node:http'
import { normalizeRefId } from '@canvcode/core'
import { JobError, type ClaudeJobs, type StartRequest } from './jobs.ts'
import { isEffortLevel, isModelName } from './models.ts'

// 画面から Claude Code に頼む API（claude/jobs.ts）。
// - GET /api/claude/threads：会話の一覧（最後に動いたものから）{ threads }
// - GET /api/claude/threads/<id>：会話とそのジョブ（出来事も含む）{ thread, jobs }
// - DELETE /api/claude/threads/<id>：会話を消す（動いている依頼かバックグラウンドの作業があれば 409）
// - POST /api/claude/threads/<id>/stop：会話のプロセスごと止める（今のターンもバックグラウンドの作業も）。204
// - POST /api/claude/threads/<id>/tasks/<taskId>/stop：バックグラウンドの作業を 1 つ止める。204（もう動いていなければ 404）
// - POST /api/claude/threads/<id>/permissions/<permissionId> { decision: 'allow' | 'deny' }：画面で待っている問い合わせに答える。204
//   （もう待っていなければ 404）。content-type は application/json だけ受ける（別のサイトのフォームから送らせないため。415）
// - GET /api/claude/models：選べるモデルと effort（claude/models.ts の ModelCatalog。MAI-106）。初めは Claude Code に聞くので、少し待たせる
// - POST /api/claude/jobs { prompt, refId?, canvasId?, threadId?, model?, effort? }：頼む（threadId があれば、その会話の続き。
//   model・effort がなければ既定）。201 { job }
// - GET /api/claude/jobs/<id>：1 つのジョブ
// - POST /api/claude/jobs/<id>/cancel：止める（そのターンだけ。バックグラウンドの作業は残る）
// - GET /api/claude/events：変化を SSE で送る。つないだときに { type: 'snapshot', threads, running }（running は動いているジョブ）、
//   そのあと変わるたびに { type: 'job', job, events, from, thread }（events はジョブの from 番目からの出来事）か、
//   { type: 'thread', thread }（バックグラウンドの作業の一覧が変わった）か、{ type: 'thread-deleted', threadId }
// 会話（thread）には、動いているバックグラウンドの作業 tasks: { id, description, type }[] と、
// 画面で答えを待っている問い合わせ permissions（claude/jobs.ts の PendingPermission）が付く
// jobs がなければ（CANVCODE_CLAUDE=0）、どれも 404 を返す。画面はそれを見て入口を出さない

const PREFIX = '/api/claude'
const MAX_BODY = 64 * 1024
// 経路の途中（Tailscale Serve など）で、黙っている接続を切られないように送る
const HEARTBEAT_MS = 25_000
// バックグラウンドの作業の id（Claude Code の task_id）
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/

export function handleClaude(req: IncomingMessage, res: ServerResponse, path: string, jobs: ClaudeJobs | null): boolean {
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false
  if (!jobs) {
    sendJson(res, 404, { error: 'Claude Code from the screen is disabled (CANVCODE_CLAUDE=0)' })
    return true
  }
  if (path === `${PREFIX}/events`) {
    if (req.method !== 'GET') return methodNotAllowed(res)
    streamEvents(req, res, jobs)
    return true
  }
  if (path === `${PREFIX}/threads`) {
    if (req.method !== 'GET') return methodNotAllowed(res)
    sendJson(res, 200, { threads: jobs.threads() })
    return true
  }
  if (path === `${PREFIX}/models`) {
    if (req.method !== 'GET') return methodNotAllowed(res)
    jobs.models().then(
      (catalog) => sendJson(res, 200, catalog),
      (error: unknown) => sendError(res, error),
    )
    return true
  }
  const stop = /^\/api\/claude\/threads\/([0-9a-f-]{36})(?:\/tasks\/([^/]+))?\/stop$/.exec(path)
  if (stop) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const [, threadId, taskId] = stop
    if (taskId !== undefined && !TASK_ID.test(taskId)) {
      sendJson(res, 400, { error: 'invalid task id' })
      return true
    }
    ;(taskId === undefined ? jobs.stopThread(threadId) : jobs.stopTask(threadId, taskId)).then(
      () => {
        res.writeHead(204)
        res.end()
      },
      (error: unknown) => sendError(res, error),
    )
    return true
  }
  const permission = /^\/api\/claude\/threads\/([0-9a-f-]{36})\/permissions\/([0-9a-f-]{36})$/.exec(path)
  if (permission) {
    if (req.method !== 'POST') return methodNotAllowed(res)
    const [, threadId, permissionId] = permission
    void answerPermission(req, res, jobs, threadId, permissionId)
    return true
  }
  const thread = /^\/api\/claude\/threads\/([0-9a-f-]{36})$/.exec(path)
  if (thread) {
    const [, threadId] = thread
    if (req.method === 'GET') {
      const found = jobs.thread(threadId)
      if (found) sendJson(res, 200, found)
      else sendJson(res, 404, { error: 'thread not found' })
    } else if (req.method === 'DELETE') {
      jobs.deleteThread(threadId).then(
        () => {
          res.writeHead(204)
          res.end()
        },
        (error: unknown) => sendError(res, error),
      )
    } else {
      methodNotAllowed(res)
    }
    return true
  }
  if (path === `${PREFIX}/jobs`) {
    if (req.method === 'POST') void startJob(req, res, jobs)
    else methodNotAllowed(res)
    return true
  }
  const match = /^\/api\/claude\/jobs\/([0-9a-f-]{36})(\/cancel)?$/.exec(path)
  if (!match) {
    sendJson(res, 404, { error: 'not found' })
    return true
  }
  const [, id, cancel] = match
  try {
    if (cancel) {
      if (req.method !== 'POST') return methodNotAllowed(res)
      sendJson(res, 200, { job: jobs.cancel(id) })
    } else {
      if (req.method !== 'GET') return methodNotAllowed(res)
      const job = jobs.get(id)
      if (job) sendJson(res, 200, { job })
      else sendJson(res, 404, { error: 'job not found' })
    }
  } catch (error) {
    sendError(res, error)
  }
  return true
}

async function startJob(req: IncomingMessage, res: ServerResponse, jobs: ClaudeJobs): Promise<void> {
  try {
    const job = jobs.start(parseStart(await readJson(req)))
    sendJson(res, 201, { job })
  } catch (error) {
    sendError(res, error)
  }
}

async function answerPermission(req: IncomingMessage, res: ServerResponse, jobs: ClaudeJobs, threadId: string, permissionId: string): Promise<void> {
  try {
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
    if (type !== 'application/json') throw new JobError(415, 'content-type must be application/json')
    const body = await readJson(req)
    const decision = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).decision : undefined
    if (decision !== 'allow' && decision !== 'deny') throw new JobError(400, "decision must be 'allow' or 'deny'")
    jobs.answerPermission(threadId, permissionId, decision)
    res.writeHead(204)
    res.end()
  } catch (error) {
    sendError(res, error)
  }
}

export function parseStart(body: unknown): StartRequest {
  if (typeof body !== 'object' || body === null) throw new JobError(400, 'invalid body')
  const { prompt, refId, canvasId, threadId, model, effort } = body as Record<string, unknown>
  if (typeof prompt !== 'string') throw new JobError(400, 'prompt is required')
  if (model !== undefined && model !== null && model !== '' && !isModelName(model)) throw new JobError(400, 'invalid model')
  if (effort !== undefined && effort !== null && effort !== '' && !isEffortLevel(effort)) throw new JobError(400, 'invalid effort')
  const optional = (value: unknown, name: string): string | undefined => {
    if (value === undefined || value === null || value === '') return undefined
    if (typeof value !== 'string' || value.length > 200) throw new JobError(400, `invalid ${name}`)
    return value
  }
  const ref = optional(refId, 'refId')
  const normalized = ref === undefined ? undefined : normalizeRefId(ref)
  if (normalized === null) throw new JobError(400, 'invalid refId')
  const canvas = optional(canvasId, 'canvasId')
  const thread = optional(threadId, 'threadId')
  return {
    prompt,
    ...(normalized ? { refId: normalized } : {}),
    ...(canvas ? { canvasId: canvas } : {}),
    ...(thread ? { threadId: thread } : {}),
    ...(isModelName(model) ? { model } : {}),
    ...(isEffortLevel(effort) ? { effort } : {}),
  }
}

function streamEvents(req: IncomingMessage, res: ServerResponse, jobs: ClaudeJobs): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    // 途中のプロキシに溜めさせない
    'x-accel-buffering': 'no',
  })
  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`)
  send({ type: 'snapshot', threads: jobs.threads(), running: jobs.runningJobs() })
  const unsubscribe = jobs.subscribe(send)
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS)
  heartbeat.unref()
  req.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
  })
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new JobError(413, 'request body too large')
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new JobError(400, 'invalid JSON')
  }
}

export function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof JobError) {
    sendJson(res, error.status, { error: error.message })
    return
  }
  console.error('a Claude request failed', error)
  sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
}

function methodNotAllowed(res: ServerResponse): true {
  sendJson(res, 405, { error: 'method not allowed' })
  return true
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
