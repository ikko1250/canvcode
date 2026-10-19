import { lookup } from 'node:dns'
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'

// リンクのカードに出す、リンク先のページのタイトル・説明・サムネイル（OGP）を取ってくる。
// ブラウザからは CORS でほかのサイトのページを読めないので、サーバーが代わりに取ってくる。
// - GET /api/link-preview?url=<ページ> → { title, description, siteName, image }（image はサムネイルの URL）
// - GET /api/link-preview/image?url=<画像> → 画像の中身（画面がそれを Asset に取り込む）
// - GET /api/link-preview/pdf?url=<PDF> → PDF の中身（画面がそれを取り込み、PDF の Portal を作る）。名前は x-canvcode-filename
// 安全のため：
// - http と https だけを取りに行く
// - 名前を引いた先が、このマシン・LAN の中など（ループバック・プライベート・リンクローカルなど）なら断る。
//   アドレスは接続するときの lookup で確かめるので、確かめたあとで名前の向き先を変えられても（DNS rebinding）、そこへはつながない
// - リダイレクトは自分でたどり、たどるたびに同じように確かめる
// - 時間と大きさに上限を設ける

const TIMEOUT_MS = 8000
const MAX_REDIRECTS = 5
const MAX_HTML_BYTES = 1024 * 1024
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
// PDF は大きく、取るのに時間がかかる（Asset に置ける上限は 200MB）
const MAX_PDF_BYTES = 100 * 1024 * 1024
const PDF_TIMEOUT_MS = 60_000
const CACHE_MS = 10 * 60 * 1000
const MAX_CACHE = 200
const USER_AGENT = 'Mozilla/5.0 (compatible; CanvCode link preview)'

// Asset に取り込める画像（apps/server の assets.ts、packages/canvas の assets.ts と同じ。PDF は除く）
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']

export interface LinkPreview {
  title: string | null
  description: string | null
  siteName: string | null
  // サムネイルの候補の先頭（images[0]）
  image: string | null
  // サムネイルの候補（よさそうな順）と、サイトのアイコンの候補
  images: string[]
  icons: string[]
}

export interface RemoteResponse {
  url: string
  contentType: string
  // Content-Disposition（PDF のファイルの名前を読む）
  contentDisposition?: string
  body: Buffer
}

// 取りに行く関数（テストで差し替える）。timeoutMs を省くと TIMEOUT_MS
export type FetchRemote = (url: string, maxBytes: number, accept: string, timeoutMs?: number) => Promise<RemoteResponse>

// ---- アドレスの確かめ ----

const blocked = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4')
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6')
}

// つないではいけないアドレス（このマシン、LAN の中、使われないはずのアドレスなど）か
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return blocked.check(address, 'ipv4')
  if (family !== 6) return true
  // ::ffff:127.0.0.1 のような、IPv4 を埋めた IPv6 は、中の IPv4 で確かめる
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped) return blocked.check(mapped[1], 'ipv4')
  return blocked.check(address, 'ipv6')
}

// 接続するときの名前引き。引いた先が 1 つでも断るアドレスなら、つながない
export const safeLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '', 0)
    const list = addresses as unknown as { address: string; family: number }[]
    if (list.length === 0 || list.some((a) => isBlockedAddress(a.address))) {
      return callback(Object.assign(new Error(`blocked address for ${hostname}`), { code: 'EBLOCKED' }), '', 0)
    }
    if (options.all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list)
    callback(null, list[0].address, list[0].family)
  })
}

export function allowedUrl(raw: string): URL | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  // IP アドレスを直接書いたものは、名前引きを通らないので、ここで確かめる
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && isBlockedAddress(host)) return null
  if (host === 'localhost' || host.endsWith('.localhost')) return null
  return url
}

// ---- 取りに行く ----

export const fetchRemote: FetchRemote = async (raw, maxBytes, accept, timeoutMs = TIMEOUT_MS) => {
  let current = raw
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const url = allowedUrl(current)
    if (!url) throw new Error(`refused url: ${current}`)
    const response = await requestOnce(url, maxBytes, accept, timeoutMs)
    if ('redirect' in response) {
      current = new URL(response.redirect, url).href
      continue
    }
    return response
  }
  throw new Error('too many redirects')
}

