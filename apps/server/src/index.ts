import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { WebSocketServer, type WebSocket } from 'ws'
import { AssetStore } from './assets.ts'
import { FigureStore } from './figures.ts'
import { FileStore, type FileEvent } from './files.ts'
import { handleImport } from './import/import.ts'
import { handleMcp, MCP_PATH } from './mcp.ts'
import { RecordStore } from './records.ts'
import { RefImageStore } from './refImages.ts'
import { handleRefs } from './refs.ts'
import { SyncHub } from './sync.ts'
import { ThumbnailStore } from './thumbnails.ts'
import { SlidesApi } from './slides.ts'

// CanvCode のサーバー（MAI-4）。
// - VPS 上で 127.0.0.1 でのみ待ち受け、ローカル PC からは SSH のポートフォワードで開く
// - 本番では、ビルドした画面（apps/web/dist）も同じサーバーから配信する
// - ワークスペースのフォルダ（MAI-13）の .canvcode/ に、画像の Asset を保存する（MAI-26）
// - レコードは .canvcode/workspace.db（SQLite）に保存し、/api/sync の WebSocket で同期する（MAI-11、MAI-13）
// - AI からは /mcp（MCP の Streamable HTTP）で File を読み書きし、スライドデッキを作れる（MAI-59）

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
const assets = new AssetStore(DATA_DIR)
await assets.init()
const thumbnails = new ThumbnailStore(DATA_DIR)
await thumbnails.init()
const records = new RecordStore(DATA_DIR)
const refImages = new RefImageStore(DATA_DIR)
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
const figures = new FigureStore(DATA_DIR)
await figures.init()
// フレームがあるか（消したノードは records に残らない）。スライドの図の警告と代わりの絵に使う
const frameExists = (id: string): boolean => records.get(id)?.type === 'frame'
const slides = new SlidesApi(files, WORKSPACE, PORT, DATA_DIR, { figures, frameExists })
const figureHooks = slides.figureHooks()

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
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function sendFile(res: ServerResponse, path: string, cache: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    res.writeHead(200, {
      'content-type': MIME_TYPES[extname(path)] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': cache,
    })
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
  if (sync.handle(req, res, url.pathname)) return
  if (await handleImport(req, res, url.pathname, { dataDir: DATA_DIR, records, files, assets, thumbnails, sync })) return
  if (await thumbnails.handle(req, res, url.pathname)) return
  if (await assets.handle(req, res, url.pathname)) return
  if (await figures.handle(req, res, url.pathname, figureHooks)) return
  if (await slides.handle(req, res, url.pathname, url.searchParams)) return
  if (await handleRefs(req, res, url.pathname, records, refImages, url.searchParams)) return
  if (await files.handle(req, res, url.pathname)) return
  if (await handleMcp(req, res, url.pathname, { files, records, dataDir: DATA_DIR, slides, refImages })) return
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
  if (url.pathname !== '/' && (await sendFile(res, requested, cache))) return
  // それ以外は画面のルーティングに任せる（/c/<id> など。MAI-8）
  if (await sendFile(res, join(WEB_DIST, 'index.html'), 'no-cache')) return
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
  console.log(`CanvCode server: http://${HOST}:${PORT}`)
  console.log(`ワークスペース: ${WORKSPACE}`)
  console.log(`AI（MCP）から使うとき: claude mcp add --transport http canvcode http://${HOST}:${PORT}${MCP_PATH}`)
  console.log(`手元の PC から開くとき: ssh -L ${PORT}:${HOST}:${PORT} <VPS> のあと http://localhost:${PORT}`)
})
