import { describe, expect, it, vi } from 'vitest'
import { Editor } from './editor.ts'
import { CanvasView } from './view.ts'

// サーバーが文書を作ったあとは、Canvas を移っていても作成先と変換時の警告を知らせる。
describe('attachment conversion completion', () => {
  it.each(['conversion', 'table'] as const)('reports completed files and warnings after leaving the canvas during %s', async (phase) => {
    const editor = new Editor()
    const node = editor.makeNode('attachment', { x: 0, y: 0, props: { name: 'data.xlsx', assetId: 'asset:test' } })
    editor.createNodes([node])
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const pause = async () => { entered(); await waiting }
    const notify = vi.fn()
    const view = Object.create(CanvasView.prototype) as CanvasView
    Object.assign(view, {
      editorRef: editor,
      assets: { whenUploaded: async () => {} },
      options: { notify },
      files: {
        convert: async () => {
          if (phase === 'conversion') await pause()
          return { files: [{ id: 'file:converted', kind: 'table', path: 'data.csv' }], warnings: ['シート「空」は空なので、表にしませんでした'] }
        },
        text: async () => { if (phase === 'table') await pause(); return 'x\n' },
      },
    })
    const pending = view.convertAttachment(node.id, 'table')
    await started
    Object.assign(view, { editorRef: new Editor() })
    release()
    expect(await pending).toEqual([])
    const message = notify.mock.calls.at(-1)![0] as string
    expect(message).toContain('data.csv を作りました')
    expect(message).toContain('ファイル一覧から置けます')
    expect(message).toContain('シート「空」は空なので、表にしませんでした')
    expect(editor.index.allIds()).toEqual([node.id])
  })
})