function requestOnce(url: URL, maxBytes: number, accept: string, timeoutMs: number): Promise<RemoteResponse | { redirect: string }> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: 'GET',
        lookup: safeLookup,
        timeout: TIMEOUT_MS,
        headers: { 'user-agent': USER_AGENT, accept, 'accept-encoding': 'gzip, deflate, br', 'accept-language': 'ja,en;q=0.8' },
      },
      (response) => {
        const status = response.statusCode ?? 0
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume()
          resolve({ redirect: response.headers.location })
          return
        }
        if (status < 200 || status >= 300) {
          response.resume()
          reject(new Error(`HTTP ${status}`))
          return
        }
        readBody(response, maxBytes).then(
          (body) =>
            resolve({
              url: url.href,
              contentType: String(response.headers['content-type'] ?? ''),
              contentDisposition: response.headers['content-disposition'],
              body,
            }),
          reject,
        )
      },
    )
    // 全体の時間の上限（timeout は、やり取りが止まっている時間の上限）
    const timer = setTimeout(() => request.destroy(new Error('timeout')), timeoutMs)
    request.on('close', () => clearTimeout(timer))
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', reject)
    request.end()
  })
}

function readBody(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase()
  const stream =
    encoding === 'gzip' ? response.pipe(createGunzip()) : encoding === 'br' ? response.pipe(createBrotliDecompress()) : encoding === 'deflate' ? response.pipe(createInflate()) : response
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    stream.on('data', (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size > maxBytes) {
        // HTML は先頭（<head>）が読めれば足りるので、上限までで打ち切る
        chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)))
        done = true
        response.destroy()
        resolve(Buffer.concat(chunks))
        return
      }
      chunks.push(chunk)
    })
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

// ---- HTML を読む ----

// Content-Type か <meta charset> に書かれた文字コードで読む（日本語のサイトには Shift_JIS・EUC-JP がまだある）
export function decodeHtml(body: Buffer, contentType: string): string {
  const head = body.subarray(0, 4096).toString('latin1')
  const charset =
    /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ??
    'utf-8'
  try {
    return new TextDecoder(charset).decode(body)
  } catch {
    return new TextDecoder('utf-8').decode(body)
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return ENTITIES[name.toLowerCase()] ?? match
  })
}

function clean(text: string | undefined, max: number): string | null {
  if (!text) return null
  const value = decodeEntities(text).replace(/\s+/g, ' ').trim()
  if (!value) return null
  return value.length > max ? value.slice(0, max - 1) + '…' : value
}

function attributes(tag: string): Map<string, string> {
  const attrs = new Map<string, string>()
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    const key = m[1].toLowerCase()
    if (!attrs.has(key)) attrs.set(key, m[2] ?? m[3] ?? m[4] ?? '')
  }
  return attrs
}

// 絶対 URL（http・https だけ）にする
function absolute(raw: string | undefined, base: string): string | null {
  const value = raw ? decodeEntities(raw).trim() : ''
  if (!value || value.startsWith('data:')) return null
  try {
    const url = new URL(value, base)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

// 本文の画像のうち、サムネイルにならないもの（ロゴ・アイコン・広告の計測用の 1 画素など）
const NOT_A_PICTURE = /logo|icon|sprite|avatar|blank|spacer|pixel|tracking|badge|button|emoji|loading|placeholder/i
const MAX_BODY_IMAGES = 3
const MAX_IMAGES = 6

// JSON-LD（<script type="application/ld+json">）の "image"。文字列・{ url }・その配列のどれでもよい
function jsonLdImages(html: string): string[] {
  const found: string[] = []
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || found.length >= 2) return
    if (Array.isArray(value)) for (const item of value) visit(item, depth + 1)
    else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      const image = record.image ?? record.thumbnailUrl
      const add = (v: unknown): void => {
        if (typeof v === 'string') found.push(v)
        else if (Array.isArray(v)) v.forEach(add)
        else if (v && typeof v === 'object' && typeof (v as { url?: unknown }).url === 'string') found.push((v as { url: string }).url)
      }
      add(image)
      for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage']) if (key in record) visit(record[key], depth + 1)
    }
  }
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      visit(JSON.parse(m[1]), 0)
    } catch {
      // 壊れた JSON-LD は使わない
    }
  }
  return found
}

