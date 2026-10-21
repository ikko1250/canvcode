import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AssetStore } from './assets.ts'
import { isPdfPreviewFile, packSheets, parsePageSizes, PdfPreviews, type PdfPreviewManifest } from './pdfPreview.ts'

// PDF のページの画像（Issue #26）

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'canvcode-preview-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const hasPoppler = (() => {
  try {
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

// ページごとに大きさ・回転・中身の違う PDF。2 ページ目はフォントを埋め込まない日本語（UniJIS-UCS2-H の「有価証券」）
function samplePdf(): Buffer {
  const latin = 'BT /F1 48 Tf 72 400 Td (Hello) Tj ET 0 0 1 rg 0 0 100 100 re f'
  const japanese = 'BT /F2 96 Tf 40 300 Td <67094FA18A3C5238> Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 9 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F2 7 0 R >> >> /Contents 10 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate 90 /Resources << /Font << /F1 6 0 R >> >> /Contents 9 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /MS-Mincho /Encoding /UniJIS-UCS2-H /DescendantFonts [8 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /MS-Mincho /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /DW 1000 >>',
    `<< /Length ${latin.length} >>\nstream\n${latin}\nendstream`,
    `<< /Length ${japanese.length} >>\nstream\n${japanese}\nendstream`,
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

async function inkedPixels(data: Buffer, box?: { x: number; y: number; w: number; h: number }): Promise<number> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  const image = await loadImage(data)
  const { x, y, w, h } = box ?? { x: 0, y: 0, w: image.width, h: image.height }
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, -x, -y)
  const pixels = ctx.getImageData(0, 0, w, h).data
  let dark = 0
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i] + pixels[i + 1] + pixels[i + 2] < 600) dark++
  return dark
}

describe('packSheets', () => {
  it('fills rows from the left, and starts a new row and a new sheet when they are full', () => {
    const sizes = Array.from({ length: 7 }, () => ({ w: 40, h: 30 }))
    expect(packSheets(sizes, 100)).toEqual({
      sheets: [
        { width: 80, height: 90 },
        { width: 40, height: 30 },
      ],
      thumbs: [
        { sheet: 0, x: 0, y: 0, w: 40, h: 30 },
        { sheet: 0, x: 40, y: 0, w: 40, h: 30 },
        { sheet: 0, x: 0, y: 30, w: 40, h: 30 },
        { sheet: 0, x: 40, y: 30, w: 40, h: 30 },
        { sheet: 0, x: 0, y: 60, w: 40, h: 30 },
        { sheet: 0, x: 40, y: 60, w: 40, h: 30 },
        // 4 行目は高さ 100 に入らないので、次のシートへ
        { sheet: 1, x: 0, y: 0, w: 40, h: 30 },
      ],
    })
  })

  it('makes a row as tall as its tallest image', () => {
    const { thumbs, sheets } = packSheets([{ w: 50, h: 20 }, { w: 50, h: 40 }, { w: 50, h: 10 }], 100)
    expect(thumbs[2]).toEqual({ sheet: 0, x: 0, y: 40, w: 50, h: 10 })
    expect(sheets).toEqual([{ width: 100, height: 50 }])
  })

  it('lays RESONAC-sized pages out in one sheet of 4096 wide', () => {
    const { sheets, thumbs } = packSheets(Array.from({ length: 72 }, () => ({ w: 256, h: 158 })))
    expect(sheets).toEqual([{ width: 4096, height: 158 * 5 }])
    expect(thumbs[16]).toEqual({ sheet: 0, x: 0, y: 158, w: 256, h: 158 })
  })
})

describe('parsePageSizes', () => {
  it('reads each page size and swaps the sides of rotated pages', () => {
    const out = [
      'Pages:           3',
      'Page    1 size:  595.276 x 841.89 pts (A4)',
      'Page    1 rot:   0',
      'Page    2 size:  1114.02 x 685.98 pts',
      'Page    2 rot:   0',
      'Page    3 size:  612 x 792 pts (letter)',
      'Page    3 rot:   270',
      'File size:       1234 bytes',
    ].join('\n')
    expect(parsePageSizes(out)).toEqual([
      { w: 595.276, h: 841.89 },
      { w: 1114.02, h: 685.98 },
      { w: 792, h: 612 },
    ])
    expect(() => parsePageSizes('Pages: 0')).toThrow()
  })
})

