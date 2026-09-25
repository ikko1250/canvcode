import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensurePdfTextFile, pdfTextFile } from './assets.ts'

// PDF から取り出したテキストのファイル（AI に渡す ref に付ける）

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('pdfTextFile', () => {
  it('marks each page and separates pages with a form feed', () => {
    expect(pdfTextFile(['a\nb', 'c\n', ''])).toBe('=== page 1 ===\na\nb\n\f=== page 2 ===\nc\n\f=== page 3 ===\n')
    expect(pdfTextFile([])).toBe('')
  })
})

describe('ensurePdfTextFile', () => {
  function dataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'canvcode-assets-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    mkdirSync(join(dir, 'assets'))
    return dir
  }

  it('writes the file from pages.json once, and keeps an existing one', async () => {
    const dir = dataDir()
    const hash = 'd'.repeat(64)
    writeFileSync(join(dir, 'assets', `${hash}.pages.json`), JSON.stringify({ version: 1, pages: ['x'] }))
    const path = join(dir, 'assets', `${hash}.txt`)
    expect(await ensurePdfTextFile(dir, hash)).toEqual({ path, textless: false })
    expect(readFileSync(path, 'utf8')).toBe('=== page 1 ===\nx\n')
    writeFileSync(path, 'kept')
    await ensurePdfTextFile(dir, hash)
    expect(readFileSync(path, 'utf8')).toBe('kept')
  })

  it('tells when no page has text, and returns null without pages.json or for a bad hash', async () => {
    const dir = dataDir()
    const hash = 'e'.repeat(64)
    writeFileSync(join(dir, 'assets', `${hash}.pages.json`), JSON.stringify({ version: 1, pages: [' ', '\n'] }))
    expect((await ensurePdfTextFile(dir, hash))?.textless).toBe(true)
    expect(await ensurePdfTextFile(dir, 'f'.repeat(64))).toBeNull()
    expect(await ensurePdfTextFile(dir, '../x')).toBeNull()
  })
})