// 本文の <img> のうち、写真らしいもの（遅延読み込みの data-src なども見る。小さいと書かれたもの・SVG は除く）
function bodyImages(html: string): string[] {
  const found: string[] = []
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    const attrs = attributes(tag)
    const src = attrs.get('data-src') ?? attrs.get('data-lazy-src') ?? attrs.get('data-original') ?? attrs.get('src') ?? attrs.get('srcset')?.split(/\s+/)[0]
    if (!src || /\.svg(\?|#|$)/i.test(src) || NOT_A_PICTURE.test(src) || NOT_A_PICTURE.test(attrs.get('class') ?? '')) continue
    const width = Number(attrs.get('width'))
    const height = Number(attrs.get('height'))
    if ((width && width < 120) || (height && height < 80)) continue
    found.push(src)
    if (found.length >= MAX_BODY_IMAGES) break
  }
  return found
}

// <head> の <meta> と <title> から、タイトル・説明・サイトの名前を取り出し、
// サムネイルの候補（images）とサイトのアイコンの候補（icons）を、よさそうな順に並べる。
// 画面は images を前から試し、取れたものを使う。どれも取れなければ icons を試す
export function parsePreview(html: string, pageUrl: string): LinkPreview {
  const end = html.search(/<\/head\s*>|<body[\s>]/i)
  const head = end >= 0 ? html.slice(0, end) : html
  const meta = new Map<string, string>()
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(tag)
    const key = (attrs.get('property') ?? attrs.get('name') ?? attrs.get('itemprop'))?.toLowerCase()
    const content = attrs.get('content')
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content)
  }
  const links = [...head.matchAll(/<link\b[^>]*>/gi)].map(([tag]) => attributes(tag))
  const rel = (attrs: Map<string, string>) => (attrs.get('rel') ?? '').toLowerCase().split(/\s+/)
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]

  const candidates = [
    meta.get('og:image'),
    meta.get('og:image:url'),
    meta.get('og:image:secure_url'),
    meta.get('twitter:image'),
    meta.get('twitter:image:src'),
    meta.get('image'),
    meta.get('thumbnail'),
    ...links.filter((attrs) => rel(attrs).includes('image_src')).map((attrs) => attrs.get('href')),
    ...jsonLdImages(html),
    ...bodyImages(end >= 0 ? html.slice(end) : html),
  ]
  const images = unique(candidates.map((raw) => absolute(raw, pageUrl))).slice(0, MAX_IMAGES)

  // アイコンは大きいものから（apple-touch-icon は 180 画素ほど）。最後に /favicon.ico
  const size = (attrs: Map<string, string>) => Math.max(0, ...(attrs.get('sizes') ?? '').split(/\s+/).map((s) => Number(s.split('x')[0]) || 0))
  const iconLinks = links
    .filter((attrs) => rel(attrs).some((r) => r === 'icon' || r === 'apple-touch-icon' || r === 'apple-touch-icon-precomposed'))
    .filter((attrs) => !/svg/i.test(attrs.get('type') ?? '') && !/\.svg(\?|#|$)/i.test(attrs.get('href') ?? ''))
    .map((attrs) => ({ href: attrs.get('href'), size: size(attrs) || (rel(attrs).some((r) => r.startsWith('apple-touch-icon')) ? 180 : 32) }))
    .sort((a, b) => b.size - a.size)
  const icons = unique([...iconLinks.map((icon) => absolute(icon.href, pageUrl)), absolute('/favicon.ico', pageUrl)]).slice(0, 3)

  return {
    title: clean(meta.get('og:title') ?? meta.get('twitter:title') ?? titleTag, 300),
    description: clean(meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'), 500),
    siteName: clean(meta.get('og:site_name') ?? meta.get('application-name'), 100),
    image: images[0] ?? null,
    images,
    icons,
  }
}

function unique(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => v !== null))]
}

// .ico の中の PNG（いちばん大きいもの）。Asset には .ico のままでは入れられないので、PNG で入っていれば取り出す
export function pngFromIco(body: Buffer): Buffer | null {
  if (body.length < 6 || body.readUInt16LE(0) !== 0 || body.readUInt16LE(2) !== 1) return null
  const count = body.readUInt16LE(4)
  let best: Buffer | null = null
  let bestSize = -1
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16
    if (entry + 16 > body.length) break
    const size = body[entry] || 256
    const length = body.readUInt32LE(entry + 8)
    const offset = body.readUInt32LE(entry + 12)
    if (offset + length > body.length || size <= bestSize) continue
    const data = body.subarray(offset, offset + length)
    if (imageType('', data) !== 'image/png') continue
    best = data
    bestSize = size
  }
  return best
}

