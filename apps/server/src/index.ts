import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { WebSocketServer, type WebSocket } from 'ws'
import { AgentHost } from './agent/host.ts'
import { handleAgentOps } from './agent/ops.ts'
import { AssetStore } from './assets.ts'
import { CompressedFiles, isCompressible, pickEncoding } from './compress.ts'
import { handleBackupStatus } from './backupStatus.ts'
import { handleClaude } from './claude/http.ts'
import { ClaudeJobs, claudeLimitsFromEnv } from './claude/jobs.ts'
import { ClaudeStore } from './claude/store.ts'
import { FileStore, type FileEvent } from './files.ts'
import { handleImport } from './import/import.ts'
import { LinkPreviewService } from './linkPreview.ts'
import { MarkdownPdf } from './markdownPdf.ts'
import { handleMcp, MCP_PATH } from './mcp.ts'
import { Plotter } from './plot.ts'
import { RecordStore } from './records.ts'
import { REF_SWEEP_INTERVAL_MS, sweepRefs } from './refCleanup.ts'
import { RefImageStore } from './refImages.ts'
import { STORAGE_SWEEP_INTERVAL_MS, sweepStorage } from './storageCleanup.ts'
import { handleRefs } from './refs.ts'
import { cleanupSlidesV1, describeSlidesV1Cleanup } from './slidesV1Cleanup.ts'
import { SyncHub } from './sync.ts'
import { ThumbnailStore } from './thumbnails.ts'

// CanvCode のサーバー（MAI-4）。
// - VPS 上で 127.0.0.1 でのみ待ち受け、ローカル PC からは SSH のポートフォワードで開く
// - 本番では、ビルドした画面（apps/web/dist）も同じサーバーから配信する
// - ワークスペースのフォルダ（MAI-13）の .canvcode/ に、画像の Asset を保存する（MAI-26）
// - レコードは .canvcode/workspace.db（SQLite）に保存し、/api/sync の WebSocket で同期する（MAI-11、MAI-13）
// - AI からは /mcp（MCP の Streamable HTTP）で File を読み書きする（MAI-59）。
//   Canvas のノードの書き換え（スライドもここで作る）は、サーバーの中のワークスペース（agent/host.ts）で行い、画面から取り消せる（/api/agent-ops）
// - 定期バックアップ（npm run backup:sync）の状態（.canvcode/backup-status.json）を /api/backup-status で画面に渡す
// - 画面のパネルから Claude Code に頼める（/api/claude。claude/jobs.ts）。Claude Code は canvcode の /mcp を通して Canvas を読み書きする。
//   CANVCODE_CLAUDE=0 で切る。CANVCODE_CLAUDE_MODEL でモデルを、CANVCODE_CLAUDE_MAX_TURNS でターン数の上限（既定 100。claude/jobs.ts の DEFAULT_MAX_TURNS）を、
//   CANVCODE_CLAUDE_MAX_BUDGET_USD で 1 回の依頼の費用の上限（ドル。既定はなし）を変える
// - 表（CSV）からグラフを描く（/api/plot。plot.ts）。python3 と matplotlib で PNG にし、スタイルはワークスペースの style.py
// - 起動したときに、消した v1 のスライドの保存済みのデータを片付ける（slidesV1Cleanup.ts。片付けるものがなければ何もしない）

const HOST = '127.0.0.1'
const PORT = Number(process.env.CANVCODE_PORT ?? 8787)
const WEB_DIST = resolve(fileURLToPath(new URL('../../web/dist', import.meta.url)))

// 裏で走らせた処理が失敗しても、サーバーは止めずに記録だけする（個人用のサーバーなので、止まるほうが困る）
process.on('unhandledRejection', (error) => console.error('unhandled rejection', error))

