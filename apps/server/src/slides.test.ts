import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { FileStore } from './files.ts'
import { SlidesApi } from './slides.ts'

// スライドデッキの API（画像のパス解決）

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup() {
  const workspace = mkdtempSync(join(tmpdir(), 'canvcode-slides-'))
  cleanups.push(() => rmSync(workspace, { recursive: true, force: true }))
  mkdirSync(join(workspace, 'assets'))
  writeFileSync(join(workspace, 'assets', 'a.png'), Buffer.from('\x89PNG\r\n\x1a\n', 'binary'))
  writeFileSync(join(workspace, 'outside.png'), 'x')
  const files = new FileStore(workspace, join(workspace, '.canvcode'), () => {})
  await files.init()
  cleanups.push(() => files.close())
  const deck = await files.create('slides', 'deck', '# タイトル\n', { extension: '.slide.md' })
  return { api: new SlidesApi(files, workspace, 0), deck }
}

async function get(api: SlidesApi, path: string): Promise<{ status: number; body: Buffer }> {
  const url = new URL(path, 'http://127.0.0.1')
  const req = Object.assign(Readable.from([]), { method: 'GET', headers: {} }) as unknown as IncomingMessage
  let status = 0
  const chunks: Buffer[] = []
  const res = {
    writeHead(code: number) { status = code; return this },
    end(data?: string | Buffer) { if (data) chunks.push(Buffer.from(data)) },
  } as unknown as ServerResponse
  await api.handle(req, res, url.pathname, url.searchParams)
  return { status, body: Buffer.concat(chunks) }
}

describe('SlidesApi asset', () => {
  it('resolves an image relative to the deck, whatever the current directory is', async () => {
    const { api, deck } = await setup()
    const response = await get(api, `/api/slides/${encodeURIComponent(deck.id)}/asset?path=assets/a.png`)
    expect(response.status).toBe(200)
    expect(response.body.subarray(0, 4).toString('binary')).toBe('\x89PNG')
  })

  it('rejects paths outside the workspace', async () => {
    const { api, deck } = await setup()
    for (const path of ['../outside.png', '/etc/passwd.png', 'assets/../../outside.png']) {
      const response = await get(api, `/api/slides/${encodeURIComponent(deck.id)}/asset?path=${encodeURIComponent(path)}`)
      expect(response.status).toBe(400)
    }
  })

  it('reports an unknown deck as 404, not 500', async () => {
    const { api } = await setup()
    const response = await get(api, '/api/slides/file%3Anope/asset?path=assets/a.png')
    expect(response.status).toBe(404)
  })
})
