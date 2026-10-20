import type { IncomingMessage, ServerResponse } from 'node:http'
import { normalizeRefId } from '@canvcode/core'
import { JobError, type ClaudeJobs, type StartRequest } from './jobs.ts'

// 画面から Claude Code に頼む API（claude/jobs.ts）。
// - POST /api/claude/jobs { prompt, refId?, canvasId?, threadId? }：頼む（threadId があれば、その会話の続き）。201 { job }
// - GET /api/claude/jobs：ジョブの一覧（新しいものから。出来事も含む）
// - GET /api/claude/jobs/<id>：1 つのジョブ
// - POST /api/claude/jobs/<id>/cancel：止める
// - GET /api/claude/events：変化を SSE で送る。つないだときに { type: 'snapshot', jobs }、そのあと変わるたびに
//   { type: 'job', job, events, from }（events はジョブの from 番目からの出来事）
// jobs がなければ（CANVCODE_CLAUDE=0）、どれも 404 を返す。画面はそれを見て入口を出さない

const PREFIX = '/api/claude'
const MAX_BODY = 64 * 1024
// 経路の途中（Tailscale Serve など）で、黙っている接続を切られないように送る
const HEARTBEAT_MS = 25_000

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
  if (path === `${PREFIX}/jobs`) {
    if (req.method === 'GET') sendJson(res, 200, { jobs: jobs.list() })
    else if (req.method === 'POST') void startJob(req, res, jobs)
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

export function parseStart(body: unknown): StartRequest {
  if (typeof body !== 'object' || body === null) throw new JobError(400, 'invalid body')
  const { prompt, refId, canvasId, threadId } = body as Record<string, unknown>
  if (typeof prompt !== 'string') throw new JobError(400, 'prompt is required')
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
  send({ type: 'snapshot', jobs: jobs.list() })
  const unsubscribe = jobs.subscribe((job, events, from) => send({ type: 'job', job, events, from }))
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS)
  heartbeat.unref()
  req.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
  })
}

async function readJson(req: IncomingMessage): Promise<unknown> {
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

function sendError(res: ServerResponse, error: unknown): void {
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