// ワークスペースのフォルダ：--workspace <フォルダ>、環境変数 CANVCODE_WORKSPACE、どちらもなければ ./workspace
const { values: args } = parseArgs({ options: { workspace: { type: 'string' } }, strict: false })
const WORKSPACE = resolve(
  (typeof args.workspace === 'string' ? args.workspace : undefined) ?? process.env.CANVCODE_WORKSPACE ?? 'workspace',
)
const DATA_DIR = join(WORKSPACE, '.canvcode')
// CANVCODE_PDF_PREVIEW_MID=1 なら、PDF のページの長辺 1024px の画像も作る（既定は縮小画像のシートだけ。Issue #26）
const assets = new AssetStore(DATA_DIR, { mid: process.env.CANVCODE_PDF_PREVIEW_MID === '1' })
await assets.init()
// フォントを埋め込んでいない PDF の、空のまま取り出したテキストを作り直す（裏で行う）
void assets.reextractEmptyPdfTexts()
// PDF のページの画像（縮小画像のシートと、CANVCODE_PDF_PREVIEW_MID=1 なら長辺 1024px の画像）のない PDF の分を、裏で作る（pdfPreview.ts。pdftoppm がなければ作らない）
void assets.previews.init()
const thumbnails = new ThumbnailStore(DATA_DIR)
// リンクのカードのタイトル・サムネイル（リンク先のページを取ってくる）
const linkPreviews = new LinkPreviewService()
await thumbnails.init()
const records = new RecordStore(DATA_DIR)
// v1 のスライド（デッキのカードとスライドの画像のノード、kind が slides の File、キャッシュ）を片付ける。
// 失敗してもサーバーは止めない（画面とサーバーの中のワークスペースは、知らない型のノードを読まずに飛ばす）
try {
  const cleaned = await cleanupSlidesV1(records, DATA_DIR)
  if (cleaned) console.log(describeSlidesV1Cleanup(cleaned))
} catch (error) {
  console.error('v1 のスライドを片付けられませんでした', error)
}
const refImages = new RefImageStore(DATA_DIR)
// 3 日経った ref を消す（MAI-65）。起動したときと、そのあと 1 時間ごと
await sweepRefs(records, refImages)
setInterval(() => void sweepRefs(records, refImages), REF_SWEEP_INTERVAL_MS).unref()
// .canvcode の中のたまっていくもの（deleted/ の 90 日経ったファイル、参照されなくなってから 30 日経った Asset など）を片付ける
// （storageCleanup.ts）。起動したときと、そのあと 1 時間ごと。起動を待たせないよう、裏で行う
void sweepStorage({ workspace: WORKSPACE, dataDir: DATA_DIR, records })
setInterval(() => void sweepStorage({ workspace: WORKSPACE, dataDir: DATA_DIR, records }), STORAGE_SWEEP_INTERVAL_MS).unref()
const sync = new SyncHub(records)

// ブラウザへの知らせ（MAI-10：ファイルが外で変わった、など）
const sockets = new WebSocketServer({ noServer: true })
const clients = new Set<WebSocket>()
sockets.on('connection', (socket) => {
  clients.add(socket)
  socket.on('close', () => clients.delete(socket))
})
function broadcast(event: FileEvent): void {
  const message = JSON.stringify(event)
  for (const client of clients) client.send(message)
}
const files = new FileStore(WORKSPACE, DATA_DIR, broadcast)
await files.init()
// Markdown の File を PDF にする（md2pdf）
const markdownPdf = new MarkdownPdf(files, WORKSPACE, DATA_DIR)
// CSV から作るグラフ（matplotlib。plot.ts）。CANVCODE_PYTHON で python の場所を変える
const plot = new Plotter({ workspace: WORKSPACE, files, ...(process.env.CANVCODE_PYTHON ? { python: process.env.CANVCODE_PYTHON } : {}) })
// AI の編集に使うワークスペース（最初に頼まれたときに作り、しばらく使わなければ捨てる）
const agent = new AgentHost({ records, sync, files })
// 画面から頼む Claude Code
const claude =
  process.env.CANVCODE_CLAUDE === '0'
    ? null
    : new ClaudeJobs({
        workspace: WORKSPACE,
        mcpUrl: `http://${HOST}:${PORT}${MCP_PATH}`,
        // 会話は .canvcode/claude.db に残す（再起動しても続けられる）
        store: new ClaudeStore(DATA_DIR),
        ...(process.env.CANVCODE_CLAUDE_MODEL ? { model: process.env.CANVCODE_CLAUDE_MODEL } : {}),
        ...claudeLimitsFromEnv(process.env),
      })

