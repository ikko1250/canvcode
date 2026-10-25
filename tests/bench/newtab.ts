import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { indicesBetween, createId } from '@canvcode/core'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { RecordStore } from '../../apps/server/src/records.ts'

// 新しいタブで開くまでのベンチマーク（docs/lazy-canvas-loading-plan.md）。npm run bench:newtab で動かす。
// 1. レコードの数ごとに、使い捨てのワークスペースを作る（本番のワークスペースには書き込まない）。
//    ルートに Project の Canvas を 12 個置き、その下に、付箋・文字・図形・矢印を 100 個ずつ置いた Canvas を並べる
// 2. サーバーを起動し、元のタブ（ルート）を開いたまま、同じブラウザで新しいタブに 1 つの Canvas を開く。
//    回線ごとに --runs 回測り、中央値を出す
// 3. 結果を test-results/bench-newtab/ に JSON と Markdown の表で出す
//
// 測るもの（新しいタブを開き始めてからの時間）：
// - records：/api/records の大きさ（転送量）、サーバーが返し始めるまで（TTFB）、受け取り、JSON.parse
// - 組み立て：JSON.parse が終わってから、画面（window.canvcode）ができるまで
// - 操作できるまで：画面ができた時刻
// - 絵が出そろうまで：画像のキャッシュが落ち着くまで（落ち着いたとみなす静かな時間は引く）
// - ヒープ：GC したあとの JS ヒープ

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

const { values: args } = parseArgs({
  options: {
    // ワークスペースに足すノードの数（カンマ区切り）
    records: { type: 'string', default: '0,5000,20000,50000' },
    runs: { type: 'string', default: '5' },
    // local：遅延なし / remote：遅延 40 ms・下り 20 Mbps・上り 10 Mbps（SSH 越しを想定した仮の値）
    net: { type: 'string', default: 'local,remote' },
    port: { type: 'string', default: '4300' },
    out: { type: 'string', default: 'test-results/bench-newtab' },
  },
})

const NETWORKS: Record<string, { latency: number; downloadThroughput: number; uploadThroughput: number } | null> = {
  local: null,
  remote: { latency: 40, downloadThroughput: (20 * 1e6) / 8, uploadThroughput: (10 * 1e6) / 8 },
}
const config = {
  records: args.records!.split(',').map((value) => nonNegativeInt(value, 'records')),
  runs: nonNegativeInt(args.runs, 'runs') || 1,
  nets: args.net!.split(','),
  port: nonNegativeInt(args.port, 'port'),
}
for (const net of config.nets) if (!(net in NETWORKS)) throw new Error(`--net must be local or remote: ${net}`)
const VIEWPORT = { width: 1280, height: 800 }
// 1 つの Canvas に置くノードの数と、Project の Canvas の数
const PER_CANVAS = 100
const PROJECTS = 12
const SETTLE_QUIET_MS = 1000
const SETTLE_TIMEOUT_MS = 60_000

