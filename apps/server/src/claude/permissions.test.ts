import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { askTool, expandHome, guardTool, preToolUseHook, sessionReadRoots, skillRoots, type Guard } from './permissions.ts'

// 画面から頼んだ Claude Code の許し方

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'canvcode-claude-perm-'))
  dirs.push(root)
  const ws = join(root, 'ws')
  mkdirSync(join(ws, 'notes'), { recursive: true })
  mkdirSync(join(root, 'outside'))
  return ws
}

const guarded = (name: string, input: Record<string, unknown>, guard: Guard | string) => guardTool(name, input, guard) !== null

// Claude Code が自分で書くフォルダ（docs/claude-permissions-plan.md の「ファイルの本当の場所」と同じ形）を、使い捨てのフォルダに作る
function claudeDirs() {
  const ws = workspace()
  const root = join(ws, '..')
  const project = join(root, 'config', 'projects', '-tmp-ws')
  const sid = '5d7adefc-e07b-45bb-a389-f05494a1b990'
  const other = '677b4a07-3c4b-4d8c-b061-6e42fcadea7d'
  const tmpRoot = join(root, 'tmp')
  const results = (id: string) => join(project, id, 'tool-results')
  const tasks = (id: string) => join(tmpRoot, `claude-${process.getuid!()}`, '-tmp-ws', id, 'tasks')
  for (const id of [sid, other]) {
    mkdirSync(results(id), { recursive: true })
    mkdirSync(join(project, id, 'subagents'), { recursive: true })
    mkdirSync(tasks(id), { recursive: true })
    writeFileSync(join(project, `${id}.jsonl`), '')
    writeFileSync(join(results(id), 'b1.txt'), 'big')
    writeFileSync(join(tasks(id), 'b2.output'), 'out')
  }
  const transcript = join(project, `${sid}.jsonl`)
  const guard: Guard = { workspace: ws, readRoots: sessionReadRoots({ session_id: sid, transcript_path: transcript }, tmpRoot) }
  return { ws, project, sid, other, tmpRoot, transcript, results, tasks, guard }
}

describe('guardTool', () => {
  it('leaves the canvcode MCP, Bash and web tools to auto mode, and refuses other MCP servers', () => {
    const ws = workspace()
    expect(guarded('mcp__canvcode__edit_canvas', { ops: [] }, ws)).toBe(false)
    expect(guarded('Bash', { command: 'rm -rf /' }, ws)).toBe(false)
    expect(guarded('WebFetch', { url: 'https://example.com' }, ws)).toBe(false)
    expect(guarded('mcp__other__run', {}, ws)).toBe(true)
  })

  it('reads only inside the workspace (the data folder too)', () => {
    const ws = workspace()
    expect(guarded('Read', { file_path: join(ws, 'notes', 'a.md') }, ws)).toBe(false)
    expect(guarded('Read', { file_path: join(ws, '.canvcode', 'assets', 'x.txt') }, ws)).toBe(false)
    expect(guarded('Grep', { pattern: 'x' }, ws)).toBe(false)
    expect(guarded('Read', { file_path: join(ws, '..', 'outside', 'secret') }, ws)).toBe(true)
    expect(guarded('Glob', { pattern: '*', path: '/etc' }, ws)).toBe(true)
  })

  it('writes only inside the workspace, and not into .canvcode or .claude', () => {
    const ws = workspace()
    expect(guarded('Write', { file_path: join(ws, 'notes', 'new', 'b.md'), content: '' }, ws)).toBe(false)
    expect(guarded('Edit', { file_path: 'notes/a.md' }, ws)).toBe(false)
    expect(guarded('Write', { file_path: join(ws, '.canvcode', 'workspace.db') }, ws)).toBe(true)
    expect(guarded('Write', { file_path: join(ws, '.claude', 'settings.json') }, ws)).toBe(true)
    expect(guarded('Write', { file_path: join(ws, '..', 'outside', 'x') }, ws)).toBe(true)
    expect(guarded('Write', {}, ws)).toBe(true)
  })

  it('treats a symlink that points outside as outside', () => {
    const ws = workspace()
    symlinkSync(join(ws, '..', 'outside'), join(ws, 'link'))
    expect(guarded('Write', { file_path: join(ws, 'link', 'x.md') }, ws)).toBe(true)
    expect(guarded('Read', { file_path: join(ws, 'link', 'x.md') }, ws)).toBe(true)
  })
})

