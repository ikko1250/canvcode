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

describe('table card column kinds (MAI-94)', () => {
  const files = { get: (fileId: string) => (fileId === 'file:1' ? { text: CSV, version: 'v1', path: '売上.csv', kind: 'table' as const } : null) }
  const type = createTableCardType({ files })
  // 列 col の上の点（見出しの行）の列の情報
  const columnOf = (node: NodeRecord<TableCardProps>, col: number) => {
    for (let x = 0; x < node.props.w; x += 2) {
      const info = type.columnAt(node, { x, y: 36 + 14 })
      if (info?.col === col) return info
    }
    return null
  }

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
})
