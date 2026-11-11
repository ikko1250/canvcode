import { describe, expect, it } from 'vitest'
import { attachmentExtension, attachmentKind, attachmentUrl, formatFileSize } from './attachment.ts'

// ファイルのカード（MAI-100）の種類・大きさ・原本の URL

describe('attachment card', () => {
  it('tells the kind from the extension', () => {
    expect(attachmentExtension('報告書.DOCX')).toBe('docx')
    expect(attachmentExtension('.bashrc')).toBe('')
    expect(attachmentExtension('README')).toBe('')
    expect(attachmentKind('a.docx').label).toBe('Word 文書')
    expect(attachmentKind('a.xlsx').label).toBe('Excel ブック')
    expect(attachmentKind('a.pptx').label).toBe('PowerPoint')
    expect(attachmentKind('a.zip').label).toBe('圧縮ファイル')
    expect(attachmentKind('a.unknown').label).toBe('ファイル')
  })

  it('formats sizes', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(999)).toBe('999 B')
    expect(formatFileSize(2048)).toBe('2.0 KB')
    expect(formatFileSize(150 * 1024)).toBe('150 KB')
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatFileSize(3 * 1024 ** 3)).toBe('3.0 GB')
  })

  it('makes the URL of the original, with its name', () => {
    const hash = 'a'.repeat(64)
    expect(attachmentUrl({ assetId: `asset:${hash}`, name: 'a b.zip' })).toBe(`/api/assets/${hash}?name=a+b.zip`)
    expect(attachmentUrl({ assetId: `asset:${hash}`, name: 'a.zip' }, { download: true })).toBe(`/api/assets/${hash}?name=a.zip&download=1`)
    expect(attachmentUrl({ assetId: 'asset:../x', name: 'a.zip' })).toBeNull()
  })
})
