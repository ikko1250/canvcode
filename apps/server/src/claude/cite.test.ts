import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CITE_MAX_TURNS,
  CITE_SCHEMA,
  CitationWriter,
  checkAnswer,
  citePrompt,
  collectSeenUrls,
  DEFAULT_CITE_MODEL,
  doiUrl,
  findPdfSource,
  formatApa,
  gatherMaterial,
  handleCite,
  normalizeUrl,
  parseCite,
  splitSourceLine,
  type CiteAnswer,
  type CiteDeps,
  type CiteField,
  type CiteFieldKey,
} from './cite.ts'
import { ClaudeOnce, type OnceQuery } from './once.ts'

// アイテムの APA の引用を作る（MAI-98）

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'canvcode-cite-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

// ワークスペース（root）に置いた Markdown と、PDF のレコード（pages.json つき）を持つ材料の置き場
async function workspaceWith(options: { markdown?: Record<string, string>; pdf?: { title: string; content: string; pages: string[] } } = {}) {
  const root = await tempDir()
  const dataDir = join(root, '.canvcode')
  await mkdir(join(dataDir, 'assets'), { recursive: true })
  const infos = new Map<string, { id: string; kind: string; title: string; path: string }>()
  for (const [path, text] of Object.entries(options.markdown ?? {})) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), text)
    const id = `file:md${infos.size}`
    infos.set(id, { id, kind: 'markdown', title: path.replace(/^.*\//, '').replace(/\.md$/, ''), path })
  }
  const records = new Map<string, Record<string, unknown>>()
  if (options.pdf) {
    const hash = sha(options.pdf.content)
    await writeFile(join(dataDir, 'assets', `${hash}.pages.json`), JSON.stringify({ version: 2, pages: options.pdf.pages }))
    records.set('file:pdf', { typeName: 'file', id: 'file:pdf', kind: 'pdf', title: options.pdf.title, path: '', hash, size: Buffer.byteLength(options.pdf.content), assetId: `asset:${hash}`, deletedAt: null })
  }
  const deps: CiteDeps = {
    records: { get: (id: string) => records.get(id) as never },
    files: {
      root,
      getInfo: (id: string) => {
        const info = infos.get(id)
        if (!info) throw new Error('not found')
        return info as never
      },
      read: async (id: string) => {
        const { readFile } = await import('node:fs/promises')
        return { text: await readFile(join(root, infos.get(id)!.path), 'utf8'), hash: '' }
      },
      resolveWorkspacePath: (path: string) => join(root, path),
    },
    dataDir,
  }
  return { root, deps }
}

const field = (status: CiteField['status'], value = '', evidence: string[] = []): CiteField => ({ status, value, evidence })
const fieldsOf = (partial: Partial<Record<CiteFieldKey, CiteField>>): Record<CiteFieldKey, CiteField> => ({
  authors: field('none'),
  date: field('none'),
  title: field('none'),
  container: field('none'),
  volumeIssue: field('none'),
  pages: field('none'),
  link: field('none'),
  ...partial,
})

describe('材料', () => {
  it('Markdown の 1 行目の出典の行（imozuru の fetch.py の SOURCE_LINE）と、それを除いた本文', () => {
    expect(splitSourceLine('出典: <https://example.com/a?b=1>（取得: 2026-11-01）\n\n# 題\n本文')).toEqual({ url: 'https://example.com/a?b=1', fetched: '2026-11-01', body: '\n# 題\n本文' })
    expect(splitSourceLine('# 題\n出典: <https://example.com/>（取得: 2026-11-01）')).toEqual({ body: '# 題\n出典: <https://example.com/>（取得: 2026-11-01）' })
    // http(s) でない URL は出典にしない
    expect(splitSourceLine('出典: <javascript:alert(1)>（取得: 2026-11-01）\n本文').url).toBeUndefined()
  })

  it('Markdown：出典の行があればその URL、なければ同じフォルダの sources.json から', async () => {
    const { root, deps } = await workspaceWith({
      markdown: {
        'research/t/sources/a.md': '出典: <https://example.com/a>（取得: 2026-11-01）\n\n# A の題\n本文 A',
        'research/t/sources/b.md': '# B の題\n本文 B',
        'notes/c.md': '# C\n本文 C',
      },
    })
    await writeFile(join(root, 'research/t/sources/sources.json'), JSON.stringify({ b: { files: ['b.html', 'b.md'], url: 'https://example.com/b', fetched: '2026-10-30' } }))
    expect(await gatherMaterial({ kind: 'markdown', fileId: 'file:md0' }, deps)).toEqual({ kind: 'markdown', name: 'a.md', url: 'https://example.com/a', fetched: '2026-11-01', text: '# A の題\n本文 A' })
    expect(await gatherMaterial({ kind: 'markdown', fileId: 'file:md1' }, deps)).toEqual({ kind: 'markdown', name: 'b.md', url: 'https://example.com/b', fetched: '2026-10-30', text: '# B の題\n本文 B' })
    // 出典の行も sources.json もない Markdown は、本文の頭だけ
    expect(await gatherMaterial({ kind: 'markdown', fileId: 'file:md2' }, deps)).toEqual({ kind: 'markdown', name: 'c.md', text: '# C\n本文 C' })
    await expect(gatherMaterial({ kind: 'markdown', fileId: 'file:none' }, deps)).rejects.toMatchObject({ status: 404 })
  })

  it('PDF：1・2 ページ目の文字とファイル名。sources.json の PDF を中身のハッシュで照らし合わせて URL を添える', async () => {
    const content = '%PDF-1.7 paper'
    const { root, deps } = await workspaceWith({ pdf: { title: '論文', content, pages: ['1 ページ目の題と著者', '2 ページ目', '3 ページ目'] } })
    // 名前の違う PDF でも、中身が同じなら使う。別の中身の PDF は使わない
    await mkdir(join(root, 'research/t/sources'), { recursive: true })
    await writeFile(join(root, 'research/t/sources/paper-v2.pdf'), content)
    await writeFile(join(root, 'research/t/sources/other.pdf'), '%PDF-1.7 othr')
    await writeFile(
      join(root, 'research/t/sources/sources.json'),
      JSON.stringify({ other: { files: ['other.pdf'], url: 'https://example.com/other.pdf', fetched: '2026-11-02' }, paper: { files: ['paper-v2.pdf', 'paper-v2.txt'], url: 'https://example.com/paper.pdf', fetched: '2026-11-01' } }),
    )
    const material = await gatherMaterial({ kind: 'pdf', fileId: 'file:pdf' }, deps)
    expect(material).toEqual({ kind: 'pdf', name: '論文.pdf', url: 'https://example.com/paper.pdf', fetched: '2026-11-01', text: '=== 1 ページ目 ===\n1 ページ目の題と著者\n\n=== 2 ページ目 ===\n2 ページ目' })
    expect(citePrompt(material)).toContain('取ってきた URL: https://example.com/paper.pdf（取得: 2026-11-01）')
    expect(citePrompt(material)).not.toContain('3 ページ目')
    await expect(gatherMaterial({ kind: 'pdf', fileId: 'file:none' }, deps)).rejects.toMatchObject({ status: 404 })
  })

  it('PDF：同名でも内容が異なる・原文がないものは出典にしない。. で始まるフォルダは見ない', async () => {
    const root = await tempDir()
    await mkdir(join(root, 'a'), { recursive: true })
    await mkdir(join(root, '.hidden'), { recursive: true })
    await writeFile(join(root, 'a/sources.json'), JSON.stringify({ x: { files: ['論文.pdf'], url: 'https://example.com/x.pdf' } }))
    await writeFile(join(root, '.hidden/sources.json'), JSON.stringify({ y: { files: ['論文.pdf'], url: 'https://example.com/y.pdf' } }))
    expect(await findPdfSource(root, { hash: sha('x'), size: 1, title: '論文' })).toBeNull()
    await writeFile(join(root, 'a/論文.pdf'), 'y')
    await writeFile(join(root, '.hidden/論文.pdf'), 'x')
    expect(await findPdfSource(root, { hash: sha('x'), size: 1, title: '論文' })).toBeNull()
    await writeFile(join(root, 'a/論文.pdf'), 'different size')
    expect(await findPdfSource(root, { hash: sha('x'), size: 1, title: '論文' })).toBeNull()
    expect(await findPdfSource(root, { hash: sha('x'), size: 1, title: '別の名前' })).toBeNull()
  })

  it('リンクカード：URL と題・説明・サイト名を囲んで渡す', async () => {
    const { deps } = await workspaceWith()
    const material = await gatherMaterial(parseCite({ kind: 'link', url: 'https://example.com/post', title: ' 記事の題 ', description: '説明', siteName: 'Example' }), deps)
    expect(citePrompt(material)).toBe(
      '次の資料（ウェブページへのリンク）の文献を突き止め、APA 7 版の参考文献の項目を、Web で確かめて返してください。\n\n<material>\nURL: https://example.com/post\nページの題: 記事の題\nサイト名: Example\n説明: 説明\n</material>',
    )
  })

  it('頼みの形を確かめる', () => {
    expect(() => parseCite({ kind: 'link', url: 'javascript:alert(1)' })).toThrow(expect.objectContaining({ status: 400 }))
    expect(() => parseCite({ kind: 'pdf', fileId: '../x' })).toThrow(expect.objectContaining({ status: 400 }))
    expect(() => parseCite({ kind: 'image', fileId: 'file:a' })).toThrow(expect.objectContaining({ status: 400 }))
    expect(() => parseCite({ kind: 'link', url: 'https://example.com', title: 'あ'.repeat(1001) })).toThrow(expect.objectContaining({ status: 413 }))
    expect(parseCite({ kind: 'markdown', fileId: 'file:abc', extra: 1 })).toEqual({ kind: 'markdown', fileId: 'file:abc' })
  })
})

describe('答えを確かめる', () => {
  it('根拠の URL が、この回に検索の結果に出たか開いたものでなければ、未確認に直す', () => {
    const seen = new Set([normalizeUrl('https://www.example.com/paper/'), normalizeUrl('https://doi.org/10.1000/ABC')])
    const answer: CiteAnswer = {
      type: 'journal-article',
      fields: fieldsOf({
        authors: field('verified', 'Smith, J.', ['http://example.com/paper#top']),
        date: field('verified', '2020', ['https://made-up.example.org/']),
        title: field('verified', 'A title', []),
        container: field('unverified', 'Journal of Tests', ['https://www.example.com/paper']),
        link: field('verified', 'doi:10.1000/abc', ['https://dx.doi.org/10.1000/abc']),
      }),
    }
    const fields = checkAnswer(answer, seen)
    expect(fields.authors).toEqual(field('verified', 'Smith, J.', ['http://example.com/paper#top']))
    // 見ていない URL だけ・根拠なし・もともと未確認は、未確認（候補の値は残す）
    expect(fields.date).toEqual(field('unverified', '2020'))
    expect(fields.title).toEqual(field('unverified', 'A title'))
    expect(fields.container).toEqual(field('unverified', 'Journal of Tests'))
    // DOI は https://doi.org/ の形にする
    expect(fields.link).toEqual(field('verified', 'https://doi.org/10.1000/abc', ['https://dx.doi.org/10.1000/abc']))
    expect(fields.pages).toEqual(field('unverified'))
  })

  it('該当なしにも見た根拠を求め、必須の題は省略しない', () => {
    const url = 'https://example.com/paper'
    const answer: CiteAnswer = { type: 'webpage', fields: fieldsOf({
      title: field('none', '', [url]),
      date: field('none', '', [url]),
      authors: field('none', '', ['https://made-up.example/']),
      pages: field('none', '', [url]),
    }) }
    const checked = checkAnswer(answer, new Set([normalizeUrl(url)]))
    expect(checked.title.status).toBe('unverified')
    expect(checked.authors.status).toBe('unverified')
    expect(checked.date).toEqual(field('none', '', [url]))
    expect(checked.pages).toEqual(field('none', '', [url]))
  })

  it('DOI の形を https://doi.org/ の URL にする', () => {
    expect(doiUrl('10.1037/0003-066X.59.1.29')).toBe('https://doi.org/10.1037/0003-066X.59.1.29')
    expect(doiUrl('https://dx.doi.org/10.1000/x')).toBe('https://doi.org/10.1000/x')
    expect(doiUrl('doi: 10.1000/x')).toBe('https://doi.org/10.1000/x')
    expect(doiUrl('https://example.com/a')).toBe('https://example.com/a')
  })

  it('検索の結果に出た URL と、開けた URL（WebFetch）を集める。開けなかったもの・転送だけのものは数えない', () => {
    const seen = new Set<string>()
    const collect = collectSeenUrls(seen)
    const user = (tool_use_result: unknown) => ({ type: 'user', tool_use_result }) as unknown as SDKMessage
    collect(user({ query: 'q', results: [{ tool_use_id: 't', content: [{ title: 'a', url: 'https://a.example/x' }] }, 'まとめ'], durationSeconds: 1 }))
    collect(user({ url: 'https://b.example/y', code: 200, codeText: 'OK', result: '', bytes: 1, durationMs: 1 }))
    collect(user({ url: 'https://c.example/z', code: 404, codeText: 'Not Found', result: '', bytes: 1, durationMs: 1 }))
    collect(user({ url: 'https://doi.org/10.1000/x', code: 302, codeText: 'Found', result: 'Redirect', bytes: 1, durationMs: 1 }))
    collect({ type: 'assistant' } as unknown as SDKMessage)
    expect([...seen]).toEqual(['a.example/x', 'b.example/y'])
  })
})

describe('APA の引用の文', () => {
  const ok = (value: string) => field('verified', value, ['https://example.com'])
  const text = (segments: { text: string; italic?: boolean }[]) => segments.map((s) => (s.italic ? `*${s.text}*` : s.text)).join('')

  it('論文：誌名と巻を斜体にし、号は括弧に入れる', () => {
    const fields = fieldsOf({
      authors: ok('Smith, J. A., & Doe, R.'),
      date: ok('2020'),
      title: ok('A study of things'),
      container: ok('Journal of Testing'),
      volumeIssue: ok('12(3)'),
      pages: ok('45–67'),
      link: ok('https://doi.org/10.1000/xyz'),
    })
    expect(text(formatApa('journal-article', fields))).toBe('Smith, J. A., & Doe, R. (2020). A study of things. *Journal of Testing*, *12*(3), 45–67. https://doi.org/10.1000/xyz')
  })

  it('未確認の項目は、その場所に「[未確認：…]」と書き、値を入れない。年がなければ n.d.', () => {
    const fields = fieldsOf({
      authors: ok('山田 太郎・鈴木 花子'),
      date: field('unverified', '2019'),
      title: ok('日本語の題'),
      container: ok('心理学研究'),
      volumeIssue: field('unverified', '91(2)'),
      pages: field('unverified'),
      link: ok('https://doi.org/10.4992/jjpsy.91.1'),
    })
    expect(text(formatApa('journal-article', fields))).toBe(
      '山田 太郎・鈴木 花子 ([未確認：年]). 日本語の題. *心理学研究*, [未確認：巻号], [未確認：ページ]. https://doi.org/10.4992/jjpsy.91.1',
    )
    expect(text(formatApa('webpage', fieldsOf({ authors: ok('Example Org'), title: ok('Page'), container: ok('Example'), link: ok('https://example.com/p') })))).toBe(
      'Example Org. (n.d.). *Page*. Example. https://example.com/p',
    )
  })

  it('本・プレプリント・章。著者のない文献は、題を著者の位置に出す', () => {
    expect(text(formatApa('book', fieldsOf({ authors: ok('Doe, J.'), date: ok('2018'), title: ok('Big book'), container: ok('Press'), link: field('none') })))).toBe(
      'Doe, J. (2018). *Big book*. Press.',
    )
    expect(text(formatApa('preprint', fieldsOf({ authors: ok('Vaswani, A.'), date: ok('2017'), title: ok('Attention is all you need'), container: ok('arXiv'), link: ok('https://doi.org/10.48550/arXiv.1706.03762') })))).toBe(
      'Vaswani, A. (2017). *Attention is all you need* [Preprint]. arXiv. https://doi.org/10.48550/arXiv.1706.03762',
    )
    expect(text(formatApa('chapter', fieldsOf({ authors: ok('Doe, J.'), date: ok('2018'), title: ok('A chapter'), container: ok('The book'), pages: ok('pp. 1–20') })))).toBe(
      'Doe, J. (2018). A chapter. In *The book* (pp. 1–20).',
    )
    expect(text(formatApa('webpage', fieldsOf({ date: ok('2024, May 4'), title: ok('Untitled? No'), container: ok('Site'), link: ok('https://example.com') })))).toBe(
      '*Untitled? No*. (2024, May 4). Site. https://example.com',
    )
  })
})

type Call = { prompt: string; options: Options }

// WebSearch の結果を 1 つ返してから、answer を構造化出力で答える偽の query
function answering(answer: unknown, calls: Call[] = [], hits: string[] = ['https://example.com/paper']): OnceQuery {
  return (params) => {
    calls.push(params)
    return (async function* () {
      yield { type: 'user', tool_use_result: { query: 'q', results: [{ tool_use_id: 't', content: hits.map((url) => ({ title: '', url })) }] } } as unknown as SDKMessage
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's',
        total_cost_usd: 0.05,
        duration_ms: 30_000,
        num_turns: 6,
        result: JSON.stringify(answer),
        structured_output: answer,
        modelUsage: { 'claude-haiku-5-5': { costUSD: 0.001 }, 'claude-sonnet-5-5': { costUSD: 0.049 } },
      } as unknown as SDKMessage
    })()
  }
}

