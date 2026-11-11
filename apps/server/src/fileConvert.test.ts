import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { AssetStore, contentDisposition, safeExtension } from './assets.ts'
import { cellText, FileConverter, sheetToCsv } from './fileConvert.ts'
import { FileStore, HttpError } from './files.ts'

// ファイルのカード（attachment）の原本の保存と、docx・xlsx から文書の写しを作ること（MAI-100）

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(options: { pandoc?: string } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'canvcode-convert-'))
  cleanups.push(() => rmSync(workspace, { recursive: true, force: true }))
  const dataDir = join(workspace, '.canvcode')
  mkdirSync(dataDir)
  const events: string[] = []
  const files = new FileStore(workspace, dataDir, (event) => events.push(`${event.type} ${event.file.path}`))
  await files.init()
  cleanups.push(() => files.close())
  const assets = new AssetStore(dataDir)
  await assets.init()
  const converter = new FileConverter({ files, assets, ...options })
  return { workspace, dataDir, files, assets, converter, events }
}

const hasPandoc = spawnSync('pandoc', ['--version']).status === 0

// 小さな PNG（幅 w・高さ h の赤）
function png(w: number, h: number): Buffer {
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, Buffer.from([255, 0, 0]))])
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(w, 0)
  header.writeUInt32BE(h, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// 手で組んだ xlsx。シート「売上」（文字・数・日付・日時・真偽・, と " を含む文字）、シート「空」（何もない）、シート「メモ」
function sampleXlsx(): Buffer {
  const sheets = [
    {
      name: '売上',
      rows: `
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>
        <row r="2"><c r="A2" s="1"><v>46337</v></c><c r="B2"><v>1200.5</v></c><c r="C2" t="b"><v>1</v></c><c r="D2" t="s"><v>4</v></c></row>
        <row r="3"><c r="A3" s="2"><v>46337.5</v></c><c r="B3"><v>-3</v></c><c r="C3" t="b"><v>0</v></c><c r="D3" t="inlineStr"><is><t>直接の文字</t></is></c></row>`,
    },
    { name: '空', rows: '' },
    { name: 'メモ', rows: '<row r="1"><c r="A1" t="s"><v>5</v></c></row>' },
  ]
  const strings = ['日付', '金額', '済み', '備考', '大口, "特別"', 'メモです']
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, i) => `<sheet name="${sheet.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId11" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    'xl/sharedStrings.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t>${s.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}</t></si>`).join('')}</sst>`,
    ),
    // 0：ふつう、1：日付（14）、2：日時（22）
    'xl/styles.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="22" applyNumberFormat="1"/></cellXfs></styleSheet>',
    ),
  }
  for (const [i, sheet] of sheets.entries()) {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet.rows}</sheetData></worksheet>`,
    )
  }
  return Buffer.from(zipSync(files))
}

describe('cellText and sheetToCsv', () => {
  it('writes dates, times, booleans and numbers as text', () => {
    expect(cellText(new Date(Date.UTC(2026, 10, 11)))).toBe('2026-11-11')
    expect(cellText(new Date(Date.UTC(2026, 10, 11, 9, 30)))).toBe('2026-11-11 09:30')
    expect(cellText(new Date(Date.UTC(2026, 10, 11, 9, 30, 5)))).toBe('2026-11-11 09:30:05')
    // 時刻だけのセル（Excel では 1899-12-30 の日付）
    expect(cellText(new Date(Date.UTC(1899, 11, 30, 12, 0)))).toBe('12:00')
    expect(cellText(true)).toBe('TRUE')
    expect(cellText(0.1 + 0.2)).toBe('0.30000000000000004')
    expect(cellText(null)).toBe('')
  })

  it('quotes fields, and drops trailing empty rows and columns', () => {
    expect(sheetToCsv([['a', 'b,c', null], ['say "hi"', 'x\ny', null], [null, null, null]])).toBe('a,"b,c"\n"say ""hi""","x\ny"\n')
    expect(sheetToCsv([[null, ''], []])).toBe('')
  })
})