describe('askTool', () => {
  it('asks the user in the panel about Bash that auto mode could not decide, and allows the other listed tools inside the guard', () => {
    const ws = workspace()
    expect(askTool('Bash', { command: 'ls' }, ws).behavior).toBe('ask')
    expect(askTool('Write', { file_path: join(ws, 'a.md') }, ws).behavior).toBe('allow')
    expect(askTool('Write', { file_path: '/etc/passwd' }, ws).behavior).toBe('deny')
    expect(askTool('mcp__canvcode__edit_canvas', {}, ws).behavior).toBe('allow')
    expect(askTool('Agent', { prompt: 'x' }, ws).behavior).toBe('allow')
    expect(askTool('Skill', { skill: 'imozuru' }, ws).behavior).toBe('allow')
    expect(askTool('NotebookEdit', {}, ws).behavior).toBe('deny')
  })

  it('asks about any listed tool that an ask rule forced, by matchedAskRule or by decisionReasonType', () => {
    const ws = workspace()
    const write = { file_path: join(ws, 'a.md') }
    // 型のある印（matchedAskRule）と、実際に届く型にない印（decisionReasonType）の両方
    expect(askTool('Write', write, ws, { matchedAskRule: { source: 'projectSettings', toolName: 'Write' } }).behavior).toBe('ask')
    expect(askTool('Write', write, ws, { decisionReasonType: 'rule' }).behavior).toBe('ask')
    expect(askTool('Write', write, ws, { decisionReasonType: 'workingDir' }).behavior).toBe('allow')
    // 規則があっても、ガードで断るものは尋ねない。使わせないツールも尋ねない
    expect(askTool('Write', { file_path: '/etc/passwd' }, ws, { decisionReasonType: 'rule' }).behavior).toBe('deny')
    expect(askTool('NotebookEdit', {}, ws, { matchedAskRule: { source: 'projectSettings', toolName: 'NotebookEdit' } }).behavior).toBe('deny')
  })
})

