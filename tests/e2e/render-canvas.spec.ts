import { expect, test, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// AI の render_canvas（MAI-89。docs/canvas-image-plan.md）：サーバーが開いているタブに頼んで Canvas を描いてもらい、PNG を返す。
// lazy-canvas.spec.ts と同じく、本物のサーバー（使い捨てのワークスペース）と、それにつないだ Vite の開発サーバーを、このファイルの中で起動し、
// MCP のクライアントで edit_canvas と render_canvas を呼ぶ

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

test.describe.configure({ mode: 'serial' })

let server: ChildProcess | null = null
let vite: ChildProcess | null = null
let workspaceDir = ''
let base = ''
let apiBase = ''
let mcp: Client | null = null

async function waitFor(url: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // まだ起動していない
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`did not start: ${url}`)
}

// oxlint-disable-next-line no-empty-pattern -- Playwright は最初の引数を分割代入で受け取るよう求める
test.beforeAll(async ({}, info) => {
  const port = 4420 + info.workerIndex * 2
  workspaceDir = mkdtempSync(join(tmpdir(), 'canvcode-render-'))
  apiBase = `http://127.0.0.1:${port}`
  base = `http://127.0.0.1:${port + 1}`
  server = spawn(process.execPath, [join(ROOT, 'apps/server/src/index.ts'), '--workspace', workspaceDir], {
    cwd: ROOT,
    env: { ...process.env, CANVCODE_PORT: String(port), CANVCODE_CLAUDE: '0' },
    stdio: 'ignore',
  })
  vite = spawn('npm', ['run', 'dev', '-w', '@canvcode/web', '--', '--host', '127.0.0.1', '--port', String(port + 1), '--strictPort'], {
    cwd: ROOT,
    env: { ...process.env, CANVCODE_API_TARGET: apiBase },
    stdio: 'ignore',
    detached: true,
  })
  await waitFor(`${apiBase}/api/records?root`)
  await waitFor(`${base}/`)
  mcp = new Client({ name: 'e2e', version: '0.0.0' })
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${apiBase}/mcp`)))
})

test.afterAll(async () => {
  await mcp?.close()
  server?.kill()
  // npm の子（vite）ごと止める
  if (vite?.pid) {
    try {
      process.kill(-vite.pid)
    } catch {
      vite.kill()
    }
  }
  if (workspaceDir) rmSync(workspaceDir, { recursive: true, force: true })
})

type Content = { type: string; text?: string; data?: string }

async function tool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; content: Content[] }> {
  const result = await mcp!.callTool({ name, arguments: args })
  return { isError: result.isError === true, content: result.content as Content[] }
}

async function json(name: string, args: Record<string, unknown>): Promise<any> {
  const result = await tool(name, args)
  expect(result.isError, result.content[0]?.text).toBe(false)
  return JSON.parse(result.content[0]!.text!)
}

// PNG の大きさと、割合で指した位置の色（ブラウザで読む）
async function pngInfo(page: Page, base64: string, points: [number, number][]) {
  return page.evaluate(
    async ({ base64, points }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      const hex = (n: number) => n.toString(16).padStart(2, '0')
      const colors = points.map(([fx, fy]) => {
        const [r, g, b] = ctx.getImageData(Math.floor(bitmap.width * fx), Math.floor(bitmap.height * fy), 1, 1).data
        return `#${hex(r)}${hex(g)}${hex(b)}`
      })
      return { width: bitmap.width, height: bitmap.height, colors }
    },
    { base64, points },
  )
}

const memory = (page: Page) =>
  page.evaluate(() => {
    const m = (window as any).canvcode.memory()
    return { editors: m.editors as number, bytes: m.imageCache.bytes as number }
  })

test('renders nodes the AI placed, and a canvas the tab has not opened, then lets go of what it loaded for it', async ({ page }) => {
  // タブが開いていなければ、ユーザーに開いてもらうよう返す
  const none = await tool('render_canvas', {})
  expect(none.isError).toBe(true)
  expect(none.content[0]!.text).toContain('No CanvCode tab is open')

  await page.goto(`${base}/`)
  await page.waitForFunction(() => Boolean((window as any).canvcode?.view))
  const rootId = await page.evaluate(() => (window as any).canvcode.workspace.rootCanvasId as string)

  // ルートに赤い矩形と、子の Canvas の Portal を置く。子の Canvas に Markdown のカードと青い矩形を置く
  const placed = await json('edit_canvas', {
    canvas_id: rootId,
    ops: [
      { op: 'create', type: 'geo', as: 'red', shape: 'rect', x: 0, y: 0, w: 300, h: 200, fill: '#e03131', strokeWidth: 0 },
      { op: 'create', type: 'portal', as: 'child', name: '子', x: 600, y: 0 },
    ],
  })
  const childId = placed.canvases.child.canvas as string
  const document = await json('create_document', { kind: 'markdown', title: 'メモ', content: '# 見出し\n\n本文の行' })
  await json('edit_canvas', {
    canvas_id: childId,
    ops: [
      { op: 'create', type: 'card', file: document.document.id, x: 0, y: 0, w: 400 },
      { op: 'create', type: 'geo', shape: 'rect', x: 500, y: 0, w: 200, h: 200, fill: '#1971c2', strokeWidth: 0 },
    ],
  })

  // AI が置いた直後のノードを、そのノードだけで描く（edit_canvas の変更がタブに届いてから描く）
  const red = await tool('render_canvas', { canvas_id: rootId, ids: [placed.created.red] })
  expect(red.isError, red.content[0]?.text).toBe(false)
  expect(red.content[0]!.type).toBe('image')
  const redInfo = JSON.parse(red.content[1]!.text!)
  expect(redInfo).toMatchObject({ canvas: rootId, target: { ids: [placed.created.red] } })
  const redImage = await pngInfo(page, red.content[0]!.data!, [[0.5, 0.5]])
  expect(redImage.colors).toEqual(['#e03131'])
  expect(redImage.width).toBe(redInfo.image.width)

  // タブが開いていない子の Canvas：読んでから描く。カードは本文を読んでから描く（仮の絵にならない）
  const before = await memory(page)
  const child = await tool('render_canvas', { canvas_id: childId, max_edge: 800 })
  expect(child.isError, child.content[0]?.text).toBe(false)
  const childInfo = JSON.parse(child.content[1]!.text!)
  expect(childInfo.target).toEqual({ canvas: true })
  expect(childInfo.notes).toBeUndefined()
  expect(childInfo.image.width).toBe(800)
  // 青い矩形は右の端のほう。カードの見出しのあたりは白ではない（カードの地の色か文字）
  const { x, w } = childInfo.image
  const blueAt = (500 + 100 - x) / w
  const childImage = await pngInfo(page, child.content[0]!.data!, [[blueAt, 0.3]])
  expect(childImage.colors).toEqual(['#1971c2'])
  // 描くためだけに作った Editor と、読んだ画像は手放す
  await expect.poll(() => memory(page)).toEqual(before)

  // スライドの番号が違えば、タブに頼まずに断る
  const wrong = await tool('render_canvas', { canvas_id: rootId, slide: 1 })
  expect(wrong.isError).toBe(true)
  expect(wrong.content[0]!.text).toContain('no numbered slides')

  // タブを閉じると、また描けなくなる
  await page.close()
  await expect.poll(async () => (await tool('render_canvas', { canvas_id: rootId })).content[0]!.text).toContain('No CanvCode tab is open')
})