describe('isPdfPreviewFile', () => {
  it('tells the page images apart from the original and the other derived files', () => {
    const hash = 'a'.repeat(64)
    expect(isPdfPreviewFile(`${hash}.preview-v1.json`)).toBe(true)
    expect(isPdfPreviewFile(`${hash}.preview-v1.sheet0.webp`)).toBe(true)
    expect(isPdfPreviewFile(`${hash}.preview-v2.p10.webp`)).toBe(true)
    expect(isPdfPreviewFile(`${hash}.pdf`)).toBe(false)
    expect(isPdfPreviewFile(`${hash}.pages.json`)).toBe(false)
    expect(isPdfPreviewFile(`${hash}.256.webp`)).toBe(false)
  })
})

describe('PdfPreviews', () => {
  it.skipIf(!hasPoppler)('makes the sheet and the page images, and draws Japanese text whose font is not embedded', async () => {
    const dir = dataDir()
    const store = new AssetStore(dir, { mid: true, log: () => {} })
    await store.init()
    const hash = await store.storeOriginal(samplePdf(), 'application/pdf', 0, 0)
    await store.previews.idle()

    const manifest = (await store.previews.readManifest(hash))!
    expect(manifest.pages).toEqual([
      { w: 612, h: 792 },
      { w: 842, h: 595 },
      { w: 792, h: 612 },
    ])
    expect(manifest.mid).toEqual({ size: 1024 })
    expect(manifest.sheets).toHaveLength(1)
    // 長辺が 256px で、ページの縦横の比と合う
    for (const [i, thumb] of manifest.thumbs.entries()) {
      const page = manifest.pages[i]
      expect(Math.max(thumb.w, thumb.h)).toBe(256)
      expect(thumb.w / thumb.h).toBeCloseTo(page.w / page.h, 1)
    }
    expect(manifest.thumbs.map(({ x, y }) => [x, y])).toEqual([
      [0, 0],
      [manifest.thumbs[0].w, 0],
      [manifest.thumbs[0].w + manifest.thumbs[1].w, 0],
    ])
    const assets = join(dir, 'assets')
    const sheet = readFileSync(join(assets, `${hash}.preview-v1.sheet0.webp`))
    expect(sheet.subarray(8, 12).toString('latin1')).toBe('WEBP')
    // 1 ページ目の左下の青い四角が、シートの 1 ページ目の位置にある
    expect(await inkedPixels(sheet, { ...manifest.thumbs[0], x: 0, y: manifest.thumbs[0].h - 20, w: 20, h: 20 })).toBeGreaterThan(100)
    // 埋め込まれていない日本語フォントの文字が描かれている
    const mid = readFileSync(join(assets, `${hash}.preview-v1.p1.webp`))
    expect(await inkedPixels(mid)).toBeGreaterThan(500)
    expect(readdirSync(assets).filter((name) => /\.p\d+\.webp$/.test(name))).toHaveLength(3)
  })

  it.skipIf(!hasPoppler)('serves the manifest and the images, and tells pending and unavailable apart', async () => {
    const dir = dataDir()
    const store = new AssetStore(dir, { mid: true, log: () => {} })
    await store.init()
    const assets = join(dir, 'assets')
    // 取り込む前からある PDF（起動したときに順番待ちに入らず、画面が求めたときに作る）
    const hash = 'c'.repeat(64)
    writeFileSync(join(assets, `${hash}.pdf`), samplePdf())
    writeFileSync(join(assets, `${hash}.json`), JSON.stringify({ mime: 'application/pdf', size: 1, variants: {} }))
    const broken = 'd'.repeat(64)
    writeFileSync(join(assets, `${broken}.pdf`), 'not a pdf')
    writeFileSync(join(assets, `${broken}.json`), JSON.stringify({ mime: 'application/pdf', size: 1, variants: {} }))
    const base = await serve(store)

    const pending = await fetch(`${base}/api/assets/${hash}/preview`)
    expect(pending.status).toBe(404)
    expect(await pending.json()).toEqual({ status: 'pending' })
    await fetch(`${base}/api/assets/${broken}/preview`)
    await store.previews.idle()

    const ready = await fetch(`${base}/api/assets/${hash}/preview`)
    expect(ready.status).toBe(200)
    expect(ready.headers.get('cache-control')).toBe('no-cache')
    expect(((await ready.json()) as PdfPreviewManifest).mid).toEqual({ size: 1024 })
    const sheet = await fetch(`${base}/api/assets/${hash}/preview/v1/sheet/0`)
    expect(sheet.status).toBe(200)
    expect(sheet.headers.get('content-type')).toBe('image/webp')
    expect(sheet.headers.get('cache-control')).toContain('immutable')
    expect((await fetch(`${base}/api/assets/${hash}/preview/v1/page/2`)).status).toBe(200)
    expect((await fetch(`${base}/api/assets/${hash}/preview/v1/page/3`)).status).toBe(404)
    expect((await fetch(`${base}/api/assets/${hash}/preview/v2/page/0`)).status).toBe(404)
    expect((await fetch(`${base}/api/assets/${hash}/preview/v1/page/..`)).status).toBe(404)
    expect(await (await fetch(`${base}/api/assets/${broken}/preview`)).json()).toEqual({ status: 'unavailable' })
  })

  it.skipIf(!hasPoppler)('makes only the sheet without the page images by default, and hides page images made before', async () => {
    const dir = dataDir()
    const store = new AssetStore(dir, { log: () => {} })
    await store.init()
    const hash = await store.storeOriginal(samplePdf(), 'application/pdf', 0, 0)
    await store.previews.idle()
    const assets = join(dir, 'assets')
    expect(readdirSync(assets).filter(isPdfPreviewFile).sort()).toEqual([`${hash}.preview-v1.json`, `${hash}.preview-v1.sheet0.webp`])
    const base = await serve(store)
    const manifest = (await (await fetch(`${base}/api/assets/${hash}/preview`)).json()) as PdfPreviewManifest & { pending?: boolean }
    expect(manifest.thumbs).toHaveLength(3)
    expect(manifest.mid).toBeUndefined()
    // 作り終えているので、聞き直させない
    expect(manifest.pending).toBeUndefined()

    // 段 2 を作ったあとに切っても、ページごとの画像は使わせない
    const made = 'f'.repeat(64)
    writeFileSync(join(assets, `${made}.preview-v1.json`), JSON.stringify({ ...manifest, mid: { size: 1024 } }))
    writeFileSync(join(assets, `${made}.preview-v1.p0.webp`), '')
    expect((await (await fetch(`${base}/api/assets/${made}/preview`)).json()).mid).toBeUndefined()
    expect((await fetch(`${base}/api/assets/${made}/preview/v1/page/0`)).status).toBe(404)
  })

  it('makes nothing and answers unavailable without pdftoppm', async () => {
    const dir = dataDir()
    const logs: string[] = []
    const store = new AssetStore(dir, { pdftoppm: join(dir, 'no-pdftoppm'), log: (message) => logs.push(message) })
    await store.init()
    const hash = await store.storeOriginal(samplePdf(), 'application/pdf', 0, 0)
    await store.previews.idle()
    expect(await store.previews.status(hash)).toEqual({ status: 'unavailable' })
    expect(readdirSync(join(dir, 'assets')).some(isPdfPreviewFile)).toBe(false)
    expect(logs).toHaveLength(1)
  })

  it('removes the files of other versions when it starts', async () => {
    const dir = dataDir()
    const store = new AssetStore(dir, { log: () => {} })
    await store.init()
    const assets = join(dir, 'assets')
    const hash = 'e'.repeat(64)
    writeFileSync(join(assets, `${hash}.preview-v0.json`), '{}')
    writeFileSync(join(assets, `${hash}.preview-v0.sheet0.webp`), '')
    writeFileSync(join(assets, `${hash}.preview-v1.json`), JSON.stringify({ version: 1, pages: [], sheets: [], thumbs: [], mid: { size: 1024 } }))
    await new PdfPreviews(assets, { log: () => {} }).init()
    expect(existsSync(join(assets, `${hash}.preview-v0.json`))).toBe(false)
    expect(existsSync(join(assets, `${hash}.preview-v0.sheet0.webp`))).toBe(false)
    expect(existsSync(join(assets, `${hash}.preview-v1.json`))).toBe(true)
  })
})

async function serve(store: AssetStore): Promise<string> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    void store.handle(req, res, url.pathname, url.searchParams).then((handled) => {
      if (!handled) res.writeHead(404).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => server.close())
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
