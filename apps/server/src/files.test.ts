import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileStore } from './files.ts'

// Markdown の相対パスの画像を返す口（/api/workspace/<パス>）

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'canvcode-files-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function serve(workspace: string): Promise<string> {
  const store = new FileStore(workspace, join(workspace, '.canvcode'), () => {})
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    void store.handle(req, res, url.pathname).then((handled) => {
      if (!handled) res.writeHead(418).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => server.close())
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('GET /api/workspace/<path>', () => {
  it('returns images inside the workspace with their content type', async () => {
    const workspace = tempDir()
    mkdirSync(join(workspace, 'notes', '図'), { recursive: true })
    writeFileSync(join(workspace, 'notes', '図', 'a b.png'), 'PNG')
    writeFileSync(join(workspace, 'logo.svg'), '<svg/>')
    const base = await serve(workspace)

    const png = await fetch(`${base}/api/workspace/notes/${encodeURIComponent('図')}/${encodeURIComponent('a b.png')}`)
    expect(png.status).toBe(200)
    expect(png.headers.get('content-type')).toBe('image/png')
    expect(png.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await png.text()).toBe('PNG')

    const svg = await fetch(`${base}/api/workspace/logo.svg`)
    expect(svg.status).toBe(200)
    expect(svg.headers.get('content-security-policy')).toContain('sandbox')

    const etag = png.headers.get('etag')!
    const again = await fetch(`${base}/api/workspace/notes/${encodeURIComponent('図')}/${encodeURIComponent('a b.png')}`, {
      headers: { 'if-none-match': etag },
    })
    expect(again.status).toBe(304)
  })

  it('refuses non-images, missing files, paths outside and symlinks out of the workspace', async () => {
    const outside = tempDir()
    writeFileSync(join(outside, 'secret.png'), 'x')
    const workspace = tempDir()
    writeFileSync(join(workspace, 'a.md'), '# a')
    writeFileSync(join(workspace, '.env'), 'SECRET=1')
    symlinkSync(join(outside, 'secret.png'), join(workspace, 'link.png'))
    const base = await serve(workspace)

    expect((await fetch(`${base}/api/workspace/a.md`)).status).toBe(404)
    expect((await fetch(`${base}/api/workspace/.env`)).status).toBe(404)
    expect((await fetch(`${base}/api/workspace/none.png`)).status).toBe(404)
    expect((await fetch(`${base}/api/workspace/..%2F${encodeURIComponent(outside.split('/').pop()!)}%2Fsecret.png`)).status).toBe(400)
    expect((await fetch(`${base}/api/workspace/link.png`)).status).toBe(403)
    expect((await fetch(`${base}/api/workspace/a.png`, { method: 'POST' })).status).toBe(405)
  })
})

describe('table files (.csv / .tsv)', () => {
  it('finds .csv and .tsv files as tables and creates new tables as .csv', async () => {
    const workspace = tempDir()
    writeFileSync(join(workspace, '売上.csv'), '月,売上\n')
    writeFileSync(join(workspace, 'data.tsv'), 'a\tb\n')
    writeFileSync(join(workspace, 'other.txt'), 'x')
    const store = new FileStore(workspace, join(workspace, '.canvcode'), () => {})
    await store.init()
    cleanups.push(() => void store.close())
    const listed = store.list().map((f) => [f.path, f.kind, f.title]).sort()
    expect(listed).toEqual([['data.tsv', 'table', 'data'], ['売上.csv', 'table', '売上']])
    const created = await store.create('table', '新しい表', 'a,b\n')
    expect(created).toMatchObject({ kind: 'table', path: '新しい表.csv' })
  })
})
