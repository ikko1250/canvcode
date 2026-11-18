import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AssetStore, ensurePdfTextFile, parseRange, pdfTextFile } from './assets.ts'

// PDF から取り出したテキストのファイル（AI に渡す ref に付ける）

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('pdfTextFile', () => {
  it('marks each page and separates pages with a form feed', () => {
    expect(pdfTextFile(['a\nb', 'c\n', ''])).toBe('=== page 1 ===\na\nb\n\f=== page 2 ===\nc\n\f=== page 3 ===\n')
    expect(pdfTextFile([])).toBe('')
  })
})

describe('ensurePdfTextFile', () => {
  function dataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'canvcode-assets-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    mkdirSync(join(dir, 'assets'))
    return dir
  }

  it('writes the file from pages.json once, and keeps an existing one', async () => {
    const dir = dataDir()
    const hash = 'd'.repeat(64)
    writeFileSync(join(dir, 'assets', `${hash}.pages.json`), JSON.stringify({ version: 1, pages: ['x'] }))
    const path = join(dir, 'assets', `${hash}.txt`)
    expect(await ensurePdfTextFile(dir, hash)).toEqual({ path, textless: false })
    expect(readFileSync(path, 'utf8')).toBe('=== page 1 ===\nx\n')
    writeFileSync(path, 'kept')
    await ensurePdfTextFile(dir, hash)
    expect(readFileSync(path, 'utf8')).toBe('kept')
  })

  it('tells when no page has text, and returns null without pages.json or for a bad hash', async () => {
    const dir = dataDir()
    const hash = 'e'.repeat(64)
    writeFileSync(join(dir, 'assets', `${hash}.pages.json`), JSON.stringify({ version: 1, pages: [' ', '\n'] }))
    expect((await ensurePdfTextFile(dir, hash))?.textless).toBe(true)
    expect(await ensurePdfTextFile(dir, 'f'.repeat(64))).toBeNull()
    expect(await ensurePdfTextFile(dir, '../x')).toBeNull()
  })
})

