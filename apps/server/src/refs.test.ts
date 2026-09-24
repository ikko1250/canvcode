import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RecordStore } from './records.ts'
import { handleRefs } from './refs.ts'

// AI に渡す参照（ref）の保存と取得

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(): Promise<{ base: string; records: RecordStore }> {
  const dir = mkdtempSync(join(tmpdir(), 'canvcode-refs-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const records = new RecordStore(dir)
  cleanups.push(() => records.close())
  const server: Server = createServer((req, res) => {
    void handleRefs(req, res, new URL(req.url ?? '/', 'http://127.0.0.1').pathname, records).then((handled) => {
      if (!handled) res.writeHead(404).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, records }
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