const sampleAnswer: CiteAnswer = {
  type: 'journal-article',
  fields: fieldsOf({
    authors: field('verified', 'Smith, J.', ['https://example.com/paper']),
    date: field('verified', '2020', ['https://example.com/paper']),
    title: field('verified', 'A title', ['https://example.com/paper']),
    container: field('verified', 'Journal', ['https://example.com/paper']),
    volumeIssue: field('unverified', '3(1)', []),
    pages: field('none', '', ['https://example.com/paper']),
    link: field('verified', '10.1000/abc', ['https://example.com/paper']),
  }),
  note: ' 版が 2 つある ',
}

describe('CitationWriter', () => {
  it('Web の根拠がない全項目 none の回答を、確認済みの引用として返さない', async () => {
    const { deps } = await workspaceWith()
    const answer: CiteAnswer = { type: 'webpage', fields: fieldsOf({}) }
    const writer = new CitationWriter({ once: new ClaudeOnce({ run: answering(answer, [], []) }), deps })
    const result = await writer.cite({ kind: 'link', url: 'https://example.com/paper' })
    expect(result.text).toContain('[未確認：題]')
    expect(result.unverified).toHaveLength(7)
    expect(result.evidence).toEqual([])
  })

  it('Sonnet に、WebSearch・WebFetch つき・決めた JSON の形で頼み、引用の文と未確認の項目・根拠を返す', async () => {
    const { deps } = await workspaceWith()
    const calls: Call[] = []
    const writer = new CitationWriter({ once: new ClaudeOnce({ run: answering(sampleAnswer, calls) }), deps })
    const result = await writer.cite({ kind: 'link', url: 'https://example.com/paper', title: '題' })
    expect(result).toMatchObject({
      text: 'Smith, J. (2020). A title. Journal, [未確認：巻号]. https://doi.org/10.1000/abc',
      type: 'journal-article',
      unverified: [{ field: 'volumeIssue', label: '巻号', candidate: '3(1)' }],
      evidence: [{ url: 'https://example.com/paper', labels: ['著者', '年', '題', '誌名', 'ページ', 'DOI/URL'] }],
      note: '版が 2 つある',
      // WebFetch が使う Haiku ではなく、頼んだ Sonnet
      model: 'claude-sonnet-5-5',
      costUsd: 0.05,
      durationMs: 30_000,
    })
    expect(result.citation).toContainEqual({ text: 'Journal', italic: true })
    const { options } = calls[0]!
    expect(options).toMatchObject({ model: DEFAULT_CITE_MODEL, tools: ['WebSearch', 'WebFetch'], maxTurns: CITE_MAX_TURNS, outputFormat: { type: 'json_schema', schema: CITE_SCHEMA } })
  })
})

