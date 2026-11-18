import { describe, expect, it } from 'vitest'
import type { JobEvent } from './claudeClient.ts'
import { answerOfEvents, groupEvents, groupLabel, runningText, toolKind, type ToolGroup } from './toolGroups.ts'

const tool = (name: string, detail?: string): JobEvent => ({ kind: 'tool', name, ...(detail ? { detail } : {}) })

describe('toolKind', () => {
  it('sorts the tools into read, search, write, run, delegate and other', () => {
    expect(['Read', 'Glob', 'Grep', 'mcp__canvcode__read_canvas', 'mcp__canvcode__list_documents', 'mcp__canvcode__resolve_reference', 'mcp__canvcode__get_canvas_format'].map(toolKind)).toEqual(
      Array(7).fill('read'),
    )
    expect(['WebSearch', 'WebFetch'].map(toolKind)).toEqual(['search', 'search'])
    expect(['Write', 'Edit', 'mcp__canvcode__create_document', 'mcp__canvcode__update_document', 'mcp__canvcode__edit_document', 'mcp__canvcode__edit_canvas', 'mcp__canvcode__undo_canvas_edit'].map(toolKind)).toEqual(
      Array(7).fill('write'),
    )
    expect(toolKind('Bash')).toBe('run')
    expect(toolKind('Agent')).toBe('delegate')
    expect(toolKind('mcp__other__thing')).toBe('other')
  })
})

describe('groupEvents', () => {
  it('folds the events between texts into groups, and keeps texts and errors apart', () => {
    const events: JobEvent[] = [
      tool('Read', 'a.md'),
      tool('mcp__canvcode__read_canvas'),
      { kind: 'text', text: '読みました' },
      tool('WebSearch', 'q'),
      { kind: 'error', message: '失敗' },
      tool('Edit', 'a.md'),
      { kind: 'text', text: '直しました' },
    ]
    const items = groupEvents(events, false)
    expect(items.map((item) => item.kind)).toEqual(['group', 'text', 'group', 'error', 'group', 'text'])
    const first = items[0] as ToolGroup
    expect(first.events).toHaveLength(2)
    expect(groupLabel(first)).toBe('読んだ 2件')
    expect(groupLabel(items[2] as ToolGroup)).toBe('調べた 1件')
    expect(items.every((item) => item.kind !== 'group' || !item.live)).toBe(true)
  })

  it('names the group from the kinds of the tools in reading order and counts what was declined', () => {
    const events: JobEvent[] = [
      tool('WebSearch', 'q'),
      tool('Read', 'a'),
      tool('Bash', 'rm -rf x'),
      { kind: 'denied', name: 'Bash', reason: 'no' },
      tool('Bash', 'make'),
      { kind: 'ask', id: 'p1', name: 'Bash', detail: 'make' },
      { kind: 'answer', id: 'p1', result: 'expired' },
      { kind: 'task', status: 'started', description: '探す' },
    ]
    const [group] = groupEvents(events, false) as [ToolGroup]
    expect(group.kinds).toEqual(['read', 'search', 'run', 'delegate'])
    expect(group.count).toBe(5)
    expect(group.denied).toBe(2)
    expect(groupLabel(group)).toBe('読んだ・調べた・動かした・任せた 5件（2 件は断った）')
  })

  it('counts the questions when the group has no tools', () => {
    const events: JobEvent[] = [
      { kind: 'ask', id: 'q1', name: 'Bash', detail: 'make' },
      { kind: 'answer', id: 'q1', result: 'allowed' },
      { kind: 'ask', id: 'q2', name: 'Bash', detail: 'make clean' },
      { kind: 'answer', id: 'q2', result: 'denied' },
    ]
    expect(groupLabel(groupEvents(events, false)[0] as ToolGroup)).toBe('動かした 2件（1 件は断った）')
  })

  it('names a group of only task notices', () => {
    const [group] = groupEvents([{ kind: 'task', status: 'completed', description: '見張り' }], false) as [ToolGroup]
    expect(groupLabel(group)).toBe('作業 1件')
  })

  it('marks the last group of a running job as live', () => {
    const items = groupEvents([tool('Read'), { kind: 'text', text: 'x' }, tool('mcp__canvcode__edit_canvas')], true)
    expect(items.map((item) => (item.kind === 'group' ? item.live : null))).toEqual([false, null, true])
    // 最後が文章なら、動いていても live なまとまりはない
    expect(groupEvents([tool('Read'), { kind: 'text', text: 'x' }], true).some((item) => item.kind === 'group' && item.live)).toBe(false)
  })
})

describe('runningText', () => {
  it('tells what Claude is doing from the last tool after the last text', () => {
    expect(runningText([], false)).toBe('考えています…')
    expect(runningText([tool('mcp__canvcode__edit_canvas')], false)).toBe('キャンバスを編集しています…')
    expect(runningText([tool('mcp__canvcode__read_canvas')], false)).toBe('キャンバスを読んでいます…')
    expect(runningText([tool('mcp__canvcode__read_document')], false)).toBe('文書を読んでいます…')
    expect(runningText([tool('mcp__canvcode__update_document')], false)).toBe('文書を書いています…')
    expect(runningText([tool('Read')], false)).toBe('ファイルを読んでいます…')
    expect(runningText([tool('Write')], false)).toBe('ファイルを書いています…')
    expect(runningText([tool('WebFetch')], false)).toBe('Web で調べています…')
    expect(runningText([tool('Bash')], false)).toBe('コマンドを実行しています…')
    expect(runningText([tool('Agent')], false)).toBe('サブエージェントに任せています…')
    // 文章のあとは、また考えている
    expect(runningText([tool('Read'), { kind: 'text', text: 'x' }], false)).toBe('考えています…')
    // 許可を待っていれば、それを出す
    expect(runningText([tool('Bash')], true)).toBe('許可を待っています…')
  })
})

describe('answerOfEvents', () => {
  it('joins the texts of the job', () => {
    expect(answerOfEvents([{ kind: 'text', text: 'a\n' }, tool('Read'), { kind: 'text', text: ' b' }])).toBe('a\n\nb')
    expect(answerOfEvents([tool('Read')])).toBe('')
  })
})
