import type { IncomingMessage, ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { describeRowCountLimits, type SlideData } from '@canvcode/slides'
import { normalizeRefId } from '@canvcode/core'
import { HttpError, type FileInfo } from './files.ts'
import { resolveReference, type RefDeps } from './refs.ts'
import type { SlidesApi } from './slides.ts'

// AI から CanvCode を使うための MCP サーバー（MAI-59）。
// - Claude Code などが Streamable HTTP で /mcp につなぐ（claude mcp add --transport http canvcode http://127.0.0.1:8787/mcp）
// - 第 1 段は Markdown / Python の File の読み書きだけ。本文は FileStore（実ファイル）を通すので、レコードには触れない
// - 第 2 段でスライドデッキを足した。書式の説明・検証付きの作成と更新・スライドの画像での確認ができる
// - 書いたら開いているブラウザに知らせる。ブラウザは保存していない編集がなければ読み直し、あれば衝突として尋ねる
// - セッションは持たない（要求ごとにサーバーを作る）
// - ユーザーが CanvCode で範囲を選んでコピーした ref:XXXXXXXXXX は、resolve_reference で中身にする

export const MCP_PATH = '/mcp'

export type McpDeps = RefDeps & { slides?: SlidesApi }

export function createMcpServer(deps: McpDeps): McpServer {
  const { files, slides } = deps
  const server = new McpServer(
    { name: 'canvcode', version: '0.2.0' },
    {
      instructions:
        'CanvCode is an infinite canvas whose Markdown (.md) and Python (.py) documents and slide decks (.slide.md / .slide.json) are real files. ' +
        'Use list_documents to find a document id, read_document before editing, and prefer edit_document for small changes. ' +
        (slides
          ? 'For slides, call get_slide_format first, then create_slide_deck or update_slide_deck, and check the result with preview_slide_deck. '
          : '') +
        'New documents appear under "未配置" (unplaced) in the sidebar; the user places them on a canvas. ' +
        'When the user\'s message contains an id like ref:XXXXXXXXXX, it points at a place the user selected in CanvCode ' +
        '(a region of a canvas, lines of a document, or a region of a PDF page): call resolve_reference with it first. ' +
        'Document ids (file:...) in its result can be passed to read_document.',
    },
  )

  server.registerTool(
    'list_documents',
    {
      title: 'List documents',
      description: 'List Markdown and Python documents and slide decks in the workspace. Filter by a substring of the title or path, and by kind.',
      inputSchema: {
        query: z.string().optional().describe('Case-insensitive substring of the title or path'),
        kind: z.enum(['markdown', 'code', 'slides']).optional().describe('markdown (.md), code (.py) or slides (.slide.md / .slide.json)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, kind }) => {
      const needle = query?.toLowerCase()
      const found = files
        .list()
        .filter((f) => !kind || f.kind === kind)
        .filter((f) => !needle || f.title.toLowerCase().includes(needle) || f.path.toLowerCase().includes(needle))
        .sort((a, b) => a.path.localeCompare(b.path))
        .map(summary)
      return json({ documents: found })
    },
  )

  server.registerTool(
    'read_document',
    {
      title: 'Read a document',
      description: 'Read the full text of a document. The returned hash can be passed to update_document as expected_hash.',
      inputSchema: { id: z.string().describe('Document id (file:...) from list_documents') },
      annotations: { readOnlyHint: true },
    },
    ({ id }) =>
      guard(async () => {
        const { text, hash } = await files.read(id)
        return json({ id, hash, text })
      }),
  )

  server.registerTool(
    'resolve_reference',
    {
      title: 'Resolve a reference',
      description:
        'Resolve a reference id (ref:XXXXXXXXXX) that the user copied in CanvCode to show you what to look at. ' +
        'Returns the location (canvas region, document lines, or PDF page region) and its content: the current text of the lines, ' +
        'the nodes in the canvas region (with document ids you can pass to read_document), or the text in the PDF region. ' +
        'When the region has freehand strokes or images, a PNG of the region comes first; the "image" field maps its pixels to world coordinates.',
      inputSchema: { id: z.string().describe('Reference id, e.g. ref:Ab12Cd34Ef (the ref: prefix may be omitted)') },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const normalized = normalizeRefId(id)
      const ref = normalized ? deps.records.getRef(normalized) : undefined
      if (!ref) return error(`Unknown reference id ${normalized ?? JSON.stringify(id)}. Ask the user to copy it again from CanvCode.`)
      const resolved = await resolveReference(ref, deps)
      // 範囲の画像があれば、画像を先に置く（画像を先に置くと読み取りがよくなる。MAI-64）
      const image = resolved.image ? await deps.refImages?.read(ref.id) : null
      if (!image) return json(resolved)
      return {
        content: [
          { type: 'image', data: image.png.toString('base64'), mimeType: 'image/png' },
          { type: 'text', text: JSON.stringify(resolved, null, 2) },
        ],
      }
    },
  )

  server.registerTool(
    'create_document',
    {
      title: 'Create a document',
      description: 'Create a new Markdown or Python document. It is added to the workspace as unplaced; the user can place it on a canvas from the sidebar.',
      inputSchema: {
        kind: z.enum(['markdown', 'code']).describe('markdown (.md) or code (.py)'),
        title: z.string().describe('File name without the extension. A number is appended if the name is taken'),
        content: z.string().default('').describe('Initial text'),
      },
    },
    ({ kind, title, content }) =>
      guard(async () => {
        const info = await files.create(kind, title, content, { announce: true })
        return json({ document: summary(info), hash: info.hash })
      }),
  )

  server.registerTool(
    'update_document',
    {
      title: 'Replace a document',
      description:
        'Replace the whole text of a document. Pass expected_hash (from read_document) to refuse the write if the document changed since you read it.',
      inputSchema: {
        id: z.string().describe('Document id (file:...)'),
        content: z.string().describe('New full text'),
        expected_hash: z.string().optional().describe('Hash from read_document'),
      },
      annotations: { destructiveHint: true },
    },
    ({ id, content, expected_hash }) =>
      guard(async () => {
        const info = await writeChecked(id, content, expected_hash ?? '')
        return json({ document: summary(info), hash: info.hash })
      }),
  )

  server.registerTool(
    'edit_document',
    {
      title: 'Edit part of a document',
      description:
        'Replace an exact string in a document. old_string must appear exactly once unless replace_all is true. Line endings are matched as LF.',
      inputSchema: {
        id: z.string().describe('Document id (file:...)'),
        old_string: z.string().min(1).describe('Exact text to replace'),
        new_string: z.string().describe('Replacement text'),
        replace_all: z.boolean().default(false).describe('Replace every occurrence'),
      },
    },
    ({ id, old_string, new_string, replace_all }) =>
      guard(async () => {
        const { text: raw, hash } = await files.read(id)
        // 改行コードは元のまま保つ（ブラウザの編集と同じ。MAI-10）
        const crlf = raw.includes('\r\n')
        const text = crlf ? raw.replace(/\r\n/g, '\n') : raw
        const from = old_string.replace(/\r\n/g, '\n')
        const to = new_string.replace(/\r\n/g, '\n')
        const count = text.split(from).length - 1
        if (count === 0) return error('old_string was not found in the document. Read it again and copy the text exactly.')
        if (count > 1 && !replace_all) {
          return error(`old_string appears ${count} times. Add surrounding text to make it unique, or set replace_all.`)
        }
        const next = replace_all ? text.split(from).join(to) : text.replace(from, () => to)
        const info = await writeChecked(id, crlf ? next.replace(/\n/g, '\r\n') : next, hash)
        return json({ document: summary(info), hash: info.hash, replaced: replace_all ? count : 1 })
      }),
  )

  // スライドデッキを文字列として書き換えるときも、デッキとして読めない内容は書かない（キャンバスの画像も作り直す）
  async function writeChecked(id: string, content: string, expectedHash: string): Promise<FileInfo> {
    const isDeck = files.getInfo(id).kind === 'slides'
    if (isDeck && slides) slides.checkDeckText(id, content)
    const info = await files.write(id, content, expectedHash, { announce: true })
    if (isDeck && slides) slides.renderPagesSoon(info)
    return info
  }

  if (slides) registerSlideTools(server, slides)
  return server
}

// ---- スライドデッキ ----

// 1 回の preview_slide_deck で返す画像の上限（応答が大きくなりすぎないように）
const MAX_PREVIEW_SLIDES = 8

function registerSlideTools(server: McpServer, slides: SlidesApi): void {
  server.registerTool(
    'get_slide_format',
    {
      title: 'Slide deck format',
      description: 'Explain the slide deck format (Markdown and JSON), the layouts and their limits. Read this before writing a deck.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => ({ content: [{ type: 'text', text: slideFormatGuide() }] }),
  )

  server.registerTool(
    'read_slide_deck',
    {
      title: 'Read a slide deck',
      description:
        'Read a slide deck: its source text, hash (for update_slide_deck), an outline of the slides (number, id, layout, title) and layout warnings such as overflowing text.',
      inputSchema: { id: z.string().describe('Deck id (file:...) from list_documents with kind "slides"') },
      annotations: { readOnlyHint: true },
    },
    ({ id }) =>
      guard(async () => {
        const deck = await slides.inspectDeck(id)
        return json({
          document: summary(deck.info),
          format: formatOf(deck.info),
          hash: deck.hash,
          ...(deck.deck ? { slides: outline(deck.deck.slides) } : { error: deck.error }),
          warnings: deck.warnings,
          text: deck.text,
        })
      }),
  )

  server.registerTool(
    'create_slide_deck',
    {
      title: 'Create a slide deck',
      description:
        'Create a new slide deck from Markdown (default) or JSON source written in the format of get_slide_format. ' +
        'The deck is validated first; slides without an id get one. It is added as unplaced; the user places it on a canvas from the sidebar. ' +
        'Check the returned warnings and look at the slides with preview_slide_deck.',
      inputSchema: {
        title: z.string().describe('File name without the extension. A number is appended if the name is taken'),
        content: z.string().min(1).describe('Deck source (Markdown or JSON)'),
        format: z.enum(['md', 'json']).default('md').describe('md (.slide.md) or json (.slide.json)'),
      },
    },
    ({ title, content, format }) =>
      guard(async () => {
        const { info, deck, warnings } = await slides.createDeck(title, content, format)
        return json({ document: summary(info), hash: info.hash, slides: outline(deck.slides), warnings })
      }),
  )

  server.registerTool(
    'update_slide_deck',
    {
      title: 'Replace a slide deck',
      description:
        'Replace the whole source of a slide deck. The new source is validated before it is written. ' +
        'Keep each slide\'s id ({#id} in Markdown, "name" in JSON) so the notes the user drew on its image stay with it. ' +
        'Pass expected_hash (from read_slide_deck) to refuse the write if the deck changed since you read it. For small changes edit_document also works.',
      inputSchema: {
        id: z.string().describe('Deck id (file:...)'),
        content: z.string().min(1).describe('New full source, in the deck\'s format (Markdown for .slide.md, JSON for .slide.json)'),
        expected_hash: z.string().optional().describe('Hash from read_slide_deck'),
      },
      annotations: { destructiveHint: true },
    },
    ({ id, content, expected_hash }) =>
      guard(async () => {
        const { info, deck, warnings } = await slides.replaceDeck(id, content, expected_hash ?? '')
        return json({ document: summary(info), hash: info.hash, slides: outline(deck.slides), warnings })
      }),
  )

  server.registerTool(
    'preview_slide_deck',
    {
      title: 'Look at slides',
      description:
        `Render slides of a deck to PNG images, as they appear on the canvas, to check the layout. Returns at most ${MAX_PREVIEW_SLIDES} slides per call. ` +
        'Needs Chromium on the server; the first call can take a few seconds.',
      inputSchema: {
        id: z.string().describe('Deck id (file:...)'),
        slides: z.array(z.number().int().min(1)).max(MAX_PREVIEW_SLIDES).optional()
          .describe(`Slide numbers (1-based). Defaults to the first ${MAX_PREVIEW_SLIDES} slides`),
      },
      annotations: { readOnlyHint: true },
    },
    ({ id, slides: numbers }) =>
      guard(async () => {
        const indices = numbers?.map((n) => n - 1) ?? (await firstIndices(slides, id))
        const { images, warnings } = await slides.slideImages(id, indices)
        const content: CallToolResult['content'] = []
        for (const image of images) {
          content.push({ type: 'text', text: `Slide ${image.index + 1}${image.name ? ` {#${image.name}}` : ''}: ${image.title}` })
          content.push({ type: 'image', data: image.png.toString('base64'), mimeType: 'image/png' })
        }
        if (warnings.length > 0) content.push({ type: 'text', text: `Warnings:\n${warnings.join('\n')}` })
        return { content }
      }),
  )
}

async function firstIndices(slides: SlidesApi, id: string): Promise<number[]> {
  const { deck, error } = await slides.inspectDeck(id)
  if (!deck) throw new HttpError(400, `デッキとして読めません: ${error}`)
  return deck.slides.slice(0, MAX_PREVIEW_SLIDES).map((_, index) => index)
}

function outline(list: SlideData[]): { number: number; id?: string; layout: string; title: string }[] {
  return list.map((slide, index) => ({ number: index + 1, ...(slide.name ? { id: slide.name } : {}), layout: slide.layout ?? 'table', title: slide.title }))
}

function formatOf(info: FileInfo): 'md' | 'json' {
  return info.path.toLowerCase().endsWith('.json') ? 'json' : 'md'
}

// get_slide_format の説明。上限はレイアウトの仕様から取る
function slideFormatGuide(): string {
  const limits = describeRowCountLimits()
  return `# CanvCode slide decks

A deck is a list of 1920x1080 slides. You write structured content; fonts, colours and sizes are fixed by the layout, so there is no styling syntax.
Decks are saved as .slide.md (Markdown, preferred) or .slide.json.

## Layouts (chosen from the content in Markdown)

| layout | content | limit |
|---|---|---|
| title | cover: title, optional subtitle lines (\`## ...\`) and plain lines for presenter, affiliation, date | - |
| bullets | a bullet list, nested up to 3 levels | ${limits.bullets} top-level items |
| table | rows of "label | body" | ${limits.table} rows |
| table-image | rows + one image, or rows + one code block | ${limits['table-image']} rows; code: 20 lines, 70 chars per line |
| table-images | rows + two images, each with a caption title | ${limits['table-images']} rows |

A table row has exactly two cells: a short label (left) and the body (right). Use \`<br>\` for a line break inside a cell. Keep text short: long text makes the rows cramped and produces warnings.
Bullets cannot be mixed with rows, images or code on the same slide. Subtitles and plain lines are only allowed on title slides.
Inline emphasis: \`**bold**\` only.

## Markdown

~~~markdown
---
deckTitle: 四半期レビュー
---

# 四半期レビュー {#cover}
## 2026 年 第 3 四半期
山田 太郎
2026-09-24

# 今期の要点 {#summary}

- 売上は前年比 **12%** 増
  - 新規顧客が牽引
- 解約率は横ばい
- 来期は採用を強化

# 指標 {#metrics}

| 指標 | 値 |
|---|---|
| 売上 | 1.2 億円<br>前年比 +12% |
| 解約率 | 2.1% |

# 構成図 {#architecture}

| 目的 | 処理の流れを示す |
| 備考 | 図は assets/ に置く |

![構成図](assets/architecture.png)

# 実装 {#code}

| 言語 | Python |

\`\`\`python
def hello():
    print("hello")
\`\`\`

# 比較 {#compare}

| 観点 | 左が旧版、右が新版 |

![旧版](assets/old.png "旧版")
![新版](assets/new.png "新版")
~~~

- Each slide starts with \`# title\`. \`{#id}\` after the title is the slide id: lowercase letters, digits and hyphens. Slides without one get an id when saved.
- Keep ids when you edit a deck: the canvas shows each slide as an image, and the notes the user drew on it follow the id when slides are reordered.
- A header row followed by \`|---|---|\` is dropped (it is not a slide row). Only "#" and "##" headings are allowed.
- Image paths are relative to the deck file. Images must be inside the workspace (png, jpg, webp, svg).

## JSON

~~~json
{
  "deckTitle": "四半期レビュー",
  "slides": [
    { "name": "cover", "layout": "title", "title": "四半期レビュー", "subtitle": ["2026 年 第 3 四半期"], "credits": ["山田 太郎"] },
    { "name": "summary", "layout": "bullets", "title": "今期の要点", "items": ["売上は前年比 **12%** 増", { "text": "解約率は横ばい", "children": ["要因を分析中"] }] },
    { "name": "metrics", "title": "指標", "rows": [{ "labelLines": ["売上"], "bodyLines": ["1.2 億円", "前年比 +12%"] }] },
    { "layout": "table-image", "title": "実装", "rows": [{ "labelLines": ["言語"], "bodyLines": ["Python"] }], "code": { "language": "python", "lines": ["print(1)"] } },
    { "layout": "table-images", "title": "比較", "rows": [{ "labelLines": ["観点"], "bodyLines": ["新旧"] }], "images": [{ "path": "assets/old.png", "alt": "旧版", "title": "旧版" }, { "path": "assets/new.png", "alt": "新版", "title": "新版" }] }
  ]
}
~~~

A slide without "layout" is a table. "image" is { "path", "alt" } for table-image.

## Workflow

1. Write the deck and call create_slide_deck (or update_slide_deck / edit_document for an existing deck).
2. Fix every warning the tool returns (usually by shortening text or splitting a slide).
3. Look at the slides with preview_slide_deck and adjust.
`
}

// /mcp を扱う。扱わないパスなら false を返す
export async function handleMcp(req: IncomingMessage, res: ServerResponse, path: string, deps: McpDeps): Promise<boolean> {
  if (path !== MCP_PATH) return false
  if (req.method !== 'POST') {
    // セッションを持たないので、GET（通知の購読）と DELETE（セッションの終了）は受けない
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'POST' })
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }))
    return true
  }
  const server = createMcpServer(deps)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res)
  } catch (err) {
    console.error('mcp request failed', err)
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }))
    }
  }
  return true
}

function summary(info: FileInfo): Pick<FileInfo, 'id' | 'kind' | 'title' | 'path' | 'missing'> {
  return { id: info.id, kind: info.kind, title: info.title, path: info.path, missing: info.missing }
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

function error(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

// FileStore の失敗（HttpError）を、AI が読めるツールのエラーにする
async function guard(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run()
  } catch (err) {
    if (!(err instanceof HttpError)) throw err
    if (err.status === 409) return error('The document was changed since you read it. Read it again (read_document / read_slide_deck) and retry.')
    if (err.status === 404) return error(`${err.message}. Use list_documents to find a valid id.`)
    return error(err.message)
  }
}
