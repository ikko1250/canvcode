import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { HookCallback, PermissionResult } from '@anthropic-ai/claude-agent-sdk'

// 画面から頼んだ Claude Code（claude/jobs.ts）に使わせるツールと、その許し方（docs/claude-permissions-plan.md）。
// - 見せるツールは CLAUDE_TOOLS だけ。MCP は canvcode だけ（strictMcpConfig）
// - サブエージェント（Agent）とスキル（Skill）も使える。その中のツール呼び出しも、下のフック・canUseTool を同じように通る
// - 許すかどうかは Claude Code の auto mode に任せる：分類のモデルが、危ないもの（ワークスペースの外を消す・秘密を送り出すなど）を断り、
//   ほかは許す。分類で決められなかった呼び出しは canUseTool（askTool）に来る。Bash と、ワークスペースの設定の ask の規則で尋ねると
//   決めた呼び出しは、画面でユーザーに尋ねる（claude/jobs.ts）。auto mode が使えないときは、Bash の呼び出しがみなそうなる
// - それとは別に、ファイルのツールで読み書きするのはワークスペースの中だけにし、.canvcode/（保存のデータ）と .claude/（Claude Code の設定）
//   には書かせない（guardTool）。auto mode の判定より前に PreToolUse のフックで断るので、分類のモデルが許しても通らない。
//   Bash はこの制限の外（どこを触るかは auto mode の判定に任せる）
// - Claude Code のファイルのツールは、~ と ~/… をホームフォルダとして扱う。Read・Write は展開してからフックに渡すが、
//   Glob・Grep の path と Glob の pattern は ~ のまま届く（ワークスペースの中の「~」というフォルダに見えてしまう）。
//   確かめる前に同じように置き換える（expandHome）
// - 読むだけなら、ワークスペースのほかに次の場所も許す（Guard の readRoots）。どれも、フックで allow にする
//   - その session の大きいツールの結果（<transcript_path から .jsonl を除いたフォルダ>/tool-results/）
//   - その session のバックグラウンドの作業の出力（<CLAUDE_CODE_TMPDIR>/claude-<uid>/<cwd を変換した名前>/<session_id>/tasks/）
//   - Claude Code が読み込むスキルのフォルダ（ワークスペースから git の根までのそれぞれの .claude/skills/）
//   ほかの session のものと、transcript（.jsonl）は読ませない

export const CLAUDE_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'WebSearch', 'WebFetch', 'TodoWrite', 'Agent', 'Skill']

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep'])
const WRITE_TOOLS = new Set(['Write', 'Edit'])
// 書かせないワークスペースの中のフォルダ
const PROTECTED_DIRS = ['.canvcode', '.claude']

export const CANVCODE_MCP_PREFIX = 'mcp__canvcode__'

// ファイルのツールの許す場所。readRoots は、ワークスペースのほかに読むだけなら許すフォルダ（realpath したもの）
export interface Guard {
  workspace: string
  readRoots: readonly string[]
}

// フックが呼び出しごとに Guard を組み立てるための、変わらないもの
export interface GuardSettings {
  workspace: string
  // Claude Code に渡す CLAUDE_CODE_TMPDIR（バックグラウンドの作業の出力の置き場の根）
  tmpRoot: string
  // skillRoots(workspace)
  skillRoots: readonly string[]
}