describe('POST /api/claude/cite', () => {
  async function start(writer: CitationWriter | null): Promise<string> {
    const server: Server = createServer((req, res) => {
      if (handleCite(req, res, new URL(req.url!, 'http://x').pathname, writer)) return
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/claude/cite`
  }

  const post = (url: string, body: string, type = 'application/json') => fetch(url, { method: 'POST', headers: { 'content-type': type }, body })

  it('引用を返す。JSON でない・形が違う・GET は断る。見つからない PDF は 404', async () => {
    const { deps } = await workspaceWith()
    const url = await start(new CitationWriter({ once: new ClaudeOnce({ run: answering(sampleAnswer) }), deps }))
    const response = await post(url, JSON.stringify({ kind: 'link', url: 'https://example.com/paper' }))
    expect(response.status).toBe(200)
    expect(((await response.json()) as { text: string }).text).toContain('Smith, J. (2020)')
    expect((await post(url, 'kind=link', 'application/x-www-form-urlencoded')).status).toBe(415)
    expect((await post(url, JSON.stringify({ kind: 'link', url: 'ftp://x' }))).status).toBe(400)
    expect((await post(url, JSON.stringify({ kind: 'pdf', fileId: 'file:none' }))).status).toBe(404)
    expect((await fetch(url)).status).toBe(405)
  })

  it('CitationWriter がなければ（CANVCODE_CLAUDE=0）受け持たない', async () => {
    const url = await start(null)
    expect((await post(url, JSON.stringify({ kind: 'link', url: 'https://example.com' }))).status).toBe(404)
  })
})
