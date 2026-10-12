import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RefImageStore } from './refImages.ts'
import { writeViaTemp } from './writeAtomic.ts'

// 一時ファイルに書いてから置く。失敗したときに書きかけの .tmp を残さない

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'canvcode-write-'))
  dirs.push(dir)
  return dir
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.from('IHDR', 'ascii'),
  Buffer.from([0, 0, 0, 100, 0, 0, 0, 50, 8, 6, 0, 0, 0, 0, 0, 0, 0]),
])

describe('writeViaTemp', () => {
  it('writes through the temp file and leaves only the target', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'a.txt'), 'old')
    await writeViaTemp(join(dir, 'a.txt.1.tmp'), join(dir, 'a.txt'), 'new')
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('new')
    expect(readdirSync(dir)).toEqual(['a.txt'])
  })

  it('removes the temp file when the rename fails', async () => {
    const dir = tempDir()
    // 置く先が中身のあるフォルダなので、名前の変更が失敗する
    mkdirSync(join(dir, 'a.txt'))
    writeFileSync(join(dir, 'a.txt', 'keep'), 'x')
    await expect(writeViaTemp(join(dir, 'a.txt.1.tmp'), join(dir, 'a.txt'), 'new')).rejects.toThrow()
    expect(readdirSync(dir)).toEqual(['a.txt'])
  })

  it('throws when the temp file cannot be written, without creating anything', async () => {
    const dir = tempDir()
    await expect(writeViaTemp(join(dir, 'missing', 'a.txt.1.tmp'), join(dir, 'missing', 'a.txt'), 'new')).rejects.toThrow()
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('RefImageStore.save', () => {
  it('leaves no temp file in ref-images when saving fails', async () => {
    const dataDir = tempDir()
    const images = join(dataDir, 'ref-images')
    mkdirSync(join(images, 'ref_Fail000001.png'), { recursive: true })
    writeFileSync(join(images, 'ref_Fail000001.png', 'keep'), 'x')
    await expect(new RefImageStore(dataDir).save('ref:Fail000001', PNG, { x: 0, y: 0, w: 100, h: 50 })).rejects.toThrow()
    expect(readdirSync(images)).toEqual(['ref_Fail000001.png'])
  })
})
