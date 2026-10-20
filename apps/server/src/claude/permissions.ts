import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'

// 画面から頼んだ Claude Code（claude/jobs.ts）に使わせるツールと、その許し方。
// アプリにログインがないので、画面を開ける人なら誰でも頼める。そのため、できることを絞る：
// - 見せるツールは CLAUDE_TOOLS だけ。シェル（Bash）・サブエージェント・スキルは出さない
// - ファイルを読む・探すのはワークスペースの中だけ（ref の textPath がある .canvcode/assets/ も読める）
// - ファイルを書くのはワークスペースの中だけ。.canvcode/（保存のデータ）と .claude/（Claude Code の設定）には書かせない
// - MCP は canvcode だけ（strictMcpConfig で、ほかの設定の MCP は読まない）
// Claude Code は、許すか尋ねるべき呼び出しのときだけ canUseTool を呼ぶ（cwd の中を読むのは尋ねずに許す）。
// 尋ねられたものは decideTool で決め、ここにないツールは断る

export const CLAUDE_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'WebSearch', 'WebFetch', 'TodoWrite']

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep'])
const WRITE_TOOLS = new Set(['Write', 'Edit'])
const FREE_TOOLS = new Set(['WebSearch', 'WebFetch', 'TodoWrite'])
// 書かせないワークスペースの中のフォルダ
const PROTECTED_DIRS = ['.canvcode', '.claude']

export const CANVCODE_MCP_PREFIX = 'mcp__canvcode__'

export function decideTool(name: string, input: Record<string, unknown>, workspace: string): PermissionResult {
  if (name.startsWith(CANVCODE_MCP_PREFIX) || FREE_TOOLS.has(name)) return { behavior: 'allow', updatedInput: input }
  if (READ_TOOLS.has(name)) {
    const path = toolPath(name, input)
    if (path === undefined || inside(workspace, path)) return { behavior: 'allow', updatedInput: input }
    return deny(`ワークスペース（${workspace}）の外は読めません：${path}`)
  }
  if (WRITE_TOOLS.has(name)) {
    const path = toolPath(name, input)
    if (path === undefined) return deny('書くファイルのパスがありません')
    if (!inside(workspace, path)) return deny(`ワークスペース（${workspace}）の外には書けません：${path}`)
    const top = relative(realish(workspace), realish(resolve(workspace, path))).split(/[\\/]/)[0]
    if (PROTECTED_DIRS.includes(top)) return deny(`${top}/ には書けません（CanvCode と Claude Code の設定・データの置き場）`)
    return { behavior: 'allow', updatedInput: input }
  }
  return deny(`CanvCode の画面からは ${name} を使えません`)
}

function deny(message: string): PermissionResult {
  return { behavior: 'deny', message }
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
