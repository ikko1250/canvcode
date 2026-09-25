import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

// メモリーのベンチマーク（MAI-67、MAI-66 の下調べ）。npm run bench:memory で動かす。
// 1. 使い捨てのワークスペースでサーバーを起動する（本番のワークスペースには書き込まない）
// 2. 素材を作る：ルートに Canvas を N 個（Portal）作り、それぞれに画像・PDF・Markdown（File）を置く。
//    PDF は Chromium の page.pdf() で、画像入りのページを混ぜて作る
// 3. 新しいブラウザのコンテキスト（素材を作ったときの手元の Blob などが残らないように）で開き直し、
//    ルート → Canvas i → その PDF の Canvas → ルート … と巡回する。移るたびに、画像を作り終えるまで待ち、
//    GC してから JS ヒープ・プロセスのメモリー（Linux のみ）・画面が持っているものの内訳を記録する
// 4. 結果を test-results/bench-memory/ に JSON と Markdown の表で出す
//
// 開いた Canvas の数に比例して増え続け、ルートに戻っても下がらないものが、上限のないキャッシュ（または漏れ）

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

const { values: args } = parseArgs({
  options: {
    canvases: { type: 'string', default: '6' },
    images: { type: 'string', default: '3' },
    'pdf-pages': { type: 'string', default: '12' },
    markdown: { type: 'string', default: '3' },
    // 4190 などはブラウザと fetch が拒むポートなので避ける
    port: { type: 'string', default: '4188' },
    out: { type: 'string', default: 'test-results/bench-memory' },
    keep: { type: 'boolean', default: false },
    headed: { type: 'boolean', default: false },
  },
})

const config = {
  canvases: positiveInt(args.canvases, 'canvases'),
  images: positiveInt(args.images, 'images'),
  pdfPages: positiveInt(args['pdf-pages'], 'pdf-pages'),
  markdown: positiveInt(args.markdown, 'markdown'),
  port: positiveInt(args.port, 'port'),
}
const BASE = `http://127.0.0.1:${config.port}`
// 画像を作り終えたとみなすまで、何もしていない状態が続く時間と、待つ上限
const SETTLE_QUIET_MS = 1500
const SETTLE_TIMEOUT_MS = 60_000
const VIEWPORT = { width: 1280, height: 800 }

