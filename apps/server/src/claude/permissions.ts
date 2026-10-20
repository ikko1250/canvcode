import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import type { HookCallback, PermissionResult } from '@anthropic-ai/claude-agent-sdk'

// 画面から頼んだ Claude Code（claude/jobs.ts）に使わせるツールと、その許し方。
// - 見せるツールは CLAUDE_TOOLS だけ（サブエージェント・スキルは出さない）。MCP は canvcode だけ（strictMcpConfig）
// - 許すかどうかは Claude Code の auto mode に任せる：分類のモデルが、危ないもの（ワークスペースの外を消す・秘密を送り出すなど）を断り、
//   ほかは許す。分類で決められなかった呼び出しは canUseTool（askTool）に来る。画面で尋ねる仕組みはまだないので、Bash は断る
// - それとは別に、ファイルのツールで読み書きするのはワークスペースの中だけにし、.canvcode/（保存のデータ）と .claude/（Claude Code の設定）
//   には書かせない（guardTool）。auto mode の判定より前に PreToolUse のフックで断るので、分類のモデルが許しても通らない。
//   Bash はこの制限の外（どこを触るかは auto mode の判定に任せる）

export const CLAUDE_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'WebSearch', 'WebFetch', 'TodoWrite']

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep'])
const WRITE_TOOLS = new Set(['Write', 'Edit'])
// 書かせないワークスペースの中のフォルダ
const PROTECTED_DIRS = ['.canvcode', '.claude']

export const CANVCODE_MCP_PREFIX = 'mcp__canvcode__'

// どのモードでも断る呼び出しなら、その理由。断らないなら null
export function guardTool(name: string, input: Record<string, unknown>, workspace: string): string | null {
  if (name.startsWith('mcp__') && !name.startsWith(CANVCODE_MCP_PREFIX)) return `CanvCode の画面からは ${name} を使えません`
  if (READ_TOOLS.has(name)) {
    const path = toolPath(name, input)
    if (path !== undefined && !inside(workspace, path)) return `ワークスペース（${workspace}）の外は読めません：${path}`
    return null
  }
  if (WRITE_TOOLS.has(name)) {
    const path = toolPath(name, input)
    if (path === undefined) return '書くファイルのパスがありません'
    if (!inside(workspace, path)) return `ワークスペース（${workspace}）の外には書けません：${path}`
    const top = relative(realish(workspace), realish(resolve(workspace, path))).split(/[\\/]/)[0]
    if (PROTECTED_DIRS.includes(top)) return `${top}/ には書けません（CanvCode と Claude Code の設定・データの置き場）`
  }
  return null
}

// PreToolUse のフック。guardTool で断るものを断り、canvcode の MCP は許す（Canvas の編集は画面で元に戻せる）。
// ほかは何も決めず、auto mode の判定に任せる。onDeny は断ったことを画面に出すため
export function preToolUseHook(workspace: string, onDeny: (name: string, reason: string) => void): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const name = input.tool_name
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>
    const reason = guardTool(name, toolInput, workspace)
    if (reason) {
      onDeny(name, reason)
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
    }
    if (name.startsWith(CANVCODE_MCP_PREFIX)) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }
    return {}
  }
}

// auto mode の判定で決められず、尋ねられた呼び出し（auto mode が使えないときは、尋ねるべき呼び出しすべて）
export function askTool(name: string, input: Record<string, unknown>, workspace: string): PermissionResult {
  const reason = guardTool(name, input, workspace)
  if (reason) return { behavior: 'deny', message: reason }
  if (name === 'Bash') {
    return {
      behavior: 'deny',
      message: 'このコマンドは自動では許せませんでした（画面から許可する仕組みはまだありません）。ユーザーに、手で実行するよう頼んでください',
    }
  }
  if (CLAUDE_TOOLS.includes(name) || name.startsWith(CANVCODE_MCP_PREFIX)) return { behavior: 'allow', updatedInput: input }
  return { behavior: 'deny', message: `CanvCode の画面からは ${name} を使えません` }
}

// ツールの入力の中の、読み書きするパス（Glob・Grep は探す場所。省けば cwd）
function toolPath(name: string, input: Record<string, unknown>): string | undefined {
  const value = name === 'Glob' || name === 'Grep' ? input.path : input.file_path
  return typeof value === 'string' && value !== '' ? value : undefined
}

// path が dir の中か。シンボリックリンクで外を指していれば外とみなす（まだないファイルは、ある所までの親で確かめる）
export function inside(dir: string, path: string): boolean {
  const rel = relative(realish(dir), realish(resolve(dir, path)))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function realish(path: string): string {
  let current = path
  const rest: string[] = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return path
    rest.unshift(basename(current))
    current = parent
  }
  return resolve(realpathSync(current), ...rest)
}
