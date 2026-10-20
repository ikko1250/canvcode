import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { CompressedFiles, isCompressible, pickEncoding } from './compress.ts'

describe('pickEncoding', () => {
  it('brotli を優先し、なければ gzip', () => {
    expect(pickEncoding('gzip, deflate, br')).toBe('br')
    expect(pickEncoding('gzip, deflate')).toBe('gzip')
    expect(pickEncoding('deflate')).toBeNull()
    expect(pickEncoding(undefined)).toBeNull()
  })

  it('q=0 のものは使わない', () => {
    expect(pickEncoding('br;q=0, gzip;q=0.8')).toBe('gzip')
    expect(pickEncoding('br;q=0, gzip;q=0')).toBeNull()
  })
})

describe('isCompressible', () => {
  it('文字のファイルで、小さすぎないものだけ', () => {
    expect(isCompressible('/dist/assets/index.js', 100_000)).toBe(true)
    expect(isCompressible('/dist/index.html', 2000)).toBe(true)
    expect(isCompressible('/dist/index.html', 500)).toBe(false)
    expect(isCompressible('/dist/assets/font.woff2', 100_000)).toBe(false)
    expect(isCompressible('/dist/assets/logo.png', 100_000)).toBe(false)
  })
})

describe('CompressedFiles', () => {
  let dir = ''
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('圧縮した中身を返し、更新時刻が変わるまで覚えておく', async () => {
    dir = await mkdtemp(join(tmpdir(), 'compress-'))
    const path = join(dir, 'a.js')
    const text = 'console.log("こんにちは");\n'.repeat(500)
    await writeFile(path, text)
    const files = new CompressedFiles()
    const br = await files.get(path, 1, 'br')
    expect(brotliDecompressSync(br).toString()).toBe(text)
    expect(br.length).toBeLessThan(text.length / 10)
    expect(gunzipSync(await files.get(path, 1, 'gzip')).toString()).toBe(text)
    // 同じ更新時刻なら、ファイルが変わっていても覚えた中身を返す
    await writeFile(path, 'changed')
    expect(await files.get(path, 1, 'br')).toBe(br)
    // 更新時刻が変われば、作り直す
    await utimes(path, new Date(), new Date())
    expect(brotliDecompressSync(await files.get(path, 2, 'br')).toString()).toBe('changed')
  })
  it('warm で、圧縮して効くファイルを前もって圧縮する', async () => {
    dir = await mkdtemp(join(tmpdir(), 'compress-'))
    await writeFile(join(dir, 'a.js'), 'x'.repeat(5000))
    await writeFile(join(dir, 'small.js'), 'x')
    await writeFile(join(dir, 'font.woff2'), 'x'.repeat(5000))
    const files = new CompressedFiles()
    expect(await files.warm(dir)).toBe(1)
  })
})
