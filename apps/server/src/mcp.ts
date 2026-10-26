import type { IncomingMessage, ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { normalizeRefId } from '@canvcode/core'
import { findPlotColumn, PLOT_KINDS, plotTable, plotUsesX, type ImageProps, type PlotKind, type PlotSpec } from '@canvcode/nodes'
import { HttpError, type FileInfo } from './files.ts'
import type { AgentHost } from './agent/host.ts'
import { EditError, editCanvas, editCanvasInput, undoCanvasEdit, type CreatedCanvas, type PreparedImage } from './agent/ops.ts'
import { preparePdfs, type PdfSources } from './agent/pdfSource.ts'
import { canvasFormatGuide, listCanvases, OutlineError, readCanvas, readNodes } from './agent/outline.ts'
import { PlotError, STYLE_FILE_NAME, type Plotter } from './plot.ts'
import type { RecordStore } from './records.ts'
import type { Presence } from './sync.ts'
import { addFileLocations, resolveReference, type RefDeps } from './refs.ts'

// AI から CanvCode を使うための MCP サーバー（MAI-59）。
// - Claude Code などが Streamable HTTP で /mcp につなぐ（claude mcp add --transport http canvcode http://127.0.0.1:8787/mcp）
// - 第 1 段は Markdown / Python の File の読み書きだけ。本文は FileStore（実ファイル）を通すので、レコードには触れない
// - 第 2 段で足したスライドデッキ（v1 の .slide.md / .slide.json）のツールは、v1 のスライドとともに消した。スライドは Canvas の slide ノードで作る
// - 書いたら開いているブラウザに知らせる。ブラウザは保存していない編集がなければ読み直し、あれば衝突として尋ねる
// - セッションは持たない（要求ごとにサーバーを作る）
// - ユーザーが CanvCode で範囲を選んでコピーした ref:XXXXXXXXXX は、resolve_reference で中身にする
// - 第 3 段で Canvas の上のものを読むツールを足した（agent/outline.ts）
// - 第 4 段で Canvas のノードを書き換えるツールを足した（agent/ops.ts。サーバーの中のワークスペース agent/host.ts で行う）
// - 第 5 段で、ユーザーが見ている Canvas と範囲（ブラウザが /api/sync で知らせる presence）を、Canvas のツールの既定にした
// - 第 6 段で、edit_canvas から PDF（ワークスペースのファイルか URL）を取り込み、空の Canvas の Portal を作れるようにした（agent/pdfSource.ts）
// - 第 7 段で、表（CSV）からグラフ（matplotlib の PNG）を描いて画像のノードとして置くツールを足した（plot.ts。list_plot_styles・plot_csv）

export const MCP_PATH = '/mcp'

// agent がなければ、Canvas は読むだけ（書き換えるツールを出さない）。presence はユーザーがいま見ている所（SyncHub.latestPresence）。
// pdf がなければ、edit_canvas で PDF を取り込めない。plot がなければ（か pdf の Asset がなければ）、グラフのツールを出さない
export type McpDeps = RefDeps & { agent?: AgentHost; presence?: () => Presence | null; pdf?: Omit<PdfSources, 'files'>; plot?: Plotter }

export function createMcpServer(deps: McpDeps): McpServer {
  const { files } = deps
  const server = new McpServer(
    { name: 'canvcode', version: '0.2.0' },
    {
      instructions:
        'CanvCode is an infinite canvas whose Markdown (.md), Python (.py) and table (.csv / .tsv) documents are real files. ' +
        'Use list_documents to find a document id, read_document before editing, and prefer edit_document for small changes. ' +
        'New documents appear under "未配置" (unplaced) in the sidebar; the user places them on a canvas. ' +
        'When the user\'s message contains an id like ref:XXXXXXXXXX, it points at a place the user selected in CanvCode ' +
        '(a region of a canvas, lines of a document, or a region of a PDF page): call resolve_reference with it first. ' +
        'Document ids (file:...) in its result can be passed to read_document. ' +
        'Documents in its result also carry absPath (the Markdown / Python file) or textPath (plain text extracted from a PDF, ' +
        'each page starting with a "=== page N ===" line); read those files directly when you need more than the referenced part. ' +
        'To see what is on a canvas, use list_canvases and read_canvas (a compact outline; get_canvas_format explains it), then read_nodes for details ' +
        '(its file fields carry the same absPath / textPath, also on a portal to the pages of a PDF). ' +
        'Canvas tools default to the canvas the user is viewing ("this", "here").' +
        (deps.agent
          ? ' To change a canvas, batch operations into one edit_canvas call (get_canvas_format lists the ops); the user can undo it, or you can with undo_canvas_edit.' +
            ' To make a presentation, put slides on a canvas (edit_canvas: create type "slide" with a template; get_canvas_format explains them).' +
            ' To show a PDF on a canvas, edit_canvas create type "pdf" with a path in the workspace or a url.' +
            (deps.plot && deps.pdf
              ? ' To chart a CSV / TSV document, read it (read_document), pick a style from list_plot_styles, then call plot_csv; it draws a PNG with matplotlib and places it as an image node.'
              : '')
          : ''),
    },
  )

  server.registerTool(
    'list_documents',
    {
      title: 'List documents',
      description:
        'List Markdown, Python and table (CSV) documents in the workspace. Filter by a substring of the title or path, and by kind. ' +
        'Also returns the absolute path of the workspace folder: .md / .py / .csv files written under it (subfolders too) appear as documents.',
      inputSchema: {
        query: z.string().optional().describe('Case-insensitive substring of the title or path'),
        kind: z.enum(['markdown', 'code', 'table']).optional().describe('markdown (.md), code (.py) or table (.csv / .tsv)'),
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
      return json({ workspace: files.root, documents: found })
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
        'Documents carry absPath (Markdown / Python file) or textPath (text extracted from a PDF, pages marked "=== page N ===") to read the whole document from disk. ' +
        'A PDF page that a canvas region only partly covers has "region": the covered part of the page (fraction of the page) and its text. ' +
        'When the region has freehand strokes or images, or covers a part of a PDF page that is mostly a figure ("figure": true), ' +
        'a PNG of the region comes first; the "image" field maps its pixels to world coordinates.',
      inputSchema: { id: z.string().describe('Reference id, e.g. ref:Ab12Cd34Ef (the ref: prefix may be omitted)') },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const normalized = normalizeRefId(id)
      const ref = normalized ? deps.records.getRef(normalized) : undefined
      if (!ref) return error(`Unknown reference id ${normalized ?? JSON.stringify(id)}. References are deleted 3 days after they are created. Ask the user to copy it again from CanvCode.`)
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
      description:
        'Create a new Markdown, Python or table (CSV) document. It is added to the workspace as unplaced; the user can place it on a canvas from the sidebar. ' +
        'A table is UTF-8 CSV text (comma-separated, "..." for cells with commas, quotes or newlines); its first row is shown as the header.',
      inputSchema: {
        kind: z.enum(['markdown', 'code', 'table']).describe('markdown (.md), code (.py) or table (.csv)'),
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
        const info = await files.write(id, content, expected_hash ?? '', { announce: true })
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
        const info = await files.write(id, crlf ? next.replace(/\n/g, '\r\n') : next, hash, { announce: true })
        return json({ document: summary(info), hash: info.hash, replaced: replace_all ? count : 1 })
      }),
  )

  registerCanvasTools(server, deps, deps.agent, deps.presence, deps.pdf && { files, ...deps.pdf }, deps.plot)
  return server
}

// ---- Canvas の上のもの ----

// 説明は短くする（ツールの一覧は毎回 AI に渡る）。詳しいことは get_canvas_format に書く
function registerCanvasTools(server: McpServer, refDeps: RefDeps, agent?: AgentHost, presence?: () => Presence | null, pdf?: PdfSources, plot?: Plotter): void {
  const { records } = refDeps
  // ユーザーが見ている所（その Canvas がまだあるときだけ）
  const viewing = (): Presence | null => {
    const current = presence?.() ?? null
    const canvas = current && records.get(current.canvasId)
    return canvas && canvas.typeName === 'canvas' && !canvas.deletedAt ? current : null
  }

  server.registerTool(
    'get_canvas_format',
    {
      title: 'Get the canvas format',
      description: 'Explains canvases, node types, coordinates, the read_canvas outline and edit_canvas ops. Call once first.',
      annotations: { readOnlyHint: true },
    },
    () => text(canvasFormatGuide({ editable: Boolean(agent) })),
  )

  server.registerTool(
    'list_canvases',
    {
      title: 'List canvases',
      description: 'The tree of canvases: id, title and node count; "viewing" marks the one the user is viewing. Filter by a substring of the title.',
      inputSchema: { query: z.string().optional().describe('Case-insensitive substring of the title') },
      annotations: { readOnlyHint: true },
    },
    ({ query }) => text(listCanvases(records, query, viewing()?.canvasId)),
  )

  server.registerTool(
    'read_canvas',
    {
      title: 'Read a canvas',
      description: 'Compact outline of the nodes on a canvas, one line per node, in world coordinates. Filter, page, or get only changes since a rev.',
      inputSchema: {
        canvas_id: z.string().optional().describe('Canvas id (default: the one the user is viewing, else the root)'),
        view: z.boolean().optional().describe("Only nodes on the user's screen"),
        rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional().describe('Only nodes intersecting this world rectangle'),
        query: z.string().optional().describe('Case-insensitive substring of the text'),
        types: z.array(z.string()).optional().describe('Node types, e.g. ["note", "geo/rect"]'),
        depth: z.number().int().min(0).optional().describe('Expand groups/frames this many levels (default 0)'),
        since: z.number().int().min(0).optional().describe('Only nodes changed after this rev'),
        limit: z.number().int().min(1).max(1000).optional().describe('Max lines (default 200)'),
        cursor: z.string().optional().describe('next= from the previous result'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ canvas_id, view, ...options }) =>
      outlineGuard(() => {
        const user = viewing()
        const canvasId = canvas_id ?? user?.canvasId ?? records.rootCanvasId
        const here = user?.canvasId === canvasId ? user.viewport : undefined
        if (view && !here) {
          throw new OutlineError(user ? `The user is viewing ${user.canvasId}, not ${canvasId}.` : 'No open CanvCode tab reports a view. Pass rect instead.')
        }
        return text(readCanvas(records, { canvasId, ...options, ...(view ? { rect: here } : {}), viewing: here }))
      }),
  )

  server.registerTool(
    'read_nodes',
    {
      title: 'Read nodes',
      description: 'Details of nodes by id (compact JSON): world position and size, text, colours, file (with absPath / textPath), arrow ends, children.',
      inputSchema: { ids: z.array(z.string()).min(1).max(100).describe('Node ids (node:...)') },
      annotations: { readOnlyHint: true },
    },
    async ({ ids }) => {
      const result = readNodes(records, ids)
      await addFileLocations(result.nodes, refDeps)
      return text(JSON.stringify(result))
    },
  )

  if (!agent) return
  server.registerTool(
    'edit_canvas',
    {
      title: 'Edit a canvas',
      description:
        'Apply ops (create, update, move, delete, group, ungroup, connect, align, distribute, scale, reparent, add_row) atomically. World coordinates. ' +
        'create can also make a portal to a new canvas, a shortcut portal to an existing one, or import a PDF (workspace file or URL) as a portal.',
      inputSchema: editCanvasInput,
      annotations: { destructiveHint: true },
    },
    ({ canvas_id, ops, if_rev, label }) =>
      editGuard(async () => {
        const user = viewing()
        const canvasId = canvas_id ?? user?.canvasId
        if (!canvasId) throw new EditError('No canvas_id, and no open CanvCode tab reports which canvas the user is viewing. Pass canvas_id (see list_canvases).')
        const viewport = user?.canvasId === canvasId ? user.viewport : undefined
        const pdfs = await preparePdfs(ops, pdf)
        const result = editCanvas(agent, { canvasId, ops, ifRev: if_rev, label, viewport, pdfs })
        // 取り込んだ PDF の文字（ページごとに「=== page N ===」）のファイル。AI が grep して、どのページかを探せる
        if (result.batch && result.canvases && pdf) {
          for (const [key, created] of Object.entries(result.canvases) as [string, CreatedCanvas & { textPath?: string }][]) {
            const index = key.startsWith('#') ? Number(key.slice(1)) : ops.findIndex((op) => (op as { as?: unknown }).as === key)
            const prepared = pdfs.get(index)
            const textFile = prepared && (await pdf.assets.pdfTextFile(prepared.asset.hash))
            if (textFile && !textFile.textless) created.textPath = textFile.path
          }
        }
        // 既定の Canvas を使ったときは、どこを変えたかを返す
        return text(JSON.stringify(canvas_id ? result : { canvas: canvasId, ...result }))
      }),
  )

  server.registerTool(
    'undo_canvas_edit',
    {
      title: 'Undo a canvas edit',
      description: 'Undo an edit_canvas call by its batch id, unless its nodes changed since.',
      inputSchema: { batch_id: z.string().describe('batch from edit_canvas') },
      annotations: { destructiveHint: true },
    },
    ({ batch_id }) => editGuard(async () => text(JSON.stringify(undoCanvasEdit(agent, batch_id)))),
  )

  if (plot && pdf) registerPlotTools(server, plot, pdf.assets, agent, pdf.files, records, viewing)
}

// 表（CSV）のグラフ（plot.ts）。描いた PNG を Asset に保存し、edit_canvas と同じ編集（元に戻せる）で画像のノードを置く・差し替える
function registerPlotTools(
  server: McpServer,
  plot: Plotter,
  assets: PdfSources['assets'],
  agent: AgentHost,
  files: McpDeps['files'],
  records: RecordStore,
  viewing: () => Presence | null,
): void {
  server.registerTool(
    'list_plot_styles',
    {
      title: 'List chart styles',
      description:
        `Styles for plot_csv, defined in ${STYLE_FILE_NAME} at the workspace root (matplotlib rcParams; the user can edit it, or ask you to add a style there). ` +
        'Returns name, description and series colours of each style, and the absolute path of the style file.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => plotGuard(async () => json({ styles: await plot.styles(), path: plot.stylePath })),
  )

  const column = z.union([z.string(), z.number().int().min(0)])
  server.registerTool(
    'plot_csv',
    {
      title: 'Chart a CSV',
      description:
        'Draw a chart from a table (CSV / TSV) document with matplotlib and place it on a canvas as an image node (or redraw an existing chart image). ' +
        'Columns are header names or 0-based indexes. kinds: line, bar, barh (horizontal bars), stacked (stacked bars), area (stacked area), scatter, ' +
        'pie (first y column; x gives the labels), hist and box (y columns only, x is ignored). Numbers may contain thousands separators, %, ¥ or full-width digits. ' +
        'The x column may be numbers, dates (2026-01-31, 2026/1, 2026年1月) or text (categories, in table order). ' +
        'Place it with x/y (world top-left) or place {rightOf|leftOf|below|above: node id}; by default it goes next to what the user is viewing. ' +
        'Pass node (an image made by plot_csv) to redraw that chart in place: omitted fields keep its current settings. ' +
        'The user can open "グラフを編集…" on the image to change the settings later.',
      inputSchema: {
        document: z.string().optional().describe('Table document id (file:...) or its path in the workspace. Not needed with node'),
        node: z.string().optional().describe('Redraw this chart image node instead of creating one'),
        kind: z.enum(PLOT_KINDS as [PlotKind, ...PlotKind[]]).optional().describe('Default line (new charts)'),
        x: column.nullable().optional().describe('Category / x-axis column; null = row numbers. Default: the first non-numeric column'),
        y: z.array(column).min(1).max(20).optional().describe('Value columns. Default: the numeric columns (up to 6)'),
        style: z.string().optional().describe('Style name from list_plot_styles (default: the first style)'),
        title: z.string().optional(),
        xlabel: z.string().nullable().optional().describe('Horizontal axis label; null = from the column name, "" = none'),
        ylabel: z.string().nullable().optional().describe('Vertical axis label; null = from the column name, "" = none'),
        legend: z.boolean().nullable().optional().describe('Default: only with 2+ series'),
        header: z.boolean().optional().describe('First row is the header (default true)'),
        width: z.number().int().min(150).max(4000).optional().describe("Image pixels (default: the style's size)"),
        height: z.number().int().min(150).max(4000).optional().describe("Image pixels (default: the style's size)"),
        canvas_id: z.string().optional().describe("Canvas id (default: the one the user is viewing)"),
        at: z.object({ x: z.number(), y: z.number() }).optional().describe('World top-left of a new chart'),
        place: z
          .object({ rightOf: z.string().optional(), leftOf: z.string().optional(), below: z.string().optional(), above: z.string().optional(), gap: z.number().optional() })
          .optional()
          .describe('Place a new chart next to a node'),
        w: z.number().positive().optional().describe('Node width in world units (default: half the pixel width)'),
        label: z.string().max(80).optional().describe('Short description shown to the user'),
      },
      annotations: { destructiveHint: true },
    },
    (input) =>
      plotGuard(async () => {
        const user = viewing()
        let existing: { canvasId: string; props: ImageProps } | null = null
        if (input.node) {
          const node = records.get(input.node)
          if (!node || node.typeName !== 'node' || node.type !== 'image' || !(node.props as ImageProps).plot) {
            throw new PlotError(`${input.node} is not a chart image made by plot_csv`)
          }
          existing = { canvasId: canvasOf(records, node.id), props: node.props as ImageProps }
        }
        const base = existing?.props.plot
        const fileId = input.document ? resolveTable(files, input.document) : base?.fileId
        if (!fileId) throw new PlotError('Pass document (a table document id or path)')
        const header = input.header ?? base?.header ?? true
        const table = plotTable((await files.read(fileId)).text, files.getInfo(fileId).path, header)
        const col = (ref: string | number) => {
          const index = findPlotColumn(table.columns, ref)
          if (index === null) throw new PlotError(`No column ${JSON.stringify(ref)}. Columns: ${table.columns.map((c) => `${c.index}:${c.name}${c.numeric ? '' : ' (text)'}`).join(', ')}`)
          return index
        }
        const kind = input.kind ?? base?.kind ?? 'line'
        const x = input.x === null ? null : input.x !== undefined ? col(input.x) : base && !input.document ? base.x : (table.columns.find((c) => !c.numeric)?.index ?? null)
        const y = input.y
          ? input.y.map(col)
          : base && !input.document
            ? base.y
            : table.columns.filter((c) => c.numeric && c.index !== x).slice(0, 6).map((c) => c.index)
        if (y.length === 0) throw new PlotError(`No numeric column to plot. Pass y. Columns: ${table.columns.map((c) => `${c.index}:${c.name}`).join(', ')}`)
        // スタイルの既定の大きさ（style.py の size）は、新しく作るときと、スタイルを変えて大きさを渡さなかったとき
        const styleName = input.style ?? base?.style ?? ''
        const styles = !styleName || ((!base || input.style) && (input.width === undefined || input.height === undefined)) ? await plot.styles() : []
        const chosen = styles.find((s) => s.name === styleName) ?? (styleName ? undefined : styles[0])
        const size = !base || input.style ? chosen?.size : undefined
        const spec: PlotSpec = {
          fileId,
          header,
          x: plotUsesX(kind) ? x : (base?.x ?? x),
          y,
          kind,
          style: styleName || (chosen?.name ?? ''),
          title: input.title ?? base?.title ?? '',
          xlabel: input.xlabel !== undefined ? input.xlabel : (base?.xlabel ?? null),
          ylabel: input.ylabel !== undefined ? input.ylabel : (base?.ylabel ?? null),
          legend: input.legend !== undefined ? input.legend : (base?.legend ?? null),
          width: input.width ?? size?.[0] ?? base?.width ?? 1280,
          height: input.height ?? size?.[1] ?? base?.height ?? 800,
        }
        const rendered = await plot.render(spec)
        const hash = await assets.storeOriginal(rendered.png, 'image/png', rendered.width, rendered.height)
        const image: PreparedImage = { hash, size: rendered.png.length, width: rendered.width, height: rendered.height, plot: spec }
        const label = input.label ?? `グラフ：${spec.title || files.getInfo(fileId).title}`
        let result
        if (existing) {
          // 幅はそのままにして、高さを新しい画像の縦横比に合わせる（切り抜いていたらやめる）。
          // 描いている間にユーザーが大きさを変えたかもしれないので、今の幅を読み直す
          const current = records.get(input.node!) as { props?: ImageProps } | undefined
          if (!current?.props) throw new PlotError(`${input.node} was deleted while drawing`)
          const w = current.props.w
          const ops = [{ op: 'update', id: input.node, props: { assetId: `asset:${hash}`, plot: spec, crop: null }, w, h: (w * rendered.height) / rendered.width }]
          result = editCanvas(agent, { canvasId: existing.canvasId, ops, label, images: new Map([[0, image]]) })
        } else {
          // canvas_id がなければ、place の相手の Canvas、それもなければユーザーが見ている Canvas
          const near = input.place && (input.place.rightOf ?? input.place.leftOf ?? input.place.below ?? input.place.above)
          const canvasId = input.canvas_id ?? (near && records.get(near) ? canvasOf(records, near) : undefined) ?? user?.canvasId
          if (!canvasId) throw new EditError('No canvas_id, and no open CanvCode tab reports which canvas the user is viewing. Pass canvas_id (see list_canvases).')
          const viewport = user?.canvasId === canvasId ? user.viewport : undefined
          const op = { op: 'create', type: 'image', as: 'chart', ...(input.at ?? {}), ...(input.place ? { place: input.place } : {}), ...(input.w ? { w: input.w } : {}) }
          result = editCanvas(agent, { canvasId, ops: [op], label, viewport, images: new Map([[0, image]]) })
        }
        return json({
          ...(existing ? { node: input.node } : { node: result.created.chart }),
          batch: result.batch,
          rev: result.rev,
          spec: { ...spec, x: spec.x === null ? null : table.columns[spec.x]?.name, y: spec.y.map((i) => table.columns[i]?.name) },
          ...(rendered.warnings.length ? { warnings: rendered.warnings } : {}),
        })
      }),
  )
}

// 文書の id かワークスペースの中のパスから、表の File の id を引く
function resolveTable(files: McpDeps['files'], ref: string): string {
  const info = ref.startsWith('file:') ? files.list().find((f) => f.id === ref) : files.list().find((f) => f.path === ref.replace(/^\.\//, ''))
  if (!info) throw new PlotError(`Unknown document ${JSON.stringify(ref)}. Use list_documents (kind: table) to find one.`)
  if (info.kind !== 'table') throw new PlotError(`${info.path} is not a table (CSV / TSV) document`)
  return info.id
}

// ノードが置いてある Canvas（group・frame の中なら、その上をたどる）
function canvasOf(records: RecordStore, nodeId: string): string {
  let parentId = (records.get(nodeId) as { parentId?: string } | undefined)?.parentId
  for (let depth = 0; parentId && depth < 64; depth++) {
    const parent = records.get(parentId)
    if (!parent || parent.typeName !== 'node') return parentId
    parentId = (parent as { parentId?: string }).parentId
  }
  if (!parentId) throw new PlotError(`Cannot find the canvas of ${nodeId}`)
  return parentId
}

async function plotGuard(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof PlotError || err instanceof EditError) return error(err.message)
    if (err instanceof HttpError) return error(err.message)
    throw err
  }
}

async function editGuard(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof EditError) return error(err.message)
    throw err
  }
}

function outlineGuard(run: () => CallToolResult): CallToolResult {
  try {
    return run()
  } catch (err) {
    if (err instanceof OutlineError) return error(err.message)
    throw err
  }
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

function text(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }] }
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
    if (err.status === 409) return error('The document was changed since you read it. Read it again (read_document) and retry.')
    if (err.status === 404) return error(`${err.message}. Use list_documents to find a valid id.`)
    return error(err.message)
  }
}
