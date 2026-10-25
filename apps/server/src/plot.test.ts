import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import type { ImageProps, PlotSpec } from '@canvcode/nodes'
import { AgentHost } from './agent/host.ts'
import { AssetStore } from './assets.ts'
import { FileStore } from './files.ts'
import { handleMcp, MCP_PATH } from './mcp.ts'
import { DEFAULT_STYLE_FILE, describeFailure, PlotError, Plotter } from './plot.ts'
import { RecordStore } from './records.ts'
import type { Presence } from './sync.ts'

// CSV から作るグラフ（plot.ts・apps/server/plot/plot.py・MCP の plot_csv）。
// 描くテストは python3 と matplotlib が要る（なければ飛ばす）。matplotlib を読み込むのに 1 回 0.5〜1 秒かかるので、待つ時間を延ばす

// 同梱の style.py は seaborn を使う
const hasMatplotlib = spawnSync('python3', ['-c', 'import matplotlib, seaborn'], { stdio: 'ignore' }).status === 0
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47])

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(options: { python?: string } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'canvcode-plot-'))
  cleanups.push(() => rmSync(workspace, { recursive: true, force: true }))
  const dataDir = join(workspace, '.canvcode')
  const files = new FileStore(workspace, dataDir, () => {})
  await files.init()
  cleanups.push(() => files.close())
  const plot = new Plotter({ workspace, files, ...options })
  return { workspace, dataDir, files, plot }
}

function spec(fileId: string, change: Partial<PlotSpec> = {}): PlotSpec {
  return { fileId, header: true, x: 0, y: [1, 2], kind: 'line', style: '', title: '売上', xlabel: null, ylabel: null, legend: null, width: 640, height: 400, ...change }
}

const CSV = '月,東京,大阪\n1月,"1,200",800\n2月,1500,950\n3月,1700,x\n'