// フォントを埋め込まず、定義済みの CMap（UniJIS-UCS2-H）で文字を指す PDF（有価証券報告書などに多い）。
// text は UCS-2 の 16 進で書く
function cidFontPdf(hex: string): Buffer {
  const content = `BT /F1 24 Tf 72 720 Td <${hex}> Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /MS-Mincho /Encoding /UniJIS-UCS2-H /DescendantFonts [5 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /MS-Mincho /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /DW 1000 >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((body, i) => {
    const offset = pdf.length
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
    return offset
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

describe('AssetStore.reextractEmptyPdfTexts', () => {
  it('reads PDFs whose fonts are not embedded, and redoes only the empty text of version 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'canvcode-assets-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const store = new AssetStore(dir)
    await store.init()
    const assets = join(dir, 'assets')
    // 「有価証券」
    const empty = 'a'.repeat(64)
    writeFileSync(join(assets, `${empty}.pdf`), cidFontPdf('67094FA18A3C5238'))
    writeFileSync(join(assets, `${empty}.pages.json`), JSON.stringify({ version: 1, pages: [''] }))
    writeFileSync(join(assets, `${empty}.txt`), '=== page 1 ===\n')
    // 文字のある version 1 は正しく読めていたので、そのまま
    const kept = 'b'.repeat(64)
    writeFileSync(join(assets, `${kept}.pdf`), cidFontPdf('3042'))
    writeFileSync(join(assets, `${kept}.pages.json`), JSON.stringify({ version: 1, pages: ['kept'] }))

    await store.reextractEmptyPdfTexts()

    expect(JSON.parse(readFileSync(join(assets, `${empty}.pages.json`), 'utf8'))).toEqual({ version: 2, pages: ['有価証券'] })
    expect(readFileSync(join(assets, `${empty}.txt`), 'utf8')).toBe('=== page 1 ===\n有価証券\n')
    expect(JSON.parse(readFileSync(join(assets, `${kept}.pages.json`), 'utf8'))).toEqual({ version: 1, pages: ['kept'] })
  })
})

describe('AssetStore.search', () => {
  it('returns the pages with matches, and tells pending, textless and bad requests apart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'canvcode-assets-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const store = new AssetStore(dir)
    await store.init()
    const assets = join(dir, 'assets')
    const hash = 'c'.repeat(64)
    writeFileSync(join(assets, `${hash}.pages.json`), JSON.stringify({ version: 2, pages: ['ＤＸ銘柄', 'なし', 'DX と dx'] }))
    expect(await store.search(hash, 'dx')).toEqual({
      status: 'ok',
      total: 3,
      pages: [
        { pageIndex: 0, count: 1, snippets: ['【ＤＸ】銘柄'] },
        { pageIndex: 2, count: 2, snippets: ['【DX】 と dx', 'DX と 【dx】'] },
      ],
    })
    expect(await store.search('d'.repeat(64), 'dx')).toEqual({ status: 'pending', total: 0, pages: [] })
    const scanned = 'e'.repeat(64)
    writeFileSync(join(assets, `${scanned}.pages.json`), JSON.stringify({ version: 2, pages: [' '] }))
    expect((await store.search(scanned, 'dx')).status).toBe('textless')
    await expect(store.search('../x', 'dx')).rejects.toThrow()
    await expect(store.search(hash, 'x'.repeat(201))).rejects.toThrow()
  })
})

describe('parseRange', () => {
  it('reads one range of a-b, a- and -n, and cuts the end at the file size', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=90-200', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=50-', 100)).toEqual({ start: 50, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-200', 100)).toEqual({ start: 0, end: 99 })
  })

  it('ignores missing, malformed and multiple ranges, and rejects ranges past the end', () => {
    expect(parseRange(undefined, 100)).toBeNull()
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull()
    expect(parseRange('items=0-1', 100)).toBeNull()
    expect(parseRange('bytes=-', 100)).toBeNull()
    expect(parseRange('bytes=9-1', 100)).toBeNull()
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable')
  })
})

describe('AssetStore range requests', () => {
  it('answers 206 with the range, 416 past the end, and 200 for a stale If-Range', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'canvcode-assets-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const store = new AssetStore(dir, { pdftoppm: join(dir, 'no-pdftoppm'), log: () => {} })
    await store.init()
    const body = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256))
    const hash = await store.storeOriginal(body, 'image/png', 10, 10)
    const server = createServer((req, res) => void store.handle(req, res, new URL(req.url ?? '/', 'http://localhost').pathname))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => server.close())
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/assets/${hash}`

    const full = await fetch(url)
    expect(full.status).toBe(200)
    expect(full.headers.get('accept-ranges')).toBe('bytes')
    expect(full.headers.get('etag')).toBe(`"${hash}"`)
    expect(Buffer.from(await full.arrayBuffer())).toEqual(body)

    const part = await fetch(url, { headers: { range: 'bytes=100-199' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 100-199/1000')
    expect(part.headers.get('content-length')).toBe('100')
    expect(Buffer.from(await part.arrayBuffer())).toEqual(body.subarray(100, 200))

    const tail = await fetch(url, { headers: { range: 'bytes=-10' } })
    expect(Buffer.from(await tail.arrayBuffer())).toEqual(body.subarray(990))

    const outside = await fetch(url, { headers: { range: 'bytes=1000-' } })
    expect(outside.status).toBe(416)
    expect(outside.headers.get('content-range')).toBe('bytes */1000')

    const multiple = await fetch(url, { headers: { range: 'bytes=0-1,5-6' } })
    expect(multiple.status).toBe(200)
    await multiple.arrayBuffer()

    const sameVersion = await fetch(url, { headers: { range: 'bytes=0-9', 'if-range': `"${hash}"` } })
    expect(sameVersion.status).toBe(206)
    await sameVersion.arrayBuffer()
    const stale = await fetch(url, { headers: { range: 'bytes=0-9', 'if-range': '"other"' } })
    expect(stale.status).toBe(200)
    expect((await stale.arrayBuffer()).byteLength).toBe(1000)
  })
})

