import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NodeRecord, WorkspaceRecord } from '@canvcode/core'
import { richTextFromPlain, type TextProps } from '@canvcode/nodes'
import { SyncClient } from './sync.ts'
import { Workspace } from './workspace.ts'

// サーバーから読んだレコード（WebSocket を外して、つながずに最初の読み込みだけを確かめる）

describe('sync', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('upgrades text and notes saved as plain text (version 1) when loading them (MAI-74)', () => {
    vi.stubGlobal('WebSocket', undefined)
    const workspace = new Workspace({ rootCanvasId: 'canvas:root' })
    const base = { typeName: 'node' as const, parentId: 'canvas:root', x: 0, y: 0, rotation: 0, index: 'a0', opacity: 1, locked: false, meta: {} }
    const records: WorkspaceRecord[] = [
      { ...base, id: 'node:text', type: 'text', props: { text: 'a\nb', fontSize: 16, color: '#000000', align: 'left', w: 200, autoWidth: true } },
      { ...base, id: 'node:note', type: 'note', props: { text: 'memo', w: 220, h: 200, color: '#fff3bf', fontSize: 12, align: 'left' } },
    ]
    const sync = new SyncClient(workspace, { rootCanvasId: 'canvas:root', rev: 0, records })
    const text = workspace.store.get('node:text') as NodeRecord<TextProps>
    expect(text.version).toBe(2)
    expect(text.props).toEqual({ paragraphs: richTextFromPlain('a\nb'), fontSize: 16, color: '#000000', align: 'left', w: 200, autoWidth: true })
    expect((workspace.store.get('node:note') as NodeRecord<TextProps>).props.paragraphs).toEqual(richTextFromPlain('memo'))
    // 読み込んだだけでは送り返さない（次に変えたときに新しい版で保存される）
    expect(sync.pending).toBe(false)
    sync.dispose()
  })
})
