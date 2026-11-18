import type { JobEvent } from './claudeClient.ts'

// 会話の欄で、Claude の作業を 1 行にたたむ（docs/claude-chat-tab-plan.md の 2）。DOM を使わない部分だけを置く。
// - 文章（text）と誤り（error）のあいだに続けて並んだ出来事（ツール・断った・作業・許可を求めた・その答え）を 1 つのまとまりにする。
//   誤りは、たたまずに出す
// - まとまりの名前は、中のツールの種類から作る（「読んだ・調べた 4件」）。断ったものがあれば「（1 件は断った）」を添える
// - 動いているジョブの最後のまとまりは live にする（画面は、たたんだ行に加えて、最後の 1 行を出す）
// - 動いている間の文は、最後のツールから作る（「キャンバスを編集しています…」）

// ツールの種類：読んだ・調べた・書いた・動かした・任せた・そのほか
export type ToolKind = 'read' | 'search' | 'write' | 'run' | 'delegate' | 'other'

const KIND_ORDER: readonly ToolKind[] = ['read', 'search', 'write', 'run', 'delegate', 'other']
const KIND_LABELS: Record<ToolKind, string> = {
  read: '読んだ',
  search: '調べた',
  write: '書いた',
  run: '動かした',
  delegate: '任せた',
  other: '使った',
}

// 種類ごとのツール（canvcode の MCP は、mcp__canvcode__ を外した名前）。文書や Canvas を読む MCP は read_*・list_* も読んだに入れる
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Skill', 'resolve_reference', 'get_canvas_format', 'render_canvas'])
const SEARCH_TOOLS = new Set(['WebSearch', 'WebFetch'])
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'create_document', 'update_document', 'edit_document', 'edit_canvas', 'undo_canvas_edit', 'plot_csv'])
const RUN_TOOLS = new Set(['Bash'])
const DELEGATE_TOOLS = new Set(['Agent', 'Task'])
// Canvas を触る MCP（動いている間の文を「キャンバスを…」にする）と、文書を触る MCP
const CANVAS_TOOL = /canvas|nodes|reference|plot/
const DOCUMENT_TOOL = /document/

export function shortToolName(name: string): string {
  return name.replace(/^mcp__canvcode__/, '')
}

export function toolKind(name: string): ToolKind {
  const short = shortToolName(name)
  if (READ_TOOLS.has(short) || /^(read|list)_/.test(short)) return 'read'
  if (SEARCH_TOOLS.has(short)) return 'search'
  if (WRITE_TOOLS.has(short)) return 'write'
  if (RUN_TOOLS.has(short)) return 'run'
  if (DELEGATE_TOOLS.has(short)) return 'delegate'
  return 'other'
}

// 作業のまとまり
export interface ToolGroup {
  kind: 'group'
  events: JobEvent[]
  // 「読んだ・調べた」
  kinds: ToolKind[]
  // 件数（ツールと作業の数。どちらもなければ許可を求めた数、それもなければ出来事の数）
  count: number
  // 断ったもの（auto mode が断った・画面で断った・時間切れ）
  denied: number
  // 動いているジョブの最後のまとまり
  live: boolean
}

export type LogItem = { kind: 'text'; text: string } | { kind: 'error'; message: string } | ToolGroup

// 出来事を、文章・誤り・作業のまとまりに分ける
export function groupEvents(events: readonly JobEvent[], running: boolean): LogItem[] {
  const items: LogItem[] = []
  let current: JobEvent[] = []
  const close = () => {
    if (current.length > 0) items.push(makeGroup(current, false))
    current = []
  }
  for (const event of events) {
    if (event.kind === 'text') {
      close()
      items.push({ kind: 'text', text: event.text })
    } else if (event.kind === 'error') {
      close()
      items.push({ kind: 'error', message: event.message })
    } else {
      current.push(event)
    }
  }
  if (current.length > 0) items.push(makeGroup(current, running))
  return items
}

function makeGroup(events: JobEvent[], live: boolean): ToolGroup {
  const found = new Set<ToolKind>()
  let count = 0
  let asks = 0
  let denied = 0
  for (const event of events) {
    if (event.kind === 'tool') {
      found.add(toolKind(event.name))
      count++
    } else if (event.kind === 'ask') {
      // 許可を求めたツール（ふつうは、その前にツールの出来事もある。サブエージェントの中の呼び出しなどは、これだけ）
      found.add(toolKind(event.name))
      asks++
    } else if (event.kind === 'task') {
      if (event.status === 'started') found.add('delegate')
      count++
    } else if (event.kind === 'denied') {
      denied++
    } else if (event.kind === 'answer' && (event.result === 'denied' || event.result === 'expired')) {
      denied++
    }
  }
  return { kind: 'group', events, kinds: KIND_ORDER.filter((kind) => found.has(kind)), count: count || asks || events.length, denied, live }
}

// まとまりの名前：「読んだ・調べた 4件」「読んだ 2件（1 件は断った）」。種類がなければ（許可を求めただけ・作業の知らせだけ）「作業 N件」
export function groupLabel(group: Pick<ToolGroup, 'kinds' | 'count' | 'denied'>): string {
  const kinds = group.kinds.length > 0 ? group.kinds.map((kind) => KIND_LABELS[kind]).join('・') : '作業'
  return `${kinds} ${group.count}件${group.denied > 0 ? `（${group.denied} 件は断った）` : ''}`
}

// 動いている間の文。許可を待っていれば「許可を待っています…」。最後の文章のあとにツールがあれば、その種類の言い方。なければ「考えています…」
export function runningText(events: readonly JobEvent[], asking: boolean): string {
  if (asking) return '許可を待っています…'
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.kind === 'text') break
    if (event.kind === 'tool') return toolDoing(event.name)
    if (event.kind === 'task' && event.status === 'started') return 'サブエージェントやコマンドに任せています…'
  }
  return '考えています…'
}

function toolDoing(name: string): string {
  const short = shortToolName(name)
  const kind = toolKind(name)
  const mcp = short !== name
  const canvas = mcp && CANVAS_TOOL.test(short)
  const document = mcp && DOCUMENT_TOOL.test(short)
  if (kind === 'write') return canvas ? 'キャンバスを編集しています…' : document ? '文書を書いています…' : 'ファイルを書いています…'
  if (kind === 'read') return canvas ? 'キャンバスを読んでいます…' : document ? '文書を読んでいます…' : 'ファイルを読んでいます…'
  if (kind === 'search') return 'Web で調べています…'
  if (kind === 'run') return 'コマンドを実行しています…'
  if (kind === 'delegate') return 'サブエージェントに任せています…'
  return '作業しています…'
}

// ジョブの答え（そのジョブの文章をつないだもの。Markdown）。文章がなければ空
export function answerOfEvents(events: readonly JobEvent[]): string {
  return events
    .flatMap((event) => (event.kind === 'text' ? [event.text.trim()] : []))
    .filter(Boolean)
    .join('\n\n')
}