describe('AssetStore for any kind of file', () => {
  it('keeps the extension, serves the file with its name, and lets it be downloaded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'canvcode-assets-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const assets = new AssetStore(dir)
    await assets.init()
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      void assets.handle(req, res, url.pathname, url.searchParams)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/assets`

    // 拡張子を送らなければ、今までどおり種類で断る
    expect((await fetch(base, { method: 'POST', headers: { 'content-type': 'application/zip' }, body: 'PK' })).status).toBe(415)
    const posted = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/zip', 'x-canvcode-file-ext': 'ZIP' }, body: 'PK zip' })
    expect(posted.status).toBe(200)
    const { hash } = (await posted.json()) as { hash: string }
    expect(readFileSync(join(dir, 'assets', `${hash}.zip`), 'utf8')).toBe('PK zip')
    expect(await assets.originalPath(hash)).toBe(join(dir, 'assets', `${hash}.zip`))

    const opened = await fetch(`${base}/${hash}?name=${encodeURIComponent('資料 (1).zip')}`)
    expect(await opened.text()).toBe('PK zip')
    expect(opened.headers.get('content-type')).toBe('application/zip')
    expect(opened.headers.get('content-disposition')).toBe(`inline; filename="__ (1).zip"; filename*=UTF-8''%E8%B3%87%E6%96%99%20%281%29.zip`)
    const downloaded = await fetch(`${base}/${hash}?name=a.zip&download=1`)
    expect(downloaded.headers.get('content-disposition')).toBe(`attachment; filename="a.zip"; filename*=UTF-8''a.zip`)
    expect(downloaded.headers.get('content-security-policy')).toContain('sandbox')

    // 拡張子の分からないもの・形の崩れた種類
    const odd = await assets.storeFile(Buffer.from('?'), 'not a mime', '../x')
    expect(existsSync(join(dir, 'assets', `${odd}.bin`))).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'assets', `${odd}.json`), 'utf8'))).toMatchObject({ mime: 'application/octet-stream', ext: 'bin' })
  })

  it('makes safe extensions and Content-Disposition values', () => {
    expect(safeExtension('.DOCX')).toBe('docx')
    expect(safeExtension('tar.gz')).toBe('bin')
    expect(safeExtension('')).toBe('bin')
    expect(contentDisposition('attachment', 'a"b;c\n.txt')).toBe(`attachment; filename="a_b_c.txt"; filename*=UTF-8''a%22b%3Bc.txt`)
  })
})

describe('FileConverter', () => {
  it('turns each sheet of an xlsx into a table document, and keeps the original', async () => {
    const { converter, assets, files, workspace, events } = await setup()
    const data = sampleXlsx()
    const hash = await assets.storeFile(data, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx')
    const result = await converter.convert(`asset:${hash}`, '月次.xlsx', 'table')
    expect(result.files.map((file) => [file.kind, file.path])).toEqual([
      ['table', '月次 - 売上.csv'],
      ['table', '月次 - メモ.csv'],
    ])
    expect(result.warnings).toEqual(['シート「空」は空なので、表にしませんでした'])
    expect(readFileSync(join(workspace, '月次 - 売上.csv'), 'utf8')).toBe(
      '日付,金額,済み,備考\n2026-11-11,1200.5,TRUE,"大口, ""特別"""\n2026-11-11 12:00,-3,FALSE,直接の文字\n',
    )
    expect(readFileSync(join(workspace, '月次 - メモ.csv'), 'utf8')).toBe('メモです\n')
    // ほかのタブにも知らせる。元のファイルはそのまま
    expect(events).toEqual(['file-added 月次 - 売上.csv', 'file-added 月次 - メモ.csv'])
    expect(readFileSync((await assets.originalPath(hash))!)).toEqual(data)
    expect(files.list().map((file) => file.path).sort()).toEqual(['月次 - メモ.csv', '月次 - 売上.csv'])

    // もう一度変換すると、別の名前の写しを作る（前の写しを上書きしない）
    const again = await converter.convert(`asset:${hash}`, '月次.xlsx', 'table')
    expect(again.files.map((file) => file.path)).toEqual(['月次 - 売上 2.csv', '月次 - メモ 2.csv'])
  })

  it('refuses other kinds, missing originals and broken files', async () => {
    const { converter, assets } = await setup()
    const zip = await assets.storeFile(Buffer.from('PK'), 'application/zip', 'zip')
    await expect(converter.convert(`asset:${zip}`, 'a.zip', 'table')).rejects.toMatchObject({ status: 415 })
    await expect(converter.convert(`asset:${'0'.repeat(64)}`, 'a.xlsx', 'table')).rejects.toMatchObject({ status: 404 })
    const broken = await assets.storeFile(Buffer.from('not a zip'), 'application/octet-stream', 'xlsx')
    await expect(converter.convert(`asset:${broken}`, 'a.xlsx', 'table')).rejects.toMatchObject({ status: 422 })
  })

  it('tells when pandoc is missing, and refuses docx with the reason', async () => {
    const { converter, assets } = await setup({ pandoc: '/nonexistent/pandoc' })
    const capabilities = await converter.capabilities()
    expect(capabilities.pandoc.available).toBe(false)
    expect(capabilities.pandoc.reason).toContain('pandoc')
    expect(capabilities.table).toEqual(['xlsx'])
    const hash = await assets.storeFile(Buffer.from('PK'), 'application/octet-stream', 'docx')
    const error = await converter.convert(`asset:${hash}`, 'a.docx', 'markdown').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).status).toBe(503)
    expect((error as HttpError).message).toContain('pandoc')
  })

  it.skipIf(!hasPandoc)('turns a docx into Markdown, and puts its images in the assets', async () => {
    const { converter, assets, workspace, dataDir } = await setup()
    // pandoc で見本の docx を作る（見出し・表・画像）
    const source = mkdtempSync(join(tmpdir(), 'canvcode-docx-src-'))
    cleanups.push(() => rmSync(source, { recursive: true, force: true }))
    writeFileSync(join(source, 'red.png'), png(8, 6))
    writeFileSync(join(source, 's.md'), '# 見出し\n\n本文の段落。**太字**。\n\n| 列A | 列B |\n|-----|-----|\n| 1 | あ |\n\n![赤い画像](red.png)\n')
    expect(spawnSync('pandoc', ['s.md', '-o', 'sample.docx'], { cwd: source }).status).toBe(0)
    const docx = readFileSync(join(source, 'sample.docx'))
    const hash = await assets.storeFile(docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx')

    expect((await converter.capabilities()).pandoc.available).toBe(true)
    const result = await converter.convert(`asset:${hash}`, '報告書.docx', 'markdown')
    expect(result.warnings).toEqual([])
    expect(result.files.map((file) => [file.kind, file.path])).toEqual([['markdown', '報告書.md']])
    const markdown = readFileSync(join(workspace, '報告書.md'), 'utf8')
    expect(markdown).toContain('# 見出し')
    expect(markdown).toContain('| 列A | 列B |')
    // 画像は Asset に置き、ルートからのパスで指す
    const image = /\/\.canvcode\/assets\/([0-9a-f]{64})\.png/.exec(markdown)
    expect(image).not.toBeNull()
    expect(readFileSync(join(dataDir, 'assets', `${image![1]}.png`))).toEqual(png(8, 6))
    expect(JSON.parse(readFileSync(join(dataDir, 'assets', `${image![1]}.json`), 'utf8'))).toMatchObject({ mime: 'image/png', width: 8, height: 6 })
    expect(markdown).not.toContain('cc-media-')
    // 元の docx はそのまま
    expect(readFileSync((await assets.originalPath(hash))!)).toEqual(docx)
  })
})