// どのモードでも断る呼び出しなら、その理由。断らないなら null。guard に文字列を渡すと、ワークスペースだけを許す
export function guardTool(name: string, input: Record<string, unknown>, guard: Guard | string): string | null {
  const { workspace, readRoots } = typeof guard === 'string' ? { workspace: guard, readRoots: [] } : guard
  if (name.startsWith('mcp__') && !name.startsWith(CANVCODE_MCP_PREFIX)) return `CanvCode の画面からは ${name} を使えません`
  if (READ_TOOLS.has(name)) {
    const path = readPath(name, input, workspace)
    if (path === null) return `ワークスペース（${workspace}）の外は読めません：${toolPath(name, input) ?? String(input.pattern)}`
    if (path !== undefined && !inside(workspace, path) && !readRoots.some((root) => inside(root, path))) {
      return `ワークスペース（${workspace}）の外は読めません：${path}`
    }
    return null
  }
  if (WRITE_TOOLS.has(name)) {
    const raw = toolPath(name, input)
    if (raw === undefined) return '書くファイルのパスがありません'
    const path = expandHome(raw)
    if (path === null || !inside(workspace, path)) return `ワークスペース（${workspace}）の外には書けません：${raw}`
    const top = relative(realish(workspace), realish(resolve(workspace, path))).split(/[\\/]/)[0]
    if (PROTECTED_DIRS.includes(top)) return `${top}/ には書けません（CanvCode と Claude Code の設定・データの置き場）`
  }
  return null
}

// PreToolUse のフック。guardTool で断るものを断り、canvcode の MCP と、readRoots の中を読むだけの呼び出しは許す
// （Canvas の編集は画面で元に戻せる。readRoots は Claude Code が自分で書いたものとスキル）。
// ほかは何も決めず、auto mode の判定に任せる。onDeny は断ったことを画面に出すため。onGuard は、組み立てた Guard を覚えておくため
// （canUseTool には session の場所がわかる引数がないので、askTool にはこれを渡す）
export function preToolUseHook(
  settings: GuardSettings,
  onDeny: (name: string, reason: string) => void,
  onGuard?: (guard: Guard) => void,
): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const guard: Guard = { workspace: settings.workspace, readRoots: [...sessionReadRoots(input, settings.tmpRoot), ...settings.skillRoots] }
    onGuard?.(guard)
    const name = input.tool_name
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>
    const reason = guardTool(name, toolInput, guard)
    if (reason) {
      onDeny(name, reason)
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
    }
    if (name.startsWith(CANVCODE_MCP_PREFIX)) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }
    if (READ_TOOLS.has(name)) {
      const path = readPath(name, toolInput, settings.workspace)
      // guardTool を通ったので、ワークスペースの外なら readRoots の中（null は guardTool が断っている）
      if (typeof path === 'string' && !inside(settings.workspace, path)) {
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }
      }
    }
    return {}
  }
}

// askTool の答え。ask は、画面でユーザーに尋ねる（claude/jobs.ts）
export type AskDecision = PermissionResult | { behavior: 'ask' }

// canUseTool の引数のうち、規則で尋ねたことがわかるもの
export interface AskContext {
  // 型のある印：ユーザーが書いた ask の規則（permissions.ask）で尋ねた
  matchedAskRule?: unknown
  // 型にない印（実際に届くのはこちら。docs/claude-permissions-plan.md の「確かめた事実」）
  decisionReasonType?: unknown
}

// 規則（ワークスペースの .claude/settings.json の permissions.ask）で尋ねると決めた呼び出しか。
// matchedAskRule を第一に、decisionReasonType === 'rule' を予備に見る
export function askedByRule(context: AskContext | undefined): boolean {
  return Boolean(context?.matchedAskRule) || context?.decisionReasonType === 'rule'
}

// auto mode の判定で決められず、尋ねられた呼び出し（auto mode が使えないときは、尋ねるべき呼び出しすべて）。
// Bash と、規則で尋ねると決めたものは画面で尋ねる（ask）。guardTool で断るものは尋ねない
export function askTool(name: string, input: Record<string, unknown>, guard: Guard | string, context?: AskContext): AskDecision {
  const reason = guardTool(name, input, guard)
  if (reason) return { behavior: 'deny', message: reason }
  const listed = CLAUDE_TOOLS.includes(name) || name.startsWith(CANVCODE_MCP_PREFIX)
  if (!listed) return { behavior: 'deny', message: `CanvCode の画面からは ${name} を使えません` }
  if (name === 'Bash' || askedByRule(context)) return { behavior: 'ask' }
  return { behavior: 'allow', updatedInput: input }
}