// 127.0.0.1 でだけ待ち受けていても、ブラウザで開いた別のサイトから localhost に要求を送られることがある。
// DNS の付け替え（DNS rebinding）と、別のサイトからの書き込みを防ぐため、Host と Origin がこのサーバーのものか確かめる
const LOCAL_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?$/
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/
const configuredOrigin = process.env.CANVCODE_TRUSTED_ORIGIN
const trustedOrigin = configuredOrigin ? new URL(configuredOrigin).origin : undefined
if (trustedOrigin && !trustedOrigin.startsWith('https://')) {
  throw new Error('CANVCODE_TRUSTED_ORIGIN must use HTTPS')
}
const trustedHost = trustedOrigin ? new URL(trustedOrigin).host : undefined
function trusted(req: import('node:http').IncomingMessage): boolean {
  const host = req.headers.host ?? ''
  if (!LOCAL_HOST.test(host) && host !== trustedHost) return false
  const origin = req.headers.origin
  return origin === undefined || LOCAL_ORIGIN.test(origin) || origin === trustedOrigin
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // PDF.js の Worker（MAI-32）
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  // PDF.js のスキャン画像のデコーダ（/pdfjs/wasm/）
  '.wasm': 'application/wasm',
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

// ビルドした画面のファイルを、ブラウザが受け取れれば圧縮して送る（compress.ts）
const compressedFiles = new CompressedFiles()

async function sendFile(req: IncomingMessage, res: ServerResponse, path: string, cache: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    const headers = {
      'content-type': MIME_TYPES[extname(path)] ?? 'application/octet-stream',
      'cache-control': cache,
    }
    const encoding = isCompressible(path, info.size) ? pickEncoding(req.headers['accept-encoding']) : null
    if (encoding) {
      const data = await compressedFiles.get(path, info.mtimeMs, encoding)
      res.writeHead(200, { ...headers, 'content-encoding': encoding, 'content-length': data.length, vary: 'Accept-Encoding' })
      res.end(req.method === 'HEAD' ? undefined : data)
      return true
    }
    res.writeHead(200, { ...headers, 'content-length': info.size, ...(isCompressible(path, info.size) ? { vary: 'Accept-Encoding' } : {}) })
    createReadStream(path).pipe(res)
    return true
  } catch {
    return false
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}`)

  if (url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true })
    return
  }
  if ((url.pathname.startsWith('/api/') || url.pathname === MCP_PATH) && !trusted(req)) {
    sendJson(res, 403, { error: 'forbidden origin' })
    return
  }
  // 画面を出す前に止まったときの知らせ（index.html の小さなスクリプトから）。開発者ツールを開けない端末（iPad など）の
  // 白紙の理由を、サーバーのログで見るため。16KB までを 1 行にして出す
  if (url.pathname === '/api/client-log' && req.method === 'POST') {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      if (body.length < 16384) body += chunk
    })
    req.on('end', () => {
      console.error('[client]', body.slice(0, 16384).replace(/\s+/g, ' '))
      res.writeHead(204)
      res.end()
    })
    return
  }
  if (sync.handle(req, res, url.pathname)) return
  if (await handleBackupStatus(req, res, url.pathname, DATA_DIR)) return
  if (handleAgentOps(req, res, url.pathname, agent)) return
  if (handleClaude(req, res, url.pathname, claude)) return
  if (await handleImport(req, res, url.pathname, { dataDir: DATA_DIR, records, files, assets, thumbnails, sync })) return
  if (await thumbnails.handle(req, res, url.pathname)) return
  if (await assets.handle(req, res, url.pathname, url.searchParams)) return
  if (await linkPreviews.handle(req, res, url.pathname, url.searchParams)) return
  if (await handleRefs(req, res, url.pathname, records, refImages, url.searchParams)) return
  if (await markdownPdf.handle(req, res, url.pathname)) return
  if (await plot.handle(req, res, url.pathname)) return
  if (await files.handle(req, res, url.pathname)) return
  if (await handleMcp(req, res, url.pathname, { files, records, dataDir: DATA_DIR, refImages, agent, presence: () => sync.latestPresence(), pdf: { assets, links: linkPreviews }, plot })) return
  if (url.pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'not found' })
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method not allowed' })
    return
  }

  // ビルドした画面の配信。dist の外は読ませない
  const requested = normalize(join(WEB_DIST, decodeURIComponent(url.pathname)))
  if (requested !== WEB_DIST && !requested.startsWith(WEB_DIST + sep)) {
    sendJson(res, 403, { error: 'forbidden' })
    return
  }
  // ファイル名にハッシュが付く assets/ は長くキャッシュさせ、それ以外は毎回確認させる
  const cache = url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
  if (url.pathname !== '/' && (await sendFile(req, res, requested, cache))) return
  // それ以外は画面のルーティングに任せる（/c/<id> など。MAI-8）
  if (await sendFile(req, res, join(WEB_DIST, 'index.html'), 'no-cache')) return
  res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('画面がビルドされていません。先に npm run build を実行してください。\n')
})

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${HOST}`)
  if (!trusted(req)) {
    socket.destroy()
    return
  }
  if (url.pathname === '/api/events') sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit('connection', ws, req))
  else if (url.pathname === '/api/sync') sync.server.handleUpgrade(req, socket, head, (ws) => sync.server.emit('connection', ws, req))
  else socket.destroy()
})

server.listen(PORT, HOST, () => {
  // 画面のファイルを、裏で前もって圧縮しておく（compress.ts）
  void compressedFiles.warm(WEB_DIST).catch(() => {})
  console.log(`CanvCode server: http://${HOST}:${PORT}`)
  console.log(`ワークスペース: ${WORKSPACE}`)
  console.log(`AI（MCP）から使うとき: claude mcp add --transport http canvcode http://${HOST}:${PORT}${MCP_PATH}`)
  console.log(`手元の PC から開くとき: ssh -L ${PORT}:${HOST}:${PORT} <VPS> のあと http://localhost:${PORT}`)
})