function nonNegativeInt(value: string | undefined, name: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer: ${value}`)
  return n
}

// ---- ワークスペースを作る ----

// count 個のノードを足し、新しいタブで開く Canvas（ノードのある最初の Canvas。count が 0 ならルート）の id を返す
function populate(dataDir: string, count: number): string {
  const store = new RecordStore(dataDir)
  try {
    const root = store.rootCanvasId
    if (count === 0) return root
    const now = Date.now()
    const puts: unknown[] = []
    const canvas = (id: string, title: string, parent: string, owner: string) => ({
      typeName: 'canvas', id, title, parentCanvasId: parent, ownerNodeId: owner, createdAt: now, updatedAt: now, deletedAt: null, trash: null,
    })
    const portal = (parent: string, target: string, x: number, y: number, index: string) => ({
      typeName: 'node', id: createId('node'), type: 'portal', parentId: parent, x, y, rotation: 0, index, opacity: 1, locked: false,
      props: { targetId: target, role: 'owner', w: 240, h: 170 }, meta: {},
    })
    const paragraphs = (text: string) => [{ runs: [{ text }] }]
    const projects: string[] = []
    const projectIndices = indicesBetween(null, null, PROJECTS)
    for (let p = 0; p < PROJECTS; p++) {
      const id = createId('canvas')
      const node = portal(root, id, (p % 4) * 300, Math.floor(p / 4) * 250, projectIndices[p])
      puts.push(node, canvas(id, `Project ${p + 1}`, root, node.id))
      projects.push(id)
    }
    const leaves = Math.ceil(count / PER_CANVAS)
    const perProject = Math.ceil(leaves / PROJECTS)
    let first: string | null = null
    for (let p = 0; p < PROJECTS; p++) {
      const n = Math.max(0, Math.min(perProject, leaves - p * perProject))
      const leafIndices = indicesBetween(null, null, Math.max(n, 1))
      for (let l = 0; l < n; l++) {
        const id = createId('canvas')
        first ??= id
        const node = portal(projects[p], id, (l % 6) * 300, Math.floor(l / 6) * 250, leafIndices[l])
        puts.push(node, canvas(id, `Canvas ${p + 1}-${l + 1}`, projects[p], node.id))
        const indices = indicesBetween(null, null, PER_CANVAS)
        for (let k = 0; k < PER_CANVAS; k++) {
          const base = { typeName: 'node', id: createId('node'), parentId: id, x: (k % 10) * 260, y: Math.floor(k / 10) * 240, rotation: 0, index: indices[k], opacity: 1, locked: false, meta: {} }
          const kind = k % 4
          if (kind === 0) {
            const text = `メモ ${k}：調べたことの抜き書き。根拠になる資料と、次に確かめることを書いておく。`.repeat(1 + (k % 3))
            puts.push({ ...base, type: 'note', version: 2, props: { paragraphs: paragraphs(text), w: 220, h: 200, color: '#fff3bf', fontSize: 12, fontFamily: 'sans-serif', align: 'left', sizing: 'auto' } })
          } else if (kind === 1) {
            puts.push({ ...base, type: 'text', version: 2, props: { paragraphs: paragraphs(`見出し ${k}`), fontSize: 12, color: '#1f2328', fontFamily: 'sans-serif', align: 'left', w: 200, autoWidth: true } })
          } else if (kind === 2) {
            const fill = { type: 'solid', color: '#e8eefc', opacity: 1 }
            const stroke = { type: 'solid', color: '#3b5bdb', opacity: 1 }
            puts.push({ ...base, type: 'geo', version: 3, props: { shape: 'rect', w: 120, h: 120, fill, stroke, strokeWidth: 2, label: `箱 ${k}` } })
          } else {
            const props = { start: { x: 0, y: 0 }, end: { x: 100, y: 40 }, bend: 0, clip: [0, 1], color: '#1f2328', size: 3, arrowheadStart: 'none', arrowheadEnd: 'arrow', label: '' }
            puts.push({ ...base, type: 'arrow', props })
          }
        }
      }
    }
    store.apply(puts, [])
    return first ?? root
  } finally {
    store.close()
  }
}

// ---- サーバーとブラウザ ----

async function startServer(workspace: string, port: number): Promise<ChildProcess> {
  const server = spawn(process.execPath, [join(ROOT, 'apps/server/src/index.ts'), '--workspace', workspace], {
    cwd: ROOT,
    env: { ...process.env, CANVCODE_PORT: String(port), CANVCODE_CLAUDE: '0' },
    stdio: 'ignore',
  })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/records`)).ok) return server
    } catch {
      // まだ起動していない
    }
    await delay(200)
  }
  server.kill()
  throw new Error('サーバーが起動しませんでした')
}

// 時刻を記録する仕掛け：/api/records の JSON.parse にかかった時間と、画面（window.canvcode）ができた時刻
async function newContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: VIEWPORT })
  await context.addInitScript(() => {
    const w = window as any
    w.__bench = {}
    const json = Response.prototype.json
    Response.prototype.json = async function (this: Response) {
      if (!new URL(this.url).pathname.startsWith('/api/records')) return json.call(this)
      const text = await this.text()
      const start = performance.now()
      const value = JSON.parse(text)
      Object.assign(w.__bench, { parsedAt: performance.now(), parseMs: performance.now() - start })
      return value
    }
    let app: unknown
    Object.defineProperty(w, 'canvcode', {
      configurable: true,
      get: () => app,
      set: (value) => {
        app = value
        w.__bench.readyAt ??= performance.now()
      },
    })
  })
  return context
}

async function settle(page: Page): Promise<void> {
  const start = Date.now()
  let quietSince: number | null = null
  let previous = ''
  while (Date.now() - start < SETTLE_TIMEOUT_MS) {
    const state = await page.evaluate(() => {
      const memory = (window as any).canvcode.memory()
      return { idle: memory.imageCache.idle, signature: `${memory.imageCache.entries}/${memory.imageCache.bytes}/${memory.files.entries}/${memory.thumbnails.entries}` }
    })
    if (state.idle && state.signature === previous) {
      quietSince ??= Date.now()
      if (Date.now() - quietSince >= SETTLE_QUIET_MS) return
    } else {
      quietSince = null
    }
    previous = state.signature
    await delay(100)
  }
}

interface Run {
  records: number
  net: string
  run: number
  recordsBytes: number
  ttfbMs: number
  downloadMs: number
  parseMs: number
  buildMs: number
  readyMs: number
  settledMs: number
  otherBytes: number
  heapBytes: number
}