// SVG の画像（MAI-116）：ブラウザが消毒したものだけを受け取り、大きさはサーバーで読み、スクリプトを動かさない CSP を付けて配る
describe('AssetStore SVG images', () => {
  const CLEAN = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 -960 960 960"><path d="M0-480h960"/></svg>'
  const UNSAFE = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 -960 960 960" onload="alert(1)"><path d="M0-480h960"/></svg>'

  async function serve() {
    const dir = mkdtempSync(join(tmpdir(), 'canvcode-assets-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const store = new AssetStore(dir, { pdftoppm: join(dir, 'no-pdftoppm'), log: () => {} })
    await store.init()
    const server = createServer((req, res) => void store.handle(req, res, new URL(req.url ?? '/', 'http://localhost').pathname))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => server.close())
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/assets`
    const post = (body: string, headers: Record<string, string> = {}) =>
      fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'image/svg+xml', 'x-canvcode-sha256': sha256(body), 'x-canvcode-width': '1', 'x-canvcode-height': '1', ...headers },
        body,
      })
    return { dir, store, base, post }
  }

  function sha256(text: string): string {
    return createHash('sha256').update(text).digest('hex')
  }

  it('stores a sanitized SVG with the size read from it, and serves it with a CSP that runs no script', async () => {
    const { dir, base, post } = await serve()
    const response = await post(CLEAN)
    expect(response.status).toBe(200)
    const hash = sha256(CLEAN)
    expect(await response.json()).toEqual({ hash, mime: 'image/svg+xml', size: CLEAN.length })
    // ブラウザが送ってきた大きさ（1×1）ではなく、SVG の width・height
    expect(JSON.parse(readFileSync(join(dir, 'assets', `${hash}.json`), 'utf8'))).toMatchObject({ mime: 'image/svg+xml', width: 24, height: 24, variants: {} })
    expect(readFileSync(join(dir, 'assets', `${hash}.svg`), 'utf8')).toBe(CLEAN)
    const list = (await (await fetch(base)).json()) as { assets: unknown[] }
    expect(list.assets).toEqual([{ hash, mime: 'image/svg+xml', size: CLEAN.length, width: 24, height: 24, variants: [] }])

    const served = await fetch(`${base}/${hash}`)
    expect(served.headers.get('content-type')).toBe('image/svg+xml')
    expect(served.headers.get('x-content-type-options')).toBe('nosniff')
    expect(served.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox")
    expect(await served.text()).toBe(CLEAN)
    // 縮小版はない
    expect((await fetch(`${base}/${hash}/256`)).status).toBe(404)
  })

  it('refuses an SVG that is not sanitized, or that it cannot read, and stores nothing', async () => {
    const { dir, post } = await serve()
    const unsafe = await post(UNSAFE)
    expect(unsafe.status).toBe(422)
    expect(await unsafe.json()).toEqual({ error: 'the svg is not sanitized' })
    const broken = await post('<svg><g></svg>')
    expect(broken.status).toBe(422)
    expect(((await broken.json()) as { error: string }).error).toMatch(/^unreadable svg/)
    const large = await post(`<svg>${' '.repeat(10 * 1024 * 1024)}</svg>`)
    expect(large.status).toBe(413)
    expect(readdirSync(join(dir, 'assets'))).toEqual([])
  })

  it('sanitizes SVGs stored from elsewhere (storeOriginal), and keeps SVG file cards as they are', async () => {
    const { dir, store } = await serve()
    const hash = await store.storeOriginal(Buffer.from(UNSAFE), 'image/svg+xml', 0, 0)
    expect(hash).toBe(sha256(CLEAN))
    expect(readFileSync(join(dir, 'assets', `${hash}.svg`), 'utf8')).toBe(CLEAN)
    await expect(store.storeOriginal(Buffer.from('<html/>'), 'image/svg+xml', 0, 0)).rejects.toMatchObject({ status: 422 })
    // ファイルのカード（MAI-100）の原本は、元のまま（画像としては描かない。配るときは同じ CSP を付ける）
    const file = await store.storeFile(Buffer.from(UNSAFE), 'image/svg+xml', 'svg')
    expect(readFileSync(join(dir, 'assets', `${file}.svg`), 'utf8')).toBe(UNSAFE)
  })
})