describe('reading what Claude Code wrote itself', () => {
  it('reads the big tool results and the background task output of its own session, and nothing of other sessions', () => {
    const { sid, other, results, tasks, guard, project } = claudeDirs()
    expect(guarded('Read', { file_path: join(results(sid), 'b1.txt') }, guard)).toBe(false)
    expect(guarded('Read', { file_path: join(tasks(sid), 'b2.output') }, guard)).toBe(false)
    expect(guarded('Grep', { pattern: 'x', path: tasks(sid) }, guard)).toBe(false)
    expect(guarded('Glob', { pattern: `${results(sid)}/*.txt` }, guard)).toBe(false)
    expect(guarded('Read', { file_path: join(results(other), 'b1.txt') }, guard)).toBe(true)
    expect(guarded('Read', { file_path: join(tasks(other), 'b2.output') }, guard)).toBe(true)
    // 同じ session でも、transcript とサブエージェントの transcript は読ませない
    expect(guarded('Read', { file_path: join(project, `${sid}.jsonl`) }, guard)).toBe(true)
    expect(guarded('Read', { file_path: join(project, sid, 'subagents', 'agent-a.jsonl') }, guard)).toBe(true)
  })

  it('does not write there, and treats a symlink in there that points outside as outside', () => {
    const { ws, sid, results, guard } = claudeDirs()
    expect(guarded('Write', { file_path: join(results(sid), 'new.txt'), content: '' }, guard)).toBe(true)
    expect(guarded('Edit', { file_path: join(results(sid), 'b1.txt') }, guard)).toBe(true)
    symlinkSync(join(ws, '..', 'outside'), join(results(sid), 'link'))
    expect(guarded('Read', { file_path: join(results(sid), 'link', 'secret') }, guard)).toBe(true)
  })

  it("adds no folder when the transcript path does not look like Claude Code's", () => {
    const { sid, tmpRoot, project } = claudeDirs()
    expect(sessionReadRoots({ session_id: sid, transcript_path: join(project, 'other.jsonl') }, tmpRoot)).toEqual([])
    expect(sessionReadRoots({ session_id: sid, transcript_path: `${sid}.jsonl` }, tmpRoot)).toEqual([])
    expect(sessionReadRoots({ session_id: '../x', transcript_path: join(project, '..', 'x.jsonl') }, tmpRoot)).toEqual([])
    expect(sessionReadRoots({}, tmpRoot)).toEqual([])
  })

  it('compares with the real path of the temporary folder', () => {
    const { ws, sid, project, transcript } = claudeDirs()
    // tmpRoot がシンボリックリンクでも、Claude Code が書く実際の場所と合う
    const real = join(ws, '..', 'tmp')
    symlinkSync(real, join(ws, '..', 'tmplink'))
    const guard: Guard = { workspace: ws, readRoots: sessionReadRoots({ session_id: sid, transcript_path: transcript }, join(ws, '..', 'tmplink')) }
    expect(guarded('Read', { file_path: join(real, `claude-${process.getuid!()}`, '-tmp-ws', sid, 'tasks', 'b2.output') }, guard)).toBe(false)
    expect(project).toBeTruthy()
  })

  it('allows those reads in the hook (also inside a subagent), leaves workspace reads to auto mode, and denies the rest', async () => {
    const { ws, sid, results, tmpRoot, transcript } = claudeDirs()
    const denied: string[] = []
    const guards: Guard[] = []
    const hook = preToolUseHook({ workspace: ws, tmpRoot, skillRoots: [] }, (_name, reason) => denied.push(reason), (guard) => guards.push(guard))
    const call = (tool_name: string, tool_input: Record<string, unknown>, extra: Partial<PreToolUseHookInput> = {}) =>
      hook(
        { hook_event_name: 'PreToolUse', session_id: sid, transcript_path: transcript, cwd: ws, tool_name, tool_input, tool_use_id: 't', ...extra },
        't',
        { signal: new AbortController().signal },
      )
    const decision = (output: unknown) => (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision
    expect(decision(await call('Read', { file_path: join(results(sid), 'b1.txt') }))).toBe('allow')
    // サブエージェントの中の呼び出しも、session_id と transcript_path は親のもの
    expect(decision(await call('Read', { file_path: join(results(sid), 'b1.txt') }, { agent_id: 'a1', agent_type: 'general-purpose' }))).toBe('allow')
    expect(decision(await call('Read', { file_path: join(ws, 'notes', 'a.md') }))).toBeUndefined()
    expect(decision(await call('Read', { file_path: '/etc/hostname' }))).toBe('deny')
    expect(decision(await call('Glob', { pattern: '/etc/host*' }))).toBe('deny')
    expect(decision(await call('mcp__canvcode__read_canvas', {}))).toBe('allow')
    expect(denied).toHaveLength(2)
    expect(guards.at(-1)?.readRoots).toEqual(sessionReadRoots({ session_id: sid, transcript_path: transcript }, tmpRoot))
  })
})

describe('skillRoots', () => {
  it('lists the .claude/skills folders from the workspace up to the git root, as Claude Code loads them', () => {
    const base = mkdtempSync(join(tmpdir(), 'canvcode-claude-skills-'))
    dirs.push(base)
    const repo = join(base, 'repo')
    const ws = join(repo, 'ws')
    mkdirSync(join(base, '.claude', 'skills', 'outer'), { recursive: true })
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, '.claude', 'skills', 'imozuru', 'references'), { recursive: true })
    writeFileSync(join(repo, '.claude', 'skills', 'imozuru', 'references', 'canvcode.md'), 'ref')
    mkdirSync(join(ws, '.claude', 'skills', 'own'), { recursive: true })
    const roots = skillRoots(ws)
    expect(roots).toEqual([join(ws, '.claude', 'skills'), join(repo, '.claude', 'skills')])
    const guard: Guard = { workspace: ws, readRoots: roots }
    expect(guarded('Read', { file_path: join(repo, '.claude', 'skills', 'imozuru', 'references', 'canvcode.md') }, guard)).toBe(false)
    expect(guarded('Read', { file_path: join(base, '.claude', 'skills', 'outer', 'SKILL.md') }, guard)).toBe(true)
    expect(guarded('Write', { file_path: join(repo, '.claude', 'skills', 'imozuru', 'x.md') }, guard)).toBe(true)
  })

  it("keeps only the workspace's own skills when there is no git root", () => {
    const base = mkdtempSync(join(tmpdir(), 'canvcode-claude-skills-'))
    dirs.push(base)
    const ws = join(base, 'ws')
    mkdirSync(join(base, '.claude', 'skills', 'outer'), { recursive: true })
    mkdirSync(join(ws, '.claude', 'skills', 'own'), { recursive: true })
    expect(skillRoots(ws)).toEqual([join(ws, '.claude', 'skills')])
    rmSync(join(ws, '.claude'), { recursive: true })
    expect(skillRoots(ws)).toEqual([])
  })
})

