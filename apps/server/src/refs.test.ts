import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RecordStore } from './records.ts'
import { RefImageStore } from './refImages.ts'
import { handleRefs } from './refs.ts'

// AI に渡す参照（ref）の保存と取得

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(): Promise<{ base: string; records: RecordStore; images: RefImageStore }> {
  const dir = mkdtempSync(join(tmpdir(), 'canvcode-refs-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const records = new RecordStore(dir)
  cleanups.push(() => records.close())
  const images = new RefImageStore(dir)
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    void handleRefs(req, res, url.pathname, records, images, url.searchParams).then((handled) => {
      if (!handled) res.writeHead(404).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, records, images }
}

const ref = { typeName: 'ref', id: 'ref:Ab12Cd34Ef', createdAt: 1, kind: 'lines', fileId: 'file:a', startLine: 3, endLine: 4, snapshot: 'x\ny' }
const post = (base: string, body: unknown) =>
  fetch(`${base}/api/refs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('/api/refs', () => {
  it('saves a reference and returns it', async () => {
    const { base, records } = await setup()
    const created = await post(base, ref)
    expect(created.status).toBe(201)
    expect(await created.json()).toEqual({ id: ref.id })
    expect(records.getRef(ref.id)).toEqual(ref)

    const got = await fetch(`${base}/api/refs/${encodeURIComponent(ref.id)}`)
    expect(got.status).toBe(200)
    expect(await got.json()).toEqual(ref)
  })

  it('refuses invalid and duplicate references', async () => {
    const { base } = await setup()
    const invalid = await post(base, { ...ref, startLine: 0 })
    expect(invalid.status).toBe(400)
    expect((await fetch(`${base}/api/refs`, { method: 'POST', body: '{' })).status).toBe(400)
    expect((await post(base, ref)).status).toBe(201)
    expect((await post(base, ref)).status).toBe(409)
  })

  it('returns 404 for an unknown reference and 405 for other methods', async () => {
    const { base } = await setup()
    expect((await fetch(`${base}/api/refs/ref%3AZz99Zz99Zz`)).status).toBe(404)
    expect((await fetch(`${base}/api/refs`)).status).toBe(405)
    expect((await fetch(`${base}/api/refs/ref%3AZz99Zz99Zz`, { method: 'DELETE' })).status).toBe(405)
  })
})

// 幅と高さだけが正しい PNG（中身は読まない）
function fakePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr])
}

describe('/api/refs/<id>/image', () => {
  const url = (base: string, query = 'x=-10&y=20&w=400&h=200') => `${base}/api/refs/${encodeURIComponent(ref.id)}/image?${query}`
  const put = (target: string, body: Buffer, type = 'image/png') => fetch(target, { method: 'PUT', headers: { 'content-type': type }, body: new Uint8Array(body) })

  it('saves the image of a reference with the region it shows, once', async () => {
    const { base, images } = await setup()
    await post(base, ref)
    const png = fakePng(800, 400)
    const saved = await put(url(base), png)
    expect(saved.status).toBe(201)
    expect(await saved.json()).toMatchObject({ x: -10, y: 20, w: 400, h: 200, scale: 2 })
    const stored = await images.read(ref.id)
    expect(stored?.png.equals(png)).toBe(true)
    expect(stored?.info).toMatchObject({ x: -10, y: 20, w: 400, h: 200, scale: 2 })
    expect(Date.parse(stored!.info.capturedAt)).toBeGreaterThan(0)
    // ref と同じく書き換えない
    expect((await put(url(base), fakePng(10, 10))).status).toBe(409)
    await images.remove(ref.id)
    expect(await images.read(ref.id)).toBeNull()
  })

  it('refuses images of unknown references, non-PNG bodies and missing regions', async () => {
    const { base } = await setup()
    expect((await put(url(base), fakePng(10, 10))).status).toBe(404)
    await post(base, ref)
    expect((await put(url(base), fakePng(10, 10), 'image/jpeg')).status).toBe(415)
    expect((await put(url(base), Buffer.from('not a png'))).status).toBe(400)
    expect((await put(url(base, 'x=0&y=0&w=0&h=10'), fakePng(10, 10))).status).toBe(400)
    expect((await put(url(base, 'x=0&y=0'), fakePng(10, 10))).status).toBe(400)
    expect((await fetch(url(base))).status).toBe(405)
  })
})
