import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AssetStore, ensurePdfTextFile, pdfTextFile } from './assets.ts'

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