describe('Glob patterns', () => {
  it('checks the fixed part of the pattern, not only path (an absolute pattern could list files outside)', () => {
    const ws = workspace()
    expect(guarded('Glob', { pattern: '/etc/host*' }, ws)).toBe(true)
    expect(guarded('Glob', { pattern: '/etc/hosts' }, ws)).toBe(true)
    expect(guarded('Glob', { pattern: '/*' }, ws)).toBe(true)
    expect(guarded('Glob', { pattern: '../outside/*' }, ws)).toBe(true)
    expect(guarded('Glob', { pattern: '../../**', path: join(ws, 'notes') }, ws)).toBe(true)
    expect(guarded('Glob', { pattern: 'notes/**/*.md' }, ws)).toBe(false)
    expect(guarded('Glob', { pattern: '**/*.md' }, ws)).toBe(false)
    expect(guarded('Glob', { pattern: `${ws}/notes/*.md` }, ws)).toBe(false)
    expect(guarded('Glob', { pattern: '*.md', path: join(ws, 'notes') }, ws)).toBe(false)
  })
})

// Claude Code のファイルのツールは ~ をホームフォルダとして扱う。Glob・Grep の path と Glob の pattern には ~ のまま届くので、
// ワークスペースの中の「~」というフォルダとして通していた（Grep で、ホームのファイルの中身が読めた）
describe('the home folder (~)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('treats ~ and ~/ as the home folder, as Claude Code does, in every file tool', () => {
    const ws = workspace()
    expect(guarded('Read', { file_path: '~/.bashrc' }, ws)).toBe(true)
    expect(guarded('Read', { file_path: '~' }, ws)).toBe(true)
    expect(guarded('Write', { file_path: '~/.bashrc', content: '' }, ws)).toBe(true)
    expect(guarded('Edit', { file_path: '~/.bashrc' }, ws)).toBe(true)
    expect(guarded('Grep', { pattern: 'x', path: '~/.cache' }, ws)).toBe(true)
    expect(guarded('Grep', { pattern: 'x', path: '~' }, ws)).toBe(true)
    expect(guarded('Glob', { pattern: '*.txt', path: '~/.cache' }, ws)).toBe(true)
    expect(guarded('Glob', { pattern: '~/.cache/*.txt' }, ws)).toBe(true)
    expect(guarded('Glob', { pattern: '~/*' }, ws)).toBe(true)
    expect(guarded('Glob', { pattern: '~' }, ws)).toBe(true)
    // Claude Code は展開しないが、紛らわしいので外とみなす
    expect(guarded('Read', { file_path: '~root/.bashrc' }, ws)).toBe(true)
    expect(guarded('Write', { file_path: '~\\.bashrc', content: '' }, ws)).toBe(true)
    expect(guarded('Glob', { pattern: '~root/*' }, ws)).toBe(true)
    expect(guarded('Glob', { pattern: '*', path: '~root' }, ws)).toBe(true)
    // Claude Code が展開しない書き方は、ワークスペースからの相対（そのまま）
    expect(guarded('Read', { file_path: '$HOME/.bashrc' }, ws)).toBe(false)
    expect(guarded('Read', { file_path: '${HOME}/.bashrc' }, ws)).toBe(false)
    expect(guarded('Glob', { pattern: '~*.md' }, ws)).toBe(false)
    expect(guarded('Read', { file_path: 'notes/~draft.md' }, ws)).toBe(false)
  })

  it('reads and writes through ~ when the workspace is under the home folder', () => {
    // ~ を置き換えたあとで、いつもの確かめをする（ワークスペースがホームの下なら、~/… でも中）
    const ws = join(homedir(), 'canvcode-test-workspace-that-does-not-exist')
    expect(guarded('Read', { file_path: '~/canvcode-test-workspace-that-does-not-exist/a.md' }, ws)).toBe(false)
    expect(guarded('Write', { file_path: '~/canvcode-test-workspace-that-does-not-exist/a.md', content: '' }, ws)).toBe(false)
    expect(guarded('Write', { file_path: '~/canvcode-test-workspace-that-does-not-exist/.claude/x', content: '' }, ws)).toBe(true)
  })

  it('allows ~ pointing into the folders Claude Code wrote itself (the tool results under the home folder), and nothing else there', async () => {
    // ホームフォルダを使い捨てのフォルダにする（os.homedir() は HOME を読む）
    const home = mkdtempSync(join(tmpdir(), 'canvcode-claude-home-'))
    dirs.push(home)
    vi.stubEnv('HOME', home)
    expect(homedir()).toBe(home)
    const ws = workspace()
    const sid = '5d7adefc-e07b-45bb-a389-f05494a1b990'
    const project = join(home, '.claude', 'projects', '-tmp-ws')
    mkdirSync(join(project, sid, 'tool-results'), { recursive: true })
    mkdirSync(join(project, 'other', 'tool-results'), { recursive: true })
    writeFileSync(join(project, `${sid}.jsonl`), '')
    writeFileSync(join(project, sid, 'tool-results', 'b1.txt'), 'big')
    const transcript = join(project, `${sid}.jsonl`)
    const tmpRoot = join(home, 'tmp')
    const guard: Guard = { workspace: ws, readRoots: sessionReadRoots({ session_id: sid, transcript_path: transcript }, tmpRoot) }
    const results = `~/.claude/projects/-tmp-ws/${sid}/tool-results`
    expect(guarded('Read', { file_path: `${results}/b1.txt` }, guard)).toBe(false)
    expect(guarded('Grep', { pattern: 'big', path: results }, guard)).toBe(false)
    expect(guarded('Glob', { pattern: '*.txt', path: results }, guard)).toBe(false)
    expect(guarded('Glob', { pattern: `${results}/*.txt` }, guard)).toBe(false)
    // 同じホームの、ほかの session・transcript・ほかのファイル
    expect(guarded('Grep', { pattern: 'x', path: '~/.claude/projects/-tmp-ws/other/tool-results' }, guard)).toBe(true)
    expect(guarded('Read', { file_path: `~/.claude/projects/-tmp-ws/${sid}.jsonl` }, guard)).toBe(true)
    expect(guarded('Grep', { pattern: 'x', path: '~/.claude' }, guard)).toBe(true)
    expect(guarded('Write', { file_path: `${results}/new.txt`, content: '' }, guard)).toBe(true)
    // フックも、~ で指した readRoots の中を読むだけなら allow にする
    const hook = preToolUseHook({ workspace: ws, tmpRoot, skillRoots: [] }, () => {})
    const decision = await hook(
      { hook_event_name: 'PreToolUse', session_id: sid, transcript_path: transcript, cwd: ws, tool_name: 'Grep', tool_input: { pattern: 'big', path: results }, tool_use_id: 't' },
      't',
      { signal: new AbortController().signal },
    )
    expect(decision).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })
  })
})

describe('expandHome', () => {
  it('expands only ~ and ~/, as Claude Code does', () => {
    expect(expandHome('~')).toBe(homedir())
    expect(expandHome('~/a/b')).toBe(join(homedir(), 'a', 'b'))
    expect(expandHome('~root/a')).toBeNull()
    expect(expandHome('~\\a')).toBeNull()
    expect(expandHome('$HOME/a')).toBe('$HOME/a')
    expect(expandHome('file:///etc/passwd')).toBe('file:///etc/passwd')
    expect(expandHome('/etc/~')).toBe('/etc/~')
  })
})
