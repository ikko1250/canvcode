import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentHost } from './agent/host.ts'
import { editCanvas } from './agent/ops.ts'
import { cleanupButtons, describeButtonCleanup } from './buttonCleanup.ts'
import { RecordStore } from './records.ts'

// 付箋で答えるフレームのボタン（button の型）を消したあとの、保存済みのデータの片付け（起動時に 1 度）

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

// 答えのフレームに似せたワークスペース。フレームの中の図形の 1 つを button の型に書き換え、付箋からその図形へ矢印を引く
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'canvcode-buttons-'))
  const records = new RecordStore(dir)
  cleanups.push(() => {
    records.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const root = records.rootCanvasId
  const host = new AgentHost({ records })
  const made = editCanvas(host, {
    canvasId: root,
    ops: [
      { op: 'create', type: 'frame', as: 'f', x: 0, y: 200, w: 600, h: 400, name: '答え' },
      { op: 'create', type: 'note', as: 'para', text: '段落', x: 20, y: 240, parent: '$f' },
      { op: 'create', type: 'geo', as: 'b', x: 20, y: 500, w: 120, h: 32, parent: '$f' },
      { op: 'create', type: 'note', as: 'q', text: '質問', x: 0, y: 0 },
      { op: 'connect', as: 'a', from: '$q', to: '$b' },
    ],
  }).created as Record<string, string>
  host.dispose()
  const record = records.get(made.b!)!
  records.apply([{ ...record, type: 'button', version: 1, props: { label: 'もっと簡単に', prompt: '', color: '#e7efff', w: 120, sizing: 'auto', hint: true } }], [])
  records.applyAgentOp({ id: 'op:button', canvasId: root, label: 'old', createdAt: 1, patch: [{ id: 'node:gone', before: { ...record, id: 'node:gone', type: 'button' }, after: null }] })
  return { records, made }
}

describe('cleanupButtons', () => {
  it('removes the button nodes the way the browser deletes, keeps the rest, and backs up first', () => {
    const { records, made } = workspace()
    const result = cleanupButtons(records)!
    expect(result).toMatchObject({ removedNodes: 1, removedBindings: 1, removedAgentOps: 1 })
    expect(result.backup).toMatch(/button-removal/)
    expect(records.get(made.b!)).toBeUndefined()
    expect(records.nodeIdsOfTypes(['button'])).toEqual([])
    // 付箋・フレーム・段落の付箋は残る。矢印は、端をその場に固定して残す
    for (const id of [made.f!, made.para!, made.q!, made.a!]) expect(records.get(id)).toBeDefined()
    expect(records.bindingsFrom([made.a!]).map((binding) => (binding as { toId?: string }).toId)).toEqual([made.q])
    expect(describeButtonCleanup(result)).toContain('ノード 1 個')
  })

  it('does nothing the second time', () => {
    const { records } = workspace()
    cleanupButtons(records)
    expect(cleanupButtons(records)).toBeNull()
  })
})