function positiveInt(value: string | undefined, name: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer: ${value}`)
  return n
}

// ---- 画面から読むもの（apps/web/src/memoryStats.ts と同じ形） ----

interface MemoryBreakdown {
  records: { count: number; jsonChars: number; byType: Record<string, number> }
  editors: number
  imageCache: { entries: number; bytes: number; idle: boolean }
  thumbnails: { entries: number; bytes: number }
  assets: { records: number; pdfDocuments: number; localAssets: number; uploads: number }
  files: { entries: number; chars: number; dirty: number }
  markdownImages: { entries: number; chars: number }
}

interface BenchCanvas {
  title: string
  canvasId: string
  pdfCanvasId: string | null
}

interface StepResult {
  step: number
  label: string
  canvasId: string
  settleMs: number
  settledInTime: boolean
  heap: { usedBytes: number; totalBytes: number }
  metrics: Record<string, number>
  processes: { type: string; pssBytes: number | null }[] | null
  app: MemoryBreakdown
}

// ---- サーバー ----

async function startServer(workspace: string, logPath: string): Promise<ChildProcess> {
  // 前の実行のサーバーなどが残っていると、そちらに素材を作ってしまうので、先に確かめる
  if (await fetch(`${BASE}/api/health`).then(() => true, () => false)) {
    throw new Error(`${BASE} ではすでに何かが動いています。止めるか、--port でほかのポートを指定してください`)
  }
  const server = spawn(process.execPath, [join(ROOT, 'apps/server/src/index.ts'), '--workspace', workspace], {
    cwd: ROOT,
    env: { ...process.env, CANVCODE_PORT: String(config.port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log: string[] = []
  server.stdout!.on('data', (chunk) => log.push(String(chunk)))
  server.stderr!.on('data', (chunk) => log.push(String(chunk)))
  server.on('exit', () => void writeFile(logPath, log.join('')).catch(() => {}))
  // 途中で止められても（Ctrl+C・パイプが閉じたなど）サーバーを残さない
  process.on('exit', () => server.kill())
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, () => process.exit(130))
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`The server exited:\n${log.join('')}`)
    try {
      const response = await fetch(`${BASE}/api/health`)
      if (response.ok) return server
    } catch {
      // まだ起動していない
    }
    await delay(200)
  }
  server.kill()
  throw new Error(`The server did not start:\n${log.join('')}`)
}

// ---- 素材 ----

// 画像入りのページを混ぜた PDF。seed ごとに中身が変わる（同じ中身だと Asset がまとめられてしまう）
async function makePdf(browser: Browser, seed: number, pages: number): Promise<Buffer> {
  const page = await browser.newPage()
  try {
    const sections = Array.from({ length: pages }, (_, i) => {
      const body = paragraphs(seed * 1000 + i, 4)
        .map((p) => `<p>${p}</p>`)
        .join('')
      const figure = i % 2 === 0 ? `<canvas data-seed="${seed * 1000 + i}" width="1200" height="800"></canvas>` : ''
      return `<section><h1>Bench PDF ${seed} — page ${i + 1}</h1>${body}${figure}</section>`
    }).join('')
    await page.setContent(`<!doctype html><html><head><style>
      body { font-family: sans-serif; margin: 0 }
      section { page-break-after: always; padding: 24px }
      canvas { width: 100%; height: auto }
    </style></head><body>${sections}</body></html>`)
    await page.evaluate(() => {
      for (const canvas of document.querySelectorAll<HTMLCanvasElement>('canvas[data-seed]')) {
        const ctx = canvas.getContext('2d')!
        let state = Number(canvas.dataset.seed) + 1
        const random = () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
        for (let y = 0; y < canvas.height; y += 16) {
          for (let x = 0; x < canvas.width; x += 16) {
            ctx.fillStyle = `rgb(${(random() * 255) | 0},${(random() * 255) | 0},${(random() * 255) | 0})`
            ctx.fillRect(x, y, 16, 16)
          }
        }
      }
    })
    return await page.pdf({ format: 'A4', printBackground: true })
  } finally {
    await page.close()
  }
}

const WORDS =
  'canvas portal markdown slide deck memory heap image cache record workspace node editor quote anchor render layer camera zoom pan index history'.split(' ')

function paragraphs(seed: number, count: number): string[] {
  let state = seed + 7
  const random = () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  return Array.from({ length: count }, () =>
    Array.from({ length: 40 + Math.floor(random() * 40) }, () => WORDS[Math.floor(random() * WORDS.length)]).join(' ') + '.',
  )
}

function makeMarkdown(seed: number, imageUrl: string | null): string {
  const lines = [`# Bench note ${seed}`, '']
  for (let section = 0; section < 6; section++) {
    lines.push(`## Section ${section + 1}`, '')
    for (const p of paragraphs(seed * 100 + section, 3)) lines.push(p, '')
    lines.push('- item one', '- item two', '  - nested item', '')
    lines.push('```python', `def f${section}(x):`, `    return x * ${section + 1}`, '```', '')
    lines.push('| a | b | c |', '| - | - | - |', `| ${section} | ${section * 2} | ${section * 3} |`, '')
  }
  if (imageUrl) lines.push(`![bench image](${imageUrl})`, '')
  lines.push('$$', 'e^{i\\pi} + 1 = 0', '$$', '')
  return lines.join('\n')
}

