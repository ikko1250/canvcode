import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REF_TTL_MS } from '@canvcode/core'
import { afterEach, describe, expect, it } from 'vitest'
import { RecordStore } from './records.ts'
import { sweepRefs } from './refCleanup.ts'
import { RefImageStore } from './refImages.ts'

// ref の後片付け（MAI-65）

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.from('IHDR', 'ascii'),
  Buffer.from([0, 0, 0, 100, 0, 0, 0, 50, 8, 6, 0, 0, 0, 0, 0, 0, 0]),
])
const ref = (id: string, createdAt: number) => ({ typeName: 'ref', id, createdAt, kind: 'lines', fileId: 'file:a', startLine: 1, endLine: 1, snapshot: 'a' }) as const

describe('sweepRefs', () => {
  it('deletes expired refs with their images, and images whose ref is gone', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'canvcode-refcleanup-'))
    dirs.push(dataDir)
    const records = new RecordStore(dataDir)
    const refImages = new RefImageStore(dataDir)
    const now = 10 * REF_TTL_MS
    const region = { x: 0, y: 0, w: 100, h: 50 }
    records.putRef(ref('ref:Old0000001', now - REF_TTL_MS - 1))
    records.putRef(ref('ref:New0000001', now - REF_TTL_MS + 1000))
    await refImages.save('ref:Old0000001', PNG, region)
    await refImages.save('ref:New0000001', PNG, region)
    // ref の無い画像（消している途中で止まった、など）と、受け取っている途中の書きかけ
    await refImages.save('ref:Orphan0001', PNG, region)
    const images = join(dataDir, 'ref-images')
    writeFileSync(join(images, 'ref_New0000002.png.123.456.abc.tmp'), PNG)
    // PDF のテキストは ref のものではない
    mkdirSync(join(dataDir, 'assets'), { recursive: true })
    writeFileSync(join(dataDir, 'assets', 'abc.txt'), 'text')

    await sweepRefs(records, refImages, now)

    expect(records.getRef('ref:Old0000001')).toBeUndefined()
    expect(records.getRef('ref:New0000001')).toBeDefined()
    expect(readdirSync(images).sort()).toEqual(['ref_New0000001.json', 'ref_New0000001.png', 'ref_New0000002.png.123.456.abc.tmp'])
    expect(await refImages.read('ref:New0000001')).not.toBeNull()
    expect(existsSync(join(dataDir, 'assets', 'abc.txt'))).toBe(true)
    records.close()
  })

  it('does nothing when there are no images yet', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'canvcode-refcleanup-'))
    dirs.push(dataDir)
    const records = new RecordStore(dataDir)
    await sweepRefs(records, new RefImageStore(dataDir))
    expect(existsSync(join(dataDir, 'ref-images'))).toBe(false)
    records.close()
  })
})