// その session の、Claude Code が自分で書くフォルダ（大きいツールの結果と、バックグラウンドの作業の出力）。
// フックの入力の session_id と transcript_path（<projects>/<cwd を変換した名前>/<session_id>.jsonl）から出す。
// サブエージェントの中の呼び出しでも、この 2 つは親の session のもの（その場所に書く）。形が違えば足さない（断る側に倒れる）
export function sessionReadRoots(session: { session_id?: unknown; transcript_path?: unknown }, tmpRoot: string): string[] {
  const id = session.session_id
  const transcript = session.transcript_path
  if (typeof id !== 'string' || typeof transcript !== 'string' || !/^[A-Za-z0-9-]+$/.test(id)) return []
  if (!isAbsolute(transcript) || basename(transcript) !== `${id}.jsonl`) return []
  const project = dirname(transcript)
  const roots = [join(project, id, 'tool-results')]
  const uid = process.getuid?.()
  if (uid !== undefined) roots.push(join(tmpRoot, `claude-${uid}`, basename(project), id, 'tasks'))
  return roots.map(realish)
}

// Claude Code が読み込むプロジェクトのスキルのフォルダ：ワークスペースから親へたどり、git の根（.git のあるフォルダ）までのそれぞれの
// .claude/skills（あるものを realpath して）。git の根が見つからなければ、ワークスペースのものだけ
export function skillRoots(workspace: string): string[] {
  const own = join(workspace, '.claude', 'skills')
  const found: string[] = []
  let dir = resolve(workspace)
  for (;;) {
    const skills = join(dir, '.claude', 'skills')
    if (existsSync(skills)) found.push(realish(skills))
    if (existsSync(join(dir, '.git'))) return found
    const parent = dirname(dir)
    if (parent === dir) return existsSync(own) ? [realish(own)] : []
    dir = parent
  }
}

// ~ と ~/… を、Claude Code と同じくホームフォルダに置き換える。ほかの書き方（$HOME・${HOME}・file://）は Claude Code も展開しない
// （cwd からの相対になる）ので、そのまま返す。~user/… と ~\… は Claude Code は展開しないが、紛らわしいので外とみなす（null）。
// 本物の CLI（2.1.317）で、Read・Write・Glob・Grep で確かめた（docs/claude-permissions-plan.md）
export function expandHome(path: string): string | null {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  if (path.startsWith('~')) return null
  return path
}

// 読むツールが触る場所。null は ~user/… のように外とみなすもの、undefined は省いた（cwd）。どれも ~ を置き換えたあと。
// Glob は、path（省けばワークスペース）と pattern の固定の部分（ワイルドカードを含む最初の区切りより前）から出す
// （path を省いて pattern を /etc/host* のような絶対パスや ~/… にすると、ワークスペースの外を探せたため）。Grep は path
function readPath(name: string, input: Record<string, unknown>, workspace: string): string | null | undefined {
  if (name !== 'Glob') {
    const path = toolPath(name, input)
    return path === undefined ? undefined : expandHome(path)
  }
  const rawBase = typeof input.path === 'string' && input.path !== '' ? input.path : undefined
  const base = rawBase === undefined ? undefined : expandHome(rawBase)
  if (base === null) return null
  const pattern = typeof input.pattern === 'string' ? input.pattern : ''
  const fixed: string[] = []
  for (const part of pattern.split(/[\\/]/)) {
    if (/[*?[{]/.test(part)) break
    fixed.push(part)
  }
  const prefix = fixed.join('/')
  // ~/… の pattern は、path を省いてもホームフォルダから探す
  if (prefix.startsWith('~')) {
    const home = expandHome(prefix)
    return home === null ? null : resolve(home)
  }
  if (isAbsolute(pattern)) return resolve(prefix || '/')
  if (base === undefined && prefix === '') return undefined
  return resolve(resolve(workspace, base ?? '.'), prefix || '.')
}

// ツールの入力の中の、読み書きするパス（Grep は探す場所。省けば cwd）
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