// pdf.js（pdfjs-dist 6）は Map.prototype.getOrInsertComputed と Math.sumPrecise を使う。これを持たない古い Chromium
// （Playwright の既定より古いものを CANVCODE_CHROMIUM で指定したときなど）でも PDF を開けるよう、ないときだけ補う
async function newContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: VIEWPORT })
  await context.addInitScript(() => {
    for (const type of [Map, WeakMap] as any[]) {
      if (typeof type.prototype.getOrInsertComputed === 'function') continue
      Object.defineProperty(type.prototype, 'getOrInsertComputed', {
        configurable: true,
        writable: true,
        value(this: Map<unknown, unknown>, key: unknown, compute: (key: unknown) => unknown) {
          if (!this.has(key)) this.set(key, compute(key))
          return this.get(key)
        },
      })
    }
    if (typeof (Math as any).sumPrecise !== 'function') {
      ;(Math as any).sumPrecise = (values: Iterable<number>) => {
        let sum = 0
        for (const value of values) sum += value
        return sum
      }
    }
  })
  return context
}

async function waitForApp(page: Page): Promise<void> {
  await page.goto(BASE)
  await page.waitForFunction(() => Boolean((window as any).canvcode?.view))
}

// 画面の中で、Canvas に移って、画像・PDF・Markdown を置く
async function populate(browser: Browser): Promise<BenchCanvas[]> {
  const pdfs: string[] = []
  for (let i = 0; i < config.canvases; i++) pdfs.push((await makePdf(browser, i + 1, config.pdfPages)).toString('base64'))

  const context = await newContext(browser)
  const page = await context.newPage()
  page.on('pageerror', (error) => console.error('[page error]', error))
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') console.error(`[page ${message.type()}]`, message.text())
  })
  try {
    await waitForApp(page)
    const canvases: BenchCanvas[] = []
    for (let i = 0; i < config.canvases; i++) {
      const title = `Bench ${i + 1}`
      const markdown = Array.from({ length: config.markdown }, (_, k) => k)
      const created = await page.evaluate(
        async ({ i, title, pdf, images }) => {
          const app = (window as any).canvcode
          const root = app.workspace.rootCanvasId
          const columns = 4
          const { canvasId } = app.editor.createPortal({ x: (i % columns) * 400, y: Math.floor(i / columns) * 320 }, { title })
          await app.navigate(canvasId)

          // 画像：1 枚目は 4000×3000 の JPEG（写真ほどの大きさ）、残りは 1600×1200 の PNG。どれも seed ごとに違う模様
          const files: File[] = []
          for (let j = 0; j < images; j++) {
            const large = j === 0
            const w = large ? 4000 : 1600
            const h = large ? 3000 : 1200
            const canvas = new OffscreenCanvas(w, h)
            const ctx = canvas.getContext('2d')!
            let state = i * 100 + j + 1
            const random = () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
            const block = large ? 8 : 16
            for (let y = 0; y < h; y += block) {
              for (let x = 0; x < w; x += block) {
                ctx.fillStyle = `rgb(${(random() * 255) | 0},${((x / w) * 255) | 0},${((y / h) * 255) | 0})`
                ctx.fillRect(x, y, block, block)
              }
            }
            const type = large ? 'image/jpeg' : 'image/png'
            const blob = await canvas.convertToBlob({ type, quality: 0.85 })
            files.push(new File([blob], `bench-${i + 1}-${j + 1}.${large ? 'jpg' : 'png'}`, { type }))
          }
          await app.view.importFiles(files, { x: 0, y: 0 })

          // PDF：ページを並べた Canvas とその Portal ができる
          const bytes = Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0))
          const portalId = await app.view.importPdf(new File([bytes], `bench-${i + 1}.pdf`, { type: 'application/pdf' }), { x: 1400, y: 0 })
          const pdfCanvasId = portalId ? (app.editor.getNode(portalId)?.props.targetId ?? null) : null

          // Markdown：1 つ目には、この Canvas の画像を 1 枚埋め込む（Markdown の画像のキャッシュも測る）
          const imageNode = [...app.editor.index.allIds()].map((id: string) => app.editor.getNode(id)).find((n: any) => n?.type === 'image')
          const asset = imageNode ? app.view.assets.get(imageNode.props.assetId) : undefined
          // Markdown は http(s) の画像しか描かないので、絶対 URL にする
          const imageUrl = asset ? new URL(app.view.assets.url(asset, 1024), location.href).href : null
          return { canvasId, pdfCanvasId, imageUrl, root }
        },
        { i, title, pdf: pdfs[i], images: config.images },
      )
      for (const k of markdown) {
        const text = makeMarkdown((i + 1) * 10 + k, k === 0 ? created.imageUrl : null)
        await page.evaluate(
          async ({ k, title, text }) => {
            const app = (window as any).canvcode
            const file = await app.files.create('markdown', title, text)
            app.editor.createFileCard(file.id, { x: k * 700 - 700, y: 1400 })
          },
          { k, title: `${title} note ${k + 1}`, text },
        )
      }
      await page.evaluate((root) => (window as any).canvcode.navigate(root), created.root)
      canvases.push({ title, canvasId: created.canvasId, pdfCanvasId: created.pdfCanvasId })
      console.log(`  populated ${title}${created.pdfCanvasId ? '' : '（PDF を取り込めませんでした）'}`)
    }
    // アップロード・File の保存・レコードの同期が済むまで待つ
    await page.evaluate(async () => {
      const app = (window as any).canvcode
      await app.view.assets.settled()
      await app.files.flush()
      app.sync.flush()
    })
    await page.waitForFunction(() => !(window as any).canvcode.sync.pending, undefined, { timeout: 30_000 })
    // 離れるときに作ったサムネイルの保存を待つ（fetch の完了を直接は待てないので、少し置く）
    await delay(1000)
    return canvases
  } finally {
    await context.close()
  }
}

