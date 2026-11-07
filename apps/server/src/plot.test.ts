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
// 描くテストは python3 と matplotlib が要る（なければ飛ばす。CANVCODE_PYTHON で python の場所を変える）。
// matplotlib を読み込むのに 1 回 0.5〜1 秒かかるので、待つ時間を延ばす

const PYTHON = process.env.CANVCODE_PYTHON ?? 'python3'
// 同梱の style.py は seaborn を使う
const hasMatplotlib = spawnSync(PYTHON, ['-c', 'import matplotlib, seaborn'], { stdio: 'ignore' }).status === 0
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) })

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
  const plot = new Plotter({ workspace, files, python: PYTHON, ...options })
  return { workspace, dataDir, files, plot }
}

function spec(fileId: string, change: Partial<PlotSpec> = {}): PlotSpec {
  return { fileId, header: true, x: 0, y: [1, 2], kind: 'line', style: '', title: '売上', xlabel: null, ylabel: null, legend: null, legendNcol: null, width: 640, height: 400, ...change }
}

const CSV = '月,東京,大阪\n1月,"1,200",800\n2月,1500,950\n3月,1700,x\n'
// 系列の名前が長い 5 系列（プレゼンのスタイルで 4 列に並べると、1000×1000 の図の幅からはみ出す）
const LONG_NAMES = ['東京都の売上高（前年同月比）', '大阪府の売上高（前年同月比）', '愛知県の売上高（前年同月比）', '福岡県の売上高（前年同月比）', '北海道の売上高（前年同月比）']
const LONG_CSV = `月,${LONG_NAMES.join(',')}\n${['1月', '2月', '3月', '4月'].map((m, i) => [m, ...LONG_NAMES.map((_, j) => 100 + i * (j + 1))].join(',')).join('\n')}\n`
const LEGEND_TOO_WIDE = '凡例が図の幅に収まりません。列の数を減らしてください'
const LEGEND_TOO_BIG = '凡例が大きく、グラフの幅が狭くなっています。列の数を減らしてください'

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
    // 資料は、指定がなければ凡例を 1 列にする（MAI-95）
    expect(styles[0]!.legend_ncol).toBeUndefined()
    expect(styles[2]).toMatchObject({ name: '資料', legend_ncol: 1 })
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

  it.skipIf(!hasMatplotlib)('draws exactly the asked size: 1440×1440 for the presentation style, and with savefig.bbox "tight" (MAI-95)', async () => {
    const { plot, files, workspace } = await setup()
    const table = await files.create('table', '売上', CSV)
    const square = await plot.render(spec(table.id, { style: 'プレゼン', width: 1440, height: 1440 }))
    expect(pngSize(square.png)).toEqual({ width: 1440, height: 1440 })
    expect(square).toMatchObject({ width: 1440, height: 1440 })
    // savefig.bbox が "tight" だと、図の外の文字まで広げて大きさが変わる（1440 が 1463 になっていた）
    writeFileSync(join(workspace, 'style.py'), 'STYLES = {"tight": {"rc": {"savefig.bbox": "tight", "savefig.pad_inches": 0.3}}}\n')
    for (const [width, height] of [
      [1440, 1440],
      [641, 401],
    ] as const) {
      const result = await plot.render(spec(table.id, { title: 'とても長いタイトル'.repeat(4), width, height }))
      expect(pngSize(result.png)).toEqual({ width, height })
      expect(result).toMatchObject({ width, height })
    }
  }, 30_000)

  it.skipIf(!hasMatplotlib)('passes the legend columns to style.py: the chart, then the style, then the series (MAI-95)', async () => {
    const { plot, files, workspace } = await setup()
    const table = await files.create('table', '売上', CSV)
    writeFileSync(
      join(workspace, 'style.py'),
      'def check(ax, ncol):\n    raise ValueError(f"ncol={ncol}")\nSTYLES = {"a": {"legend": check}, "one": {"legend": check, "legend_ncol": 1}, "bad": {"legend": check, "legend_ncol": 0}}\n',
    )
    const ncol = (n: number) => `style.py の legend でエラーになりました：ValueError: ncol=${n}`
    await expect(plot.render(spec(table.id, { style: 'a', legendNcol: 3 }))).rejects.toThrow(ncol(3))
    // 自動：2 系列なら 2 列。スタイルの既定があればそれ（読めない既定は使わない）。指定はスタイルの既定より勝つ
    await expect(plot.render(spec(table.id, { style: 'a' }))).rejects.toThrow(ncol(2))
    await expect(plot.render(spec(table.id, { style: 'one' }))).rejects.toThrow(ncol(1))
    await expect(plot.render(spec(table.id, { style: 'bad' }))).rejects.toThrow(ncol(2))
    await expect(plot.render(spec(table.id, { style: 'one', legendNcol: 3 }))).rejects.toThrow(ncol(3))
    expect((await plot.styles()).map((s) => s.legend_ncol)).toEqual([undefined, 1, undefined])
  }, 30_000)

  it.skipIf(!hasMatplotlib)('narrows an automatic legend that is wider than the image, and warns about a chosen one (MAI-95)', async () => {
    const { plot, files, workspace } = await setup()
    const table = await files.create('table', '長い名前', LONG_CSV)
    const long = (change: Partial<PlotSpec>) => spec(table.id, { y: [1, 2, 3, 4, 5], style: 'プレゼン', width: 1000, height: 1000, ...change })
    const chosen = await plot.render(long({ legendNcol: 4 }))
    expect(chosen.warnings).toContain(LEGEND_TOO_WIDE)
    const auto = await plot.render(long({}))
    expect(auto.warnings).not.toContain(LEGEND_TOO_WIDE)
    expect(auto).toMatchObject({ width: 1000, height: 1000 })
    // 収まる列の数を指定すれば知らせない
    expect((await plot.render(long({ legendNcol: 1 }))).warnings).not.toContain(LEGEND_TOO_WIDE)

    // 資料（凡例は軸の右の外）に 2 列を指定すると、凡例は図に収まるが軸がつぶれる：知らせる。自動（1 列）では知らせない
    const docs = (change: Partial<PlotSpec>) => long({ style: '資料', width: 1280, height: 800, ...change })
    const crushed = await plot.render(docs({ legendNcol: 2 }))
    expect(crushed.warnings).toContain(LEGEND_TOO_BIG)
    expect(crushed.warnings).not.toContain(LEGEND_TOO_WIDE)
    const docsAuto = await plot.render(docs({}))
    expect(docsAuto.warnings).not.toContain(LEGEND_TOO_BIG)
    expect(docsAuto.warnings).not.toContain(LEGEND_TOO_WIDE)

    // 自動では 4 列から減らして呼び直し、収まる。指定した列の数は減らさない（呼んだ列の数と、収まったかを after で知らせる）
    writeFileSync(
      join(workspace, 'style.py'),
      [
        'calls = []',
        'def legend(ax, ncol):',
        '    calls.append(ncol)',
        '    handles, labels = ax.get_legend_handles_labels()',
        '    ax.get_legend().remove()',
        '    ax.figure.legend(handles, labels, ncol=ncol, loc="outside lower center")',
        'def after(fig, ax):',
        '    fig.draw_without_rendering()',
        '    box = fig.legends[-1].get_window_extent()',
        '    raise ValueError(f"calls={calls} fits={box.x0 >= 0 and box.x1 <= fig.bbox.width}")',
        'STYLES = {"wide": {"legend": legend, "after": after, "rc": {"legend.fontsize": 14}}}',
        '',
      ].join('\n'),
    )
    await expect(plot.render(long({ style: 'wide' }))).rejects.toThrow(/calls=\[4(, [123])+\] fits=True/)
    await expect(plot.render(long({ style: 'wide', legendNcol: 4 }))).rejects.toThrow('calls=[4] fits=False')
  }, 30_000)

  it.skipIf(!hasMatplotlib)('keeps working when style.py prints, and stops a render that was given up', async () => {
    const { plot, files, workspace } = await setup()
    const table = await files.create('table', '売上', CSV)
    writeFileSync(join(workspace, 'style.py'), 'print("debug")\ndef setup():\n    print("setup")\nSTYLES = {"a": {"setup": setup}}\n')
    expect((await plot.styles()).map((s) => s.name)).toEqual(['a'])
    await expect(plot.render(spec(table.id, { width: 150, height: 150 }))).resolves.toMatchObject({ width: 150, height: 150 })
    // 一度に 2 つまで。3 つ目を待っている間にやめると順番から外れ、描いている途中でやめると止める
    const busy = [plot.render(spec(table.id)), plot.render(spec(table.id))]
    const waiting = new AbortController()
    const third = plot.render(spec(table.id), waiting.signal)
    waiting.abort()
    await expect(third).rejects.toMatchObject({ status: 499 })
    await Promise.all(busy)
    const running = new AbortController()
    const started = plot.render(spec(table.id), running.signal)
    setTimeout(() => running.abort(), 50)
    await expect(started).rejects.toMatchObject({ status: 499 })
    await expect(plot.render(spec(table.id))).resolves.toMatchObject({ width: 640 })
  }, 30_000)

  it.skipIf(!hasMatplotlib)('reads only real numbers and dates, and refuses too many bars but groups pie slices', async () => {
    const { plot, files } = await setup()
    // 3,5 は小数の , なので数にしない（1,200 は桁区切り）。2026/1/5 は日付の軸
    const odd = await files.create('table', 'odd', '日,値\n2026/1/5,"1,200"\n2026/1/12,"3,5"\n2026/2/1,1e400\n')
    const result = await plot.render(spec(odd.id, { y: [1] }))
    expect(result.warnings).toEqual(['列「値」の 2 行目「3,5」は数でないので飛ばしました'])
    await expect(plot.render(spec(odd.id, { y: [1], kind: 'hist' }))).resolves.toMatchObject({ width: 640 })
    const rows = Array.from({ length: 2100 }, (_, i) => `r${i},${i + 1}`).join('\n')
    const many = await files.create('table', 'many', `名前,値\n${rows}\n`)
    await expect(plot.render(spec(many.id, { y: [1], kind: 'bar' }))).rejects.toThrow('棒が多すぎます（2100 本。2000 本まで）')
    await expect(plot.render(spec(many.id, { y: [1], kind: 'pie' }))).resolves.toMatchObject({ width: 640 })
    await expect(plot.render(spec(many.id, { y: [1], kind: 'box' }))).resolves.toMatchObject({ width: 640 })
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
    return { ...base, records, client, call, assets, agent }
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

  it.skipIf(!hasMatplotlib)('keeps the legend columns in the spec, and draws a 1440×1440 image as a 720 wide node (MAI-95)', async () => {
    const { call, files, records, dataDir, agent } = await mcp()
    await files.create('table', '売上', CSV)
    const made = await call('plot_csv', { document: '売上.csv', y: ['東京', '大阪'], style: 'プレゼン', width: 1440, height: 1440, legend_ncol: 2, canvas_id: records.rootCanvasId })
    expect(made.isError).toBe(false)
    expect(made.data.spec).toMatchObject({ legendNcol: 2, width: 1440, height: 1440 })
    const node = () => records.get(made.data.node) as unknown as { props: ImageProps }
    expect(node().props).toMatchObject({ w: 720, h: 720, plot: { legendNcol: 2 } })
    const hash = node().props.assetId.replace('asset:', '')
    expect(JSON.parse(readFileSync(join(dataDir, 'assets', `${hash}.json`), 'utf8'))).toMatchObject({ width: 1440, height: 1440 })

    // 描き直す：渡さなければ今の列の数のまま、null なら自動に戻す
    expect((await call('plot_csv', { node: made.data.node, title: '売上' })).isError).toBe(false)
    expect(node().props.plot).toMatchObject({ title: '売上', legendNcol: 2 })
    expect((await call('plot_csv', { node: made.data.node, legend_ncol: null })).isError).toBe(false)
    expect(node().props.plot).toMatchObject({ title: '売上', legendNcol: null })

    // ほかのタブが書いた、読めない列の数の作り方は、形を確かめてから使う（自動にする）
    const record = { ...records.get(made.data.node)!, props: { ...node().props, plot: { ...node().props.plot, legendNcol: 99 } } }
    records.apply([record], [])
    agent.applyRemote([record as never], [])
    expect((await call('plot_csv', { node: made.data.node, kind: 'bar' })).isError).toBe(false)
    expect(node().props.plot).toMatchObject({ kind: 'bar', legendNcol: null })

    // 1〜20 のほかは断る
    for (const legend_ncol of [0, 21, 2.5]) {
      const bad = await call('plot_csv', { node: made.data.node, legend_ncol })
      expect(bad.isError).toBe(true)
      expect(bad.text).toContain('legend_ncol')
    }
  }, 60_000)
})
