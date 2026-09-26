import { describe, expect, it } from 'vitest'
import { REF_ID_PATTERN, createRefId, linesOfSelection, normalizeRefId, resolveLines, validateReference } from './refs.ts'

const base = { typeName: 'ref', id: 'ref:Ab12Cd34Ef', createdAt: 1 }

describe('ref ids', () => {
  it('creates ids that match the pattern', () => {
    const id = createRefId()
    expect(id).toMatch(REF_ID_PATTERN)
    expect(id).toHaveLength(14)
    expect(createRefId()).not.toBe(id)
  })

  it('normalizes pasted ids', () => {
    expect(normalizeRefId('ref:Ab12Cd34Ef')).toBe('ref:Ab12Cd34Ef')
    expect(normalizeRefId('  `ref:Ab12Cd34Ef`。 ')).toBe('ref:Ab12Cd34Ef')
    expect(normalizeRefId('Ab12Cd34Ef')).toBe('ref:Ab12Cd34Ef')
    expect(normalizeRefId('ref%3AAb12Cd34Ef')).toBe('ref:Ab12Cd34Ef')
    expect(normalizeRefId('ここを見て ref:Ab12Cd34Ef お願い')).toBe('ref:Ab12Cd34Ef')
    expect(normalizeRefId('please look at something')).toBeNull()
    expect(normalizeRefId('ref:short')).toBeNull()
  })
})

describe('validateReference', () => {
  it('accepts each kind and drops unknown fields', () => {
    const canvas = validateReference({
      ...base,
      kind: 'canvas',
      canvasId: 'canvas:root',
      rect: { x: 0, y: 0, w: 10, h: 10 },
      nodes: [{ id: 'node:a', bounds: { x: 1, y: 1, w: 2, h: 2 }, extra: 1 }],
      extra: true,
    })
    expect(canvas).toEqual({
      ...base,
      kind: 'canvas',
      canvasId: 'canvas:root',
      rect: { x: 0, y: 0, w: 10, h: 10 },
      nodes: [{ id: 'node:a', bounds: { x: 1, y: 1, w: 2, h: 2 } }],
    })
    expect(validateReference({ ...base, kind: 'lines', fileId: 'file:a', startLine: 2, endLine: 3, snapshot: 'x\ny' }).kind).toBe('lines')
    expect(
      validateReference({ ...base, kind: 'pdf', fileId: 'file:p', pageIndex: 0, rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.9 }, text: 'hi' }).kind,
    ).toBe('pdf')
  })

  it('keeps the region of a PDF page on a canvas node, and the figure flag', () => {
    const region = { fileId: 'file:p', pageIndex: 2, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, text: 'hi', figure: true, extra: 1 }
    const canvas = validateReference({
      ...base,
      kind: 'canvas',
      canvasId: 'canvas:root',
      rect: { x: 0, y: 0, w: 10, h: 10 },
      nodes: [{ id: 'node:p', bounds: { x: 0, y: 0, w: 5, h: 5 }, pdf: region }],
    })
    expect(canvas.kind === 'canvas' && canvas.nodes[0]!.pdf).toEqual({ fileId: 'file:p', pageIndex: 2, rect: region.rect, text: 'hi', figure: true })
    const pdf = validateReference({ ...base, kind: 'pdf', fileId: 'file:p', pageIndex: 0, rect: region.rect, text: '', figure: false })
    expect(pdf).not.toHaveProperty('figure')
    expect(validateReference({ ...base, kind: 'pdf', fileId: 'file:p', pageIndex: 0, rect: region.rect, text: '', figure: true })).toMatchObject({
      figure: true,
    })
    expect(() =>
      validateReference({
        ...base,
        kind: 'canvas',
        canvasId: 'canvas:root',
        rect: { x: 0, y: 0, w: 10, h: 10 },
        nodes: [{ id: 'node:p', bounds: { x: 0, y: 0, w: 5, h: 5 }, pdf: { ...region, rect: { x: 0.9, y: 0, w: 0.2, h: 1 } } }],
      }),
    ).toThrow(/nodes\[0\]\.pdf\.rect must be within the page/)
  })

  it('rejects invalid input', () => {
    const lines = { ...base, kind: 'lines', fileId: 'file:a', startLine: 2, endLine: 3, snapshot: '' }
    expect(() => validateReference(null)).toThrow()
    expect(() => validateReference({ ...lines, id: 'node:abc' })).toThrow(/ref id/)
    expect(() => validateReference({ ...lines, typeName: 'node' })).toThrow()
    expect(() => validateReference({ ...lines, kind: 'other' })).toThrow(/kind/)
    expect(() => validateReference({ ...lines, startLine: 0 })).toThrow()
    expect(() => validateReference({ ...lines, endLine: 1 })).toThrow()
    expect(() => validateReference({ ...lines, startLine: Number.NaN })).toThrow()
    expect(() => validateReference({ ...lines, fileId: 'canvas:a' })).toThrow(/fileId/)
    expect(() => validateReference({ ...lines, snapshot: 'x'.repeat(200_001) })).toThrow(/too long/)
    expect(() =>
      validateReference({ ...base, kind: 'pdf', fileId: 'file:p', pageIndex: 0, rect: { x: 0.5, y: 0, w: 0.8, h: 1 }, text: '' }),
    ).toThrow(/within the page/)
    expect(() =>
      validateReference({ ...base, kind: 'canvas', canvasId: 'canvas:a', rect: { x: 0, y: 0, w: -1, h: 1 }, nodes: [] }),
    ).toThrow(/negative/)
  })
})

describe('resolveLines', () => {
  const ref = { startLine: 2, endLine: 3, snapshot: 'b\nc' }

  it('keeps unchanged lines', () => {
    expect(resolveLines('a\nb\nc\nd', ref)).toEqual({ startLine: 2, endLine: 3, text: 'b\nc', status: 'unchanged' })
    expect(resolveLines('a\r\nb\r\nc\r\nd', ref).status).toBe('unchanged')
  })

  it('follows lines that moved', () => {
    expect(resolveLines('x\ny\na\nb\nc\nd', ref)).toEqual({ startLine: 4, endLine: 5, text: 'b\nc', status: 'moved' })
  })

  it('reports lost lines and clamps to the text', () => {
    expect(resolveLines('a\nz', ref)).toEqual({ startLine: 2, endLine: 2, text: 'z', status: 'lost' })
  })
})

describe('linesOfSelection', () => {
  const doc = 'one\ntwo\nthree\nfour'

  it('uses the cursor line for an empty selection', () => {
    expect(linesOfSelection(doc, 5, 5)).toEqual({ startLine: 2, endLine: 2, snapshot: 'two' })
  })

  it('covers every line the selection touches', () => {
    expect(linesOfSelection(doc, 5, 10)).toEqual({ startLine: 2, endLine: 3, snapshot: 'two\nthree' })
    expect(linesOfSelection(doc, 10, 5)).toEqual({ startLine: 2, endLine: 3, snapshot: 'two\nthree' })
  })

  it('does not include the line a whole-line selection ends at', () => {
    expect(linesOfSelection(doc, 4, 14)).toEqual({ startLine: 2, endLine: 3, snapshot: 'two\nthree' })
  })
})