// 中身の先頭から画像の種類を見分ける（Content-Type が書かれていないサーバーがある）
export function imageType(contentType: string, body: Buffer): string | null {
  const declared = contentType.split(';')[0].trim().toLowerCase()
  if (IMAGE_TYPES.includes(declared)) return declared
  if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg'
  if (body.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (body.subarray(0, 4).toString('latin1') === 'RIFF' && body.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

// ---- PDF ----

// 中身が PDF か（%PDF- は、先頭の 1024 バイトのどこかにあればよい）
export function isPdfBody(body: Buffer): boolean {
  return body.subarray(0, 1024).includes('%PDF-')
}

// PDF の名前（.pdf は付けない）。Content-Disposition の filename* → filename → URL のパスの最後の順に探す
export function pdfFileName(contentDisposition: string | undefined, url: string): string {
  const disposition = contentDisposition ?? ''
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(disposition)
  const candidates = [/filename\*\s*=\s*[\w-]*'[^']*'([^;]+)/i.exec(disposition)?.[1], plain?.[1] ?? plain?.[2]]
  try {
    candidates.push(new URL(url).pathname.split('/').pop())
  } catch {
    // 名前を決められない URL は、最後の 'PDF' にする
  }
  for (const candidate of candidates) {
    if (!candidate) continue
    let name = candidate
    try {
      name = decodeURIComponent(candidate)
    } catch {
      // % の続きがおかしいものは、そのまま使う
    }
    // フォルダの区切りと制御文字は、名前に入れない
    name = [...name.split(/[\\/]/).pop()!]
      .filter((char) => char.charCodeAt(0) >= 0x20)
      .join('')
      .trim()
      .replace(/\.pdf$/i, '')
    if (name) return name
  }
  return 'PDF'
}

// ---- 受け付け ----

export class LinkPreviewService {
  private readonly fetch: FetchRemote
  private readonly cache = new Map<string, { expires: number; value: Promise<LinkPreview> }>()

  constructor(fetch: FetchRemote = fetchRemote) {
    this.fetch = fetch
  }

  preview(url: string): Promise<LinkPreview> {
    const now = Date.now()
    const hit = this.cache.get(url)
    if (hit && hit.expires > now) return hit.value
    const value = this.fetch(url, MAX_HTML_BYTES, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5').then((response) => {
      const type = response.contentType.toLowerCase()
      if (type && !type.includes('html') && !type.includes('xml')) return { title: null, description: null, siteName: null, image: null, images: [], icons: [] }
      return parsePreview(decodeHtml(response.body, response.contentType), response.url)
    })
    // 失敗したものは覚えておかない（次に頼まれたら、また取りに行く）
    value.catch(() => this.cache.delete(url))
    this.cache.delete(url)
    this.cache.set(url, { expires: now + CACHE_MS, value })
    while (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!)
    return value
  }

  async image(url: string): Promise<{ type: string; body: Buffer } | null> {
    const response = await this.fetch(url, MAX_IMAGE_BYTES + 1, 'image/webp,image/png,image/jpeg,image/*;q=0.8')
    if (response.body.length > MAX_IMAGE_BYTES) return null
    const type = imageType(response.contentType, response.body)
    if (type) return { type, body: response.body }
    const png = pngFromIco(response.body)
    return png ? { type: 'image/png', body: png } : null
  }

  // リンク先の PDF。大きすぎれば 'too large'、PDF でなければ null
  async pdf(url: string): Promise<{ name: string; body: Buffer } | 'too large' | null> {
    const response = await this.fetch(url, MAX_PDF_BYTES + 1, 'application/pdf,*/*;q=0.5', PDF_TIMEOUT_MS)
    if (response.body.length > MAX_PDF_BYTES) return 'too large'
    // Content-Type は当てにしない（application/octet-stream で返すサーバーがある）
    if (!isPdfBody(response.body)) return null
    return { name: pdfFileName(response.contentDisposition, response.url), body: response.body }
  }

  async handle(req: IncomingMessage, res: ServerResponse, pathname: string, params: URLSearchParams): Promise<boolean> {
    if (pathname !== '/api/link-preview' && pathname !== '/api/link-preview/image' && pathname !== '/api/link-preview/pdf') return false
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    const url = allowedUrl(params.get('url') ?? '')
    if (!url) {
      sendJson(res, 400, { error: 'invalid url' })
      return true
    }
    try {
      if (pathname === '/api/link-preview') {
        sendJson(res, 200, await this.preview(url.href))
        return true
      }
      if (pathname === '/api/link-preview/pdf') {
        const pdf = await this.pdf(url.href)
        if (pdf === 'too large') sendJson(res, 413, { error: 'too large' })
        else if (!pdf) sendJson(res, 415, { error: 'not a pdf' })
        else {
          res.writeHead(200, {
            'content-type': 'application/pdf',
            'content-length': pdf.body.length,
            'x-canvcode-filename': encodeURIComponent(pdf.name),
            'cache-control': 'no-store',
          })
          res.end(pdf.body)
        }
        return true
      }
      const image = await this.image(url.href)
      if (!image) {
        sendJson(res, 415, { error: 'not an image' })
        return true
      }
      res.writeHead(200, { 'content-type': image.type, 'content-length': image.body.length, 'cache-control': 'private, max-age=600' })
      res.end(image.body)
    } catch (error) {
      sendJson(res, 502, { error: error instanceof Error ? error.message : 'fetch failed' })
    }
    return true
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