describe('Plotter', () => {
  it('turns plot.py failures into messages', () => {
    expect(describeFailure(2, 'findfont: Failed to find font weight bold\n列「v」に数がありません\n').message).toBe('列「v」に数がありません')
    const missing = describeFailure(1, "Traceback...\nModuleNotFoundError: No module named 'matplotlib'\n")
    expect(missing.status).toBe(503)
    expect(missing.message).toContain('pip install matplotlib')
    expect(describeFailure(1, 'Traceback\nValueError: boom\n').message).toBe('グラフを描けませんでした：ValueError: boom')
    // style.py の読み込みの失敗（終了コード 2）でも、seaborn がないことはそう知らせる
    expect(describeFailure(2, "style.py の読み込みに失敗しました：ModuleNotFoundError: No module named 'seaborn'\n").message).toContain('pip install seaborn')
  })

  it('says so when python is missing', async () => {
    const { plot } = await setup({ python: 'canvcode-no-such-python' })
    await expect(plot.styles()).rejects.toMatchObject({ status: 503, message: expect.stringContaining('canvcode-no-such-python が見つかりません') })
  })

  it('refuses a document that is not a table, and a column that is not there', async () => {
    const { plot, files } = await setup()
    const note = await files.create('markdown', 'メモ', '# メモ\n')
    await expect(plot.render(spec(note.id))).rejects.toThrow('表（CSV）ではありません')
    const table = await files.create('table', '売上', CSV)
    await expect(plot.render(spec(table.id, { y: [5] }))).rejects.toThrow('列 6 は 売上.csv にありません（3 列）')
    await expect(plot.render(spec('file:nope'))).rejects.toBeInstanceOf(PlotError)
  })

  it.skipIf(!hasMatplotlib)('copies style.py into the workspace once and lists its styles', async () => {
    const { plot, workspace } = await setup()
    const styles = await plot.styles()
    expect(styles.map((s) => s.name)).toEqual(['プレゼン', 'プレゼン（横長）', '資料', '白黒'])
    expect(styles[0]).toMatchObject({ size: [1440, 1440] })
    expect(styles[0]!.colors[0]).toBe('#0173b2')
    expect(readFileSync(join(workspace, 'style.py'), 'utf8')).toBe(readFileSync(DEFAULT_STYLE_FILE, 'utf8'))
    // ユーザーが直した style.py は上書きしない
    writeFileSync(join(workspace, 'style.py'), 'STYLES = {"mine": {"description": "自分の", "rc": {"lines.linewidth": 4}}}\n')
    expect(await plot.ensureStyleFile()).toBe(false)
    expect((await plot.styles()).map((s) => s.name)).toEqual(['mine'])
  }, 30_000)

  it.skipIf(!hasMatplotlib)('draws every kind as a PNG of the asked size, with warnings for cells that are not numbers', async () => {
    const { plot, files } = await setup()
    const table = await files.create('table', '売上', CSV)
    const kinds = ['line', 'bar', 'barh', 'stacked', 'area', 'scatter', 'pie', 'hist', 'box'] as const
    // python は一度に 2 つまで動く（Plotter の MAX_RUNNING）
    const results = await Promise.all(kinds.map((kind) => plot.render(spec(table.id, { kind }))))
    for (const result of results) {
      expect(result.png.subarray(0, 4).equals(PNG_SIGNATURE)).toBe(true)
      expect(result.png.readUInt32BE(16)).toBe(640)
      expect(result.png.readUInt32BE(20)).toBe(400)
      expect(result.warnings).toContain('列「大阪」の 3 行目「x」は数でないので飛ばしました')
    }
  }, 60_000)

  it.skipIf(!hasMatplotlib)('tells the user what is wrong: no numbers, an unknown style, a broken style.py', async () => {
    const { plot, files, workspace } = await setup()
    const table = await files.create('table', '売上', CSV)
    await expect(plot.render(spec(table.id, { y: [0] }))).rejects.toThrow('列「月」に数がありません')
    await expect(plot.render(spec(table.id, { style: 'ない' }))).rejects.toThrow('スタイル「ない」は style.py にありません')
    writeFileSync(join(workspace, 'style.py'), 'STYLES = {\n')
    await expect(plot.render(spec(table.id))).rejects.toThrow('style.py の読み込みに失敗しました')
    // setup・legend の中の誤りも、どこで起きたかを添えて知らせる（legend は凡例を出したときだけ呼ぶ）
    writeFileSync(join(workspace, 'style.py'), 'def boom(*args):\n    raise ValueError("だめ")\nSTYLES = {"a": {"setup": boom}, "b": {"legend": boom}}\n')
    await expect(plot.render(spec(table.id, { style: 'a' }))).rejects.toThrow('style.py の setup でエラーになりました：ValueError: だめ')
    await expect(plot.render(spec(table.id, { style: 'b' }))).rejects.toThrow('style.py の legend でエラーになりました：ValueError: だめ')
    await expect(plot.render(spec(table.id, { style: 'b', y: [1] }))).resolves.toMatchObject({ width: 640 })
  }, 30_000)

  it.skipIf(!hasMatplotlib)('serves the styles and the PNG over HTTP', async () => {
    const { plot, files } = await setup()
    const table = await files.create('table', '売上', CSV)
    const server: Server = createServer((req, res) => void plot.handle(req, res, new URL(req.url ?? '/', 'http://x').pathname))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const styles = (await (await fetch(`${base}/api/plot/styles`)).json()) as { styles: { name: string }[]; path: string }
    expect(styles.path).toBe('style.py')
    expect(styles.styles[0]!.name).toBe('プレゼン')
    const response = await fetch(`${base}/api/plot`, { method: 'POST', body: JSON.stringify(spec(table.id, { kind: 'bar' })) })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('x-canvcode-width')).toBe('640')
    expect(JSON.parse(decodeURIComponent(response.headers.get('x-canvcode-warnings')!))).toHaveLength(1)
    const bad = await fetch(`${base}/api/plot`, { method: 'POST', body: JSON.stringify({ fileId: table.id, y: [] }) })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toContain('値の列')
  }, 30_000)
})

