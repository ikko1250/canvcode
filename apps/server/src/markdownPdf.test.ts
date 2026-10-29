import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HttpError, type FileInfo } from './files.ts'
import { CANVCODE_ALIGN_FILTER, MarkdownPdf, latexError, type MarkdownPdfOptions } from './markdownPdf.ts'

// Markdown の File を PDF にする口（POST /api/files/<id>/pdf）。
// 実際に PDF を作るテストは、pandoc と LuaLaTeX がある環境でだけ動かす

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'canvcode-mdpdf-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function hasCommand(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const BUNDLED_MD2PDF_FILTERS = fileURLToPath(new URL('../md2pdf/filters/', import.meta.url))
const hasPandoc = hasCommand('pandoc', ['--version'])
const canBuild = hasPandoc && hasCommand('lualatex', ['--version'])

function fileInfo(id: string, path: string): FileInfo {
  const kind = path.endsWith('.py') ? 'code' : 'markdown'
  return { id, kind, title: path.replace(/^.*\//, '').replace(/\.\w+$/, ''), path, size: 0, mtime: 0, hash: '', missing: false }
}

async function serve(workspace: string, paths: Record<string, string>, options: MarkdownPdfOptions = {}): Promise<string> {
  const infos = new Map(Object.entries(paths).map(([id, path]) => [id, fileInfo(id, path)]))
  const source = {
    getInfo(id: string) {
      const info = infos.get(id)
      if (!info) throw new HttpError(404, 'no such file')
      return info
    },
    async read(id: string) {
      return { text: readFileSync(join(workspace, source.getInfo(id).path), 'utf8') }
    },
  }
  const pdf = new MarkdownPdf(source, workspace, join(workspace, '.canvcode'), options)
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    void pdf.handle(req, res, url.pathname).then((handled) => {
      if (!handled) res.writeHead(418).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => server.close())
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

// 描いた文字のかたまり（PDF の Tm と TJ のひと組）。x・end は左端と右端（pt）、slanted は傾けて描いたもの
interface TextRun {
  text: string
  x: number
  end: number
  slanted: boolean
}

// PDF の文字と、描いている画像の数と、文字のいちばん右の端（紙の右端からの空き、pt。紙からはみ出すと負）と、描いた文字のかたまり
async function readPdf(data: ArrayBuffer): Promise<{ text: string; images: number; rightGap: number; runs: TextRun[] }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: false })
  const doc = await task.promise
  let text = ''
  let images = 0
  let rightGap = Infinity
  const runs: TextRun[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    text += content.items.map((item) => ('str' in item ? item.str : '')).join('')
    for (const item of content.items) {
      if ('str' in item && item.str.trim()) rightGap = Math.min(rightGap, page.view[2] - (item.transform[4] + item.width))
    }
    const { fnArray, argsArray } = await page.getOperatorList()
    images += fnArray.filter((fn) => fn === pdfjs.OPS.paintImageXObject).length
    let size = 0
    let matrix = [1, 0, 0, 1, 0, 0]
    for (const [index, fn] of fnArray.entries()) {
      const args = argsArray[index]
      if (fn === pdfjs.OPS.setFont) size = args[1]
      else if (fn === pdfjs.OPS.setTextMatrix) matrix = Array.from(args[0] as ArrayLike<number>)
      else if (fn === pdfjs.OPS.showText) {
        const glyphs = (args[0] as unknown[]).filter((glyph): glyph is { unicode: string; width: number } => typeof glyph === 'object' && glyph !== null)
        const width = glyphs.reduce((sum, glyph) => sum + (glyph.width * size) / 1000, 0)
        runs.push({ text: glyphs.map((glyph) => glyph.unicode).join(''), x: matrix[4], end: matrix[4] + width, slanted: matrix[2] !== 0 })
      }
    }
  }
  await task.destroy()
  return { text, images, rightGap, runs }
}

// 1×1 の PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

describe('MarkdownPdf', () => {
  it('ignores other paths and refuses non-markdown files', async () => {
    const workspace = tempDir()
    writeFileSync(join(workspace, 'a.py'), 'print(1)\n')
    const base = await serve(workspace, { 'file:py': 'a.py' })
    expect((await fetch(`${base}/api/files/file%3Apy/content`)).status).toBe(418)
    expect((await fetch(`${base}/api/files/file%3Apy/pdf`)).status).toBe(405)
    expect((await fetch(`${base}/api/files/file%3Apy/pdf`, { method: 'POST' })).status).toBe(400)
    expect((await fetch(`${base}/api/files/file%3Anone/pdf`, { method: 'POST' })).status).toBe(404)
  })

  it('answers 503 when pandoc is not installed', async () => {
    const workspace = tempDir()
    writeFileSync(join(workspace, 'a.md'), '# a\n')
    const base = await serve(workspace, { 'file:a': 'a.md' }, { pandoc: join(workspace, 'no-pandoc') })
    const response = await fetch(`${base}/api/files/file%3Aa/pdf`, { method: 'POST' })
    expect(response.status).toBe(503)
    expect(((await response.json()) as { error: string }).error).toContain('pandoc')
  })

  it('picks the LaTeX error out of the pandoc output', () => {
    const stderr = 'This is LuaHBTeX\n(./input.tex\n! Package fontspec Error: The font "X" cannot be found.\n\nl.12 \\setmainjfont\nmore\n'
    expect(latexError(stderr)).toBe('! Package fontspec Error: The font "X" cannot be found.\n\nl.12 \\setmainjfont')
    expect(latexError('a\nb\nc\nd\n')).toBe('b\nc\nd')
  })

  it.skipIf(!hasPandoc)('centers <p align> and <div align> in LaTeX', () => {
    const markdown = [
      '<p align="center">表1　**太字**の題</p>',
      '',
      '<p align="right">右の文</p>',
      '',
      '<div align="center">',
      '',
      '表2　中の段落',
      '',
      '</div>',
      '',
      '<p align="center">閉じない',
      '',
      '<p class="note">寄せない</p>',
      '',
      '# 参考文献',
      '',
      '<p align="center">文献の中</p>',
      '',
      '文献1',
      '',
    ].join('\n')
    const refs = join(BUNDLED_MD2PDF_FILTERS, 'refs-hanging-indent.lua')
    const latex = execFileSync(
      'pandoc',
      ['--from=markdown', '-t', 'latex', '--lua-filter', CANVCODE_ALIGN_FILTER, '--lua-filter', refs],
      { input: markdown, encoding: 'utf8' },
    )
    expect(latex).toMatch(/\\begin\{center\}\s*表1　\\textbf\{太字\}の題\s*\\end\{center\}/)
    expect(latex).toMatch(/\\begin\{flushright\}\s*右の文\s*\\end\{flushright\}/)
    expect(latex).toMatch(/\\begin\{center\}\s*表2　中の段落\s*\\end\{center\}/)
    // 閉じない <p align> は、後ろの </p> や見出しまで巻き込まない
    expect(latex).not.toMatch(/\\begin\{center\}\s*閉じない/)
    expect(latex).not.toMatch(/\\begin\{center\}[^]*寄せない[^]*\\end\{center\}[^]*参考文献/)
    expect(latex).toMatch(/\\begin\{refhang\}\s*\\begin\{center\}\s*文献の中\s*\\end\{center\}[^]*\\end\{refhang\}/)
    // 環境の開きと閉じが入れ子として釣り合う
    const stack: string[] = []
    for (const [, kind, name] of latex.matchAll(/\\(begin|end)\{(\w+)\}/g)) {
      if (kind === 'begin') stack.push(name)
      else expect(stack.pop()).toBe(name)
    }
    expect(stack).toEqual([])
  })

  it.skipIf(!canBuild)(
    'builds a PDF with images resolved like the preview',
    async () => {
      const workspace = tempDir()
      mkdirSync(join(workspace, 'notes', 'img'), { recursive: true })
      writeFileSync(join(workspace, 'notes', 'img', 'a.png'), PNG)
      writeFileSync(join(workspace, 'root.png'), PNG)
      writeFileSync(join(workspace, 'anim.gif'), 'GIF89a')
      writeFileSync(
        join(workspace, 'notes', '報告.md'),
        [
          '# 報告書',
          '',
          '本文の段落です。',
          '',
          '![相対](img/a.png)',
          '',
          '![ルート](/root.png)',
          '',
          '![動く](../anim.gif)',
          '',
          '![外](../../outside.png)',
          '',
        ].join('\n'),
      )
      const base = await serve(workspace, { 'file:r': 'notes/報告.md' })
      const response = await fetch(`${base}/api/files/file%3Ar/pdf`, { method: 'POST' })
      expect(response.status, await response.clone().text()).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/pdf')
      expect(decodeURIComponent(response.headers.get('x-canvcode-export-name') ?? '')).toBe('報告.pdf')
      const data = await response.arrayBuffer()
      expect(Buffer.from(data).subarray(0, 5).toString()).toBe('%PDF-')
      const { text, images } = await readPdf(data)
      expect(images).toBe(2)
      expect(text).toContain('報告書')
      expect(text).toContain('［画像：動く］')
      expect(text).toContain('［画像：外］')
    },
    300_000,
  )

  it.skipIf(!canBuild)(
    'wraps long lines in code blocks instead of running off the page',
    async () => {
      const workspace = tempDir()
      const long = 'a'.repeat(300)
      writeFileSync(
        join(workspace, 'code.md'),
        [
          '# コード',
          '',
          '```python',
          `x = "${long}END1"  # 日本語のコメントが長く続いて、行の終わりまで届いてもまだ続くような長いコメントEND2`,
          '```',
          '',
          '```',
          `plain ${long}END3`,
          '```',
          '',
        ].join('\n'),
      )
      const base = await serve(workspace, { 'file:c': 'code.md' })
      const response = await fetch(`${base}/api/files/file%3Ac/pdf`, { method: 'POST' })
      expect(response.status, await response.clone().text()).toBe(200)
      const { text, rightGap } = await readPdf(await response.arrayBuffer())
      for (const mark of ['END1', 'END2', 'END3']) expect(text).toContain(mark)
      // 右の余白は 25mm（約 71pt）。折り返しの印のぶん少しはみ出してもよい
      expect(rightGap).toBeGreaterThan(50)
    },
    300_000,
  )

  it.skipIf(!canBuild)(
    'slants Japanese in *emphasis* and keeps the spaces around it',
    async () => {
      const workspace = tempDir()
      // pandoc は既定で LaTeX のソースを 72 桁（和文は 1 字 2 桁）で、空白のところで折り返す。
      // 和文 37 字のあとの空白（「普通」と「*強調いち*」のあいだ）で折り返す長さにする。
      // 和文の直後の改行は LuaTeX-ja が空白にしないので、折り返すと書いた空白が消える。
      // 字の幅で空きを測れるよう、PDF では段落の最後の 1 行（字間を伸ばさない）に収め、句読点（幅が半分になる）を使わない
      const long = '長い段落の文章'.repeat(5)
      writeFileSync(join(workspace, 'em.md'), [`${long}普通 *強調いち* 普通`, ''].join('\n'))
      const base = await serve(workspace, { 'file:e': 'em.md' })
      const response = await fetch(`${base}/api/files/file%3Ae/pdf`, { method: 'POST' })
      expect(response.status, await response.clone().text()).toBe(200)
      const { runs } = await readPdf(await response.arrayBuffer())
      const at = runs.findIndex((run) => run.text === '強調いち')
      const [before, emphasis, after] = runs.slice(at - 1, at + 2)
      expect(before.text.endsWith('普通') && !before.slanted).toBe(true)
      expect([emphasis, after].map(({ text, slanted }) => [text, slanted])).toEqual([
        ['強調いち', true],
        ['普通', false],
      ])
      // 「普通」と「強調いち」のあいだに、書いた空白（1pt より広い空き）が残る
      expect(emphasis.x - before.end).toBeGreaterThan(1)
    },
    300_000,
  )
})