async function measure(browser: Browser, base: string, canvasId: string, records: number, net: string): Promise<Run[]> {
  const context = await newContext(browser)
  try {
    // 元のタブ（開いたままにする。画面のプログラムなどは、ブラウザのキャッシュに入る）
    const first = await context.newPage()
    await first.goto(base)
    await first.waitForFunction(() => Boolean((window as any).canvcode?.view))
    await settle(first)
    const runs: Run[] = []
    for (let run = 0; run < config.runs; run++) {
      const page = await context.newPage()
      const cdp = await context.newCDPSession(page)
      const conditions = NETWORKS[net]
      if (conditions) {
        await cdp.send('Network.enable')
        await cdp.send('Network.emulateNetworkConditions', { offline: false, ...conditions })
      }
      const started = Date.now()
      await page.goto(`${base}/c/${encodeURIComponent(canvasId)}`)
      await page.waitForFunction(() => Boolean((window as any).canvcode?.view))
      await settle(page)
      const settledMs = Date.now() - started - SETTLE_QUIET_MS
      const timing = await page.evaluate(() => {
        const bench = (window as any).__bench
        const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
        const records = resources.find((r) => new URL(r.name).pathname.startsWith('/api/records'))!
        return {
          recordsBytes: records.transferSize,
          ttfbMs: records.responseStart - records.requestStart,
          downloadMs: records.responseEnd - records.responseStart,
          parseMs: bench.parseMs,
          buildMs: bench.readyAt - bench.parsedAt,
          readyMs: bench.readyAt,
          otherBytes: resources.filter((r) => r !== records).reduce((sum, r) => sum + r.transferSize, 0),
        }
      })
      await cdp.send('HeapProfiler.collectGarbage')
      const heap = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number }
      runs.push({ records, net, run, ...timing, settledMs, heapBytes: heap.usedSize })
      await page.close()
    }
    return runs
  } finally {
    await context.close()
  }
}

// ---- 出力 ----

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function markdownReport(runs: Run[], meta: Record<string, unknown>): string {
  const ms = (value: number) => `${Math.round(value)} ms`
  const sec = (value: number) => `${(value / 1000).toFixed(1)} 秒`
  const mb = (value: number) => `${(value / 1024 / 1024).toFixed(2)} MB`
  const rows: string[] = []
  for (const records of config.records) {
    for (const net of config.nets) {
      const group = runs.filter((r) => r.records === records && r.net === net)
      const m = (key: keyof Run) => median(group.map((r) => r[key] as number))
      rows.push(
        `| ${records} | ${net} | ${mb(m('recordsBytes'))} | ${ms(m('ttfbMs'))} | ${ms(m('downloadMs'))} | ${ms(m('parseMs'))} | ${ms(m('buildMs'))} | ` +
          `**${sec(m('readyMs'))}** | ${sec(m('settledMs'))} | ${mb(m('otherBytes'))} | ${mb(m('heapBytes'))} |`,
      )
    }
  }
  return [
    '# 新しいタブで開くまで',
    '',
    `${meta.date}・${meta.browser}・${meta.platform}・各 ${config.runs} 回の中央値`,
    '',
    '| 足したノード | 回線 | /api/records | 返し始めるまで | 受け取り | JSON.parse | 組み立て | 操作できるまで | 絵が出そろうまで | ほかの転送量 | ヒープ |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  if (!existsSync(join(ROOT, 'apps/web/dist/index.html'))) {
    throw new Error('画面がビルドされていません。npm run build -w @canvcode/web を先に実行してください（npm run bench:newtab なら自動で行います）')
  }
  const outDir = resolve(ROOT, args.out!)
  await mkdir(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const browser = await chromium.launch({ executablePath: process.env.CANVCODE_CHROMIUM || undefined })
  const runs: Run[] = []
  try {
    for (const records of config.records) {
      const workspace = await mkdtemp(join(tmpdir(), 'canvcode-newtab-'))
      try {
        const canvasId = populate(join(workspace, '.canvcode'), records)
        const server = await startServer(workspace, config.port)
        try {
          for (const net of config.nets) {
            console.log(`measuring ${records} nodes, ${net}…`)
            runs.push(...(await measure(browser, `http://127.0.0.1:${config.port}`, canvasId, records, net)))
          }
        } finally {
          server.kill()
          await delay(300)
        }
      } finally {
        await rm(workspace, { recursive: true, force: true })
      }
    }
    const meta = { date: new Date().toISOString(), config, browser: browser.version(), platform: `${process.platform} ${process.arch}`, viewport: VIEWPORT }
    const report = markdownReport(runs, meta)
    await writeFile(join(outDir, `newtab-${stamp}.json`), JSON.stringify({ meta, runs }, null, 2))
    await writeFile(join(outDir, `newtab-${stamp}.md`), report)
    console.log(`\n${report}`)
    console.log(`results: ${join(outDir, `newtab-${stamp}.md`)}`)
  } finally {
    await browser.close()
  }
}

await main()