describe('MCP plot tools', () => {
  async function mcp() {
    const base = await setup()
    const records = new RecordStore(base.dataDir)
    cleanups.push(() => records.close())
    const agent = new AgentHost({ records, files: base.files })
    cleanups.push(() => agent.dispose())
    const assets = new AssetStore(base.dataDir)
    await assets.init()
    const view: { current: Presence | null } = { current: null }
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      void handleMcp(req, res, url.pathname, { files: base.files, records, dataDir: base.dataDir, agent, presence: () => view.current, pdf: { assets }, plot: base.plot })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}${MCP_PATH}`)))
    cleanups.push(() => client.close())
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args })
      const text = (result.content as { text: string }[])[0]!.text
      return { isError: result.isError === true, text, data: result.isError ? undefined : JSON.parse(text) }
    }
    return { ...base, records, client, call, assets }
  }

  it('offers the plot tools only with a plotter, and edit_canvas cannot create images by itself', async () => {
    const { client, call, records } = await mcp()
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toContain('plot_csv')
    expect(names).toContain('list_plot_styles')
    expect(client.getInstructions()).toContain('plot_csv')
    const created = await call('edit_canvas', { canvas_id: records.rootCanvasId, ops: [{ op: 'create', type: 'image' }] })
    expect(created.isError).toBe(true)
    expect(created.text).toContain('use plot_csv')
  })

  it.skipIf(!hasMatplotlib)('charts a CSV by column names, places it as an image with its spec, and redraws it in place', async () => {
    const { call, files, records, dataDir } = await mcp()
    const table = await files.create('table', '売上', CSV)
    const missing = await call('plot_csv', { document: '売上.csv', y: ['名古屋'], canvas_id: records.rootCanvasId })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('No column "名古屋". Columns: 0:月 (text), 1:東京, 2:大阪')

    const made = await call('plot_csv', { document: '売上.csv', kind: 'bar', x: '月', y: ['東京', '大阪'], style: 'プレゼン（横長）', canvas_id: records.rootCanvasId, at: { x: 100, y: 50 } })
    expect(made.isError).toBe(false)
    // 大きさを渡さなければ、スタイルの size（1920×1080）
    expect(made.data.spec).toMatchObject({ kind: 'bar', x: '月', y: ['東京', '大阪'], style: 'プレゼン（横長）', width: 1920, height: 1080 })
    expect(made.data.warnings).toEqual(['列「大阪」の 3 行目「x」は数でないので飛ばしました'])
    const node = records.get(made.data.node) as unknown as { type: string; x: number; y: number; props: ImageProps }
    expect(node).toMatchObject({ type: 'image', x: 100, y: 50 })
    expect(node.props).toMatchObject({ w: 960, h: 540, crop: null, plot: { fileId: table.id, x: 0, y: [1, 2], kind: 'bar', style: 'プレゼン（横長）' } })
    const hash = node.props.assetId.replace('asset:', '')
    expect(JSON.parse(readFileSync(join(dataDir, 'assets', `${hash}.json`), 'utf8'))).toMatchObject({ mime: 'image/png', width: 1920, height: 1080 })

    // 描き直す：渡さなかったものは今の作り方のまま。幅はそのままで、高さを新しい縦横比に合わせる
    const redrawn = await call('plot_csv', { node: made.data.node, kind: 'line', height: 1280 })
    expect(redrawn.isError).toBe(false)
    const after = records.get(made.data.node) as unknown as { props: ImageProps }
    expect(after.props.plot).toMatchObject({ kind: 'line', style: 'プレゼン（横長）', y: [1, 2], width: 1920, height: 1280 })
    expect(after.props.w).toBe(960)
    expect(after.props.h).toBe(640)
    expect(after.props.assetId).not.toBe(node.props.assetId)

    // 既定：最初の文字の列を横の軸に、数の列を値にする
    const auto = await call('plot_csv', { document: table.id, canvas_id: records.rootCanvasId })
    // （大阪は数でないセルがあるので、数の列に入らない）
    expect(auto.data.spec).toMatchObject({ kind: 'line', x: '月', y: ['東京'], style: 'プレゼン', width: 1440, height: 1440 })
  }, 60_000)
})