// ---- 計測 ----

async function settle(page: Page, canvasId: string): Promise<{ ms: number; inTime: boolean }> {
  const start = Date.now()
  let quietSince: number | null = null
  let previous = ''
  while (Date.now() - start < SETTLE_TIMEOUT_MS) {
    const state = await page.evaluate((canvasId) => {
      const app = (window as any).canvcode
      const memory = app.memory()
      return {
        here: app.editor.canvasId === canvasId,
        idle: memory.imageCache.idle,
        // 画像が増えている・本文を読んでいる間は、まだ落ち着いていない
        signature: `${memory.imageCache.entries}/${memory.imageCache.bytes}/${memory.files.entries}/${memory.thumbnails.entries}/${memory.assets.pdfDocuments}`,
      }
    }, canvasId)
    if (state.here && state.idle && state.signature === previous) {
      quietSince ??= Date.now()
      if (Date.now() - quietSince >= SETTLE_QUIET_MS) return { ms: Date.now() - start, inTime: true }
    } else {
      quietSince = null
    }
    previous = state.signature
    await delay(250)
  }
  return { ms: Date.now() - start, inTime: false }
}

async function measure(page: Page, cdp: CDPSession, browserCdp: CDPSession): Promise<Omit<StepResult, 'step' | 'label' | 'canvasId' | 'settleMs' | 'settledInTime'>> {
  // 弱い参照や最終処理のあとにもう一度回るものがあるので、2 回
  await cdp.send('HeapProfiler.collectGarbage')
  await cdp.send('HeapProfiler.collectGarbage')
  const usage = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number; totalSize: number }
  const { metrics } = (await cdp.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] }
  const app = (await page.evaluate(() => (window as any).canvcode.memory())) as MemoryBreakdown
  return {
    heap: { usedBytes: usage.usedSize, totalBytes: usage.totalSize },
    metrics: Object.fromEntries(metrics.filter((m) => ['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'Documents', 'JSEventListeners'].includes(m.name)).map((m) => [m.name, m.value])),
    processes: await processMemory(browserCdp),
    app,
  }
}

// ブラウザのプロセスごとのメモリー（PSS）。/proc を読むので Linux だけ。ほかの OS では null
async function processMemory(browserCdp: CDPSession): Promise<StepResult['processes']> {
  if (process.platform !== 'linux') return null
  try {
    const { processInfo } = (await browserCdp.send('SystemInfo.getProcessInfo')) as { processInfo: { type: string; id: number }[] }
    return await Promise.all(
      processInfo.map(async ({ type, id }) => {
        try {
          const text = await readFile(`/proc/${id}/smaps_rollup`, 'utf8')
          const kb = /^Pss:\s+(\d+) kB/m.exec(text)
          return { type, pssBytes: kb ? Number(kb[1]) * 1024 : null }
        } catch {
          return { type, pssBytes: null }
        }
      }),
    )
  } catch {
    return null
  }
}

async function tour(browser: Browser, canvases: BenchCanvas[]): Promise<StepResult[]> {
  const context = await newContext(browser)
  const page = await context.newPage()
  page.on('pageerror', (error) => console.error('[page error]', error))
  const cdp = await context.newCDPSession(page)
  await cdp.send('Performance.enable')
  const browserCdp = await browser.newBrowserCDPSession()
  try {
    await waitForApp(page)
    const rootId = (await page.evaluate(() => (window as any).canvcode.workspace.rootCanvasId)) as string
    const steps: { label: string; canvasId: string }[] = [{ label: 'ルート（開いた直後）', canvasId: rootId }]
    for (const canvas of canvases) {
      steps.push({ label: canvas.title, canvasId: canvas.canvasId })
      if (canvas.pdfCanvasId) steps.push({ label: `${canvas.title} の PDF`, canvasId: canvas.pdfCanvasId })
      steps.push({ label: `ルート（${canvas.title} のあと）`, canvasId: rootId })
    }
    const results: StepResult[] = []
    for (const [index, step] of steps.entries()) {
      if (index > 0) await page.evaluate((id) => (window as any).canvcode.navigate(id), step.canvasId)
      const settled = await settle(page, step.canvasId)
      const result = { step: index, label: step.label, canvasId: step.canvasId, settleMs: settled.ms, settledInTime: settled.inTime, ...(await measure(page, cdp, browserCdp)) }
      results.push(result)
      console.log(`  ${summaryLine(result)}`)
    }
    return results
  } finally {
    await browserCdp.detach().catch(() => {})
    await context.close()
  }
}

// ---- 出力 ----

const MB = 1024 * 1024

function mb(bytes: number | null | undefined): string {
  return bytes === null || bytes === undefined ? '—' : (bytes / MB).toFixed(1)
}

function pss(result: StepResult, type: string): number | null {
  if (!result.processes) return null
  const matching = result.processes.filter((p) => p.type === type && p.pssBytes !== null)
  return matching.length === 0 ? null : matching.reduce((sum, p) => sum + p.pssBytes!, 0)
}

function summaryLine(result: StepResult): string {
  return (
    `${String(result.step).padStart(2)} ${result.label}: heap ${mb(result.heap.usedBytes)} MB, renderer ${mb(pss(result, 'renderer'))} MB, ` +
    `images ${mb(result.app.imageCache.bytes)} MB (${result.app.imageCache.entries}), pdf ${result.app.assets.pdfDocuments}, editors ${result.app.editors}` +
    (result.settledInTime ? '' : '（落ち着く前に計測）')
  )
}

function markdownReport(results: StepResult[], meta: Record<string, unknown>): string {
  const header = [
    '| # | 場所 | JS ヒープ (MB) | renderer PSS (MB) | GPU PSS (MB) | 画像キャッシュ (MB / 件) | サムネイル (MB / 件) | 開いている PDF | File の本文 (件 / 千字) | Markdown の画像 (件) | Editor | レコード (件 / JSON MB) | 待ち (s) |',
    '| -: | -- | -: | -: | -: | -: | -: | -: | -: | -: | -: | -: | -: |',
  ]
  const rows = results.map((r) =>
    [
      r.step,
      r.label + (r.settledInTime ? '' : ' ⚠'),
      mb(r.heap.usedBytes),
      mb(pss(r, 'renderer')),
      mb(pss(r, 'GPU')),
      `${mb(r.app.imageCache.bytes)} / ${r.app.imageCache.entries}`,
      `${mb(r.app.thumbnails.bytes)} / ${r.app.thumbnails.entries}`,
      r.app.assets.pdfDocuments,
      `${r.app.files.entries} / ${(r.app.files.chars / 1000).toFixed(0)}`,
      r.app.markdownImages.entries,
      r.app.editors,
      `${r.app.records.count} / ${mb(r.app.records.jsonChars)}`,
      (r.settleMs / 1000).toFixed(1),
    ].join(' | '),
  )
  const first = results.find((r) => r.label.startsWith('ルート'))
  const last = results.at(-1)
  const growth =
    first && last
      ? [
          '',
          `ルートに戻ったときの増え方（最初 → 最後）：JS ヒープ ${mb(first.heap.usedBytes)} → ${mb(last.heap.usedBytes)} MB、` +
            `renderer ${mb(pss(first, 'renderer'))} → ${mb(pss(last, 'renderer'))} MB、` +
            `画像キャッシュ ${mb(first.app.imageCache.bytes)} → ${mb(last.app.imageCache.bytes)} MB、` +
            `開いている PDF ${first.app.assets.pdfDocuments} → ${last.app.assets.pdfDocuments}、Editor ${first.app.editors} → ${last.app.editors}`,
        ]
      : []
  return [
    '# メモリーのベンチマーク（MAI-67）',
    '',
    '```json',
    JSON.stringify(meta, null, 2),
    '```',
    '',
    '- JS ヒープ：CDP で GC を 2 回かけたあとの `Runtime.getHeapUsage` の usedSize（ページのメインスレッドのみ。pdf.js の Worker は含まない）',
    '- PSS：`/proc/<pid>/smaps_rollup`（Linux のみ）。renderer は Worker・デコード済みの画像を含む',
    '- 画像キャッシュ・サムネイルは幅×高さ×4 で数えた目安。⚠ は、画像を作り終える前に計測したもの',
    '',
    ...header,
    ...rows.map((row) => `| ${row} |`),
    ...growth,
    '',
  ].join('\n')
}

// ---- 本体 ----

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  if (!existsSync(join(ROOT, 'apps/web/dist/index.html'))) {
    throw new Error('画面がビルドされていません。npm run build -w @canvcode/web を先に実行してください（npm run bench:memory なら自動で行います）')
  }
  const outDir = resolve(ROOT, args.out!)
  await mkdir(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const workspace = await mkdtemp(join(tmpdir(), 'canvcode-bench-'))
  console.log(`workspace: ${workspace}`)
  const server = await startServer(workspace, join(outDir, `memory-${stamp}.server.log`))
  let browser: Browser | null = null
  try {
    // サーバーと同じく、CANVCODE_CHROMIUM があればその Chromium を使う
    browser = await chromium.launch({ headless: !args.headed, executablePath: process.env.CANVCODE_CHROMIUM || undefined })
    console.log(`populating ${config.canvases} canvases…`)
    const canvases = await populate(browser)
    console.log('touring…')
    const results = await tour(browser, canvases)
    const meta = { date: new Date().toISOString(), config, browser: browser.version(), platform: `${process.platform} ${process.arch}`, viewport: VIEWPORT }
    const jsonPath = join(outDir, `memory-${stamp}.json`)
    const mdPath = join(outDir, `memory-${stamp}.md`)
    await writeFile(jsonPath, JSON.stringify({ meta, canvases, results }, null, 2))
    const report = markdownReport(results, meta)
    await writeFile(mdPath, report)
    console.log(`\n${report}`)
    console.log(`results: ${jsonPath}\n         ${mdPath}`)
  } finally {
    await browser?.close()
    server.kill()
    if (args.keep) console.log(`kept workspace: ${workspace}`)
    else await rm(workspace, { recursive: true, force: true })
  }
}

await main()
