import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { createTableCardType, type TableCardProps } from './tableCard.ts'

// 表のカードの列の種類（パイメニューのフィルターの項目を選ぶ。MAI-94）。本文は FileContentSource を差し替えて渡す
const CSV = ['Date,売上,店舗', '2012-01-03,1200,渋谷', '2013-06-01,N/A,新宿', 'N/A,300,池袋'].join('\n')

function card(props: Partial<TableCardProps> = {}): NodeRecord<TableCardProps> {
  return {
    typeName: 'node',
    id: 'node:table',
    type: 'table-card',
    parentId: 'canvas:1',
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a0',
    opacity: 1,
    locked: false,
    props: { fileId: 'file:1', w: 1600, h: 240, sizing: 'auto', role: 'owner', header: true, ...props },
    meta: {},
  }
}

// 本文を差し替えられる File（text・version を変えると、本文を直したのと同じ）
function source(text: string) {
  const content = { text, version: 'v1', path: '売上.csv', kind: 'table' as const }
  return { content, files: { get: (fileId: string) => (fileId === 'file:1' ? content : null) } }
}

describe('table card column kinds (MAI-94)', () => {
  const { content, files } = source(CSV)
  const type = createTableCardType({ files })
  // 列 col の上の点（見出しの行）の列の情報
  const columnOf = (node: NodeRecord<TableCardProps>, col: number) => {
    for (let x = 0; x < node.props.w; x += 2) {
      const info = type.columnAt(node, { x, y: 36 + 14 })
      if (info?.col === col) return info
    }
    return null
  }

  it('reads the kinds again when the text of the file changes', () => {
    const { content, files } = source('値,名前\n1,a\n2,b\n')
    const type = createTableCardType({ files })
    const kindAt = (col: number) => {
      for (let x = 0; x < 1600; x += 2) {
        const info = type.columnAt(card(), { x, y: 36 + 14 })
        if (info?.col === col) return info.kind
      }
      return null
    }
    expect([kindAt(0), kindAt(1)]).toEqual(['number', 'text'])
    content.text = '値,名前\nN/A,2026-01-05\nabc,2026-02-01\n'
    content.version = 'v2'
    expect([kindAt(0), kindAt(1)]).toEqual(['text', 'date'])
  })

  it('tells number, date and text columns apart, ignoring missing marks', () => {
    const node = card()
    expect(columnOf(node, 0)).toMatchObject({ name: 'Date', kind: 'date' })
    expect(columnOf(node, 1)).toMatchObject({ name: '売上', kind: 'number' })
    expect(columnOf(node, 2)).toMatchObject({ name: '店舗', kind: 'text' })
  })

  it('keeps the kind of a column after filtering it down to no rows', () => {
    const node = card({ filters: [{ col: 1, op: 'ge', value: '100000' }, { col: 0, op: 'ge', value: '2100' }] })
    expect(columnOf(node, 1)?.kind).toBe('number')
    expect(columnOf(node, 0)?.kind).toBe('date')
  })

  it('reads the kind with the first row as data when the header is off', () => {
    expect(columnOf(card({ header: false }), 1)).toMatchObject({ name: '列 2', kind: 'text' })
  })

  it('leaves out malformed filters without throwing, and marks no column for them', () => {
    expect(content.version).toBe('v1')
    // 列 0 の幅（絞り込みの印があれば、見出しのセルにその幅が足される）
    const widthOf = (node: NodeRecord<TableCardProps>) => {
      let width = 0
      for (let x = 0; x < node.props.w; x += 0.5) if (type.columnAt(node, { x, y: 36 + 14 })?.col === 0) width += 0.5
      return width
    }
    const plain = card()
    expect(type.getBounds(plain).h).toBe(36 + 4 * 28)
    // 値が数の条件は、値を文字にして使う（2012 年からの 2 行）
    const numberValue = card({ filters: [{ col: 0, op: 'ge', value: 2012 }] as unknown as TableCardProps['filters'] })
    expect(type.getBounds(numberValue).h).toBe(36 + 3 * 28)
    expect(widthOf(numberValue)).toBeGreaterThan(widthOf(plain))
    // 知らない条件・値のない条件・列が文字や負の数の条件は捨てる（行は減らず、印も付かない）
    const broken = card({
      filters: [{ col: 0, op: 'between' }, { col: 0, op: 'contains' }, { col: '0', op: 'notEmpty' }, { col: -1, op: 'empty' }, null] as unknown as TableCardProps['filters'],
    })
    expect(() => type.getBounds(broken)).not.toThrow()
    expect(type.getBounds(broken).h).toBe(36 + 4 * 28)
    expect(widthOf(broken)).toBe(widthOf(plain))
    expect(type.getBounds(card({ filters: 'ge' as unknown as TableCardProps['filters'] })).h).toBe(36 + 4 * 28)
  })
})
