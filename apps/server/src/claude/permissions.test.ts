import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { askTool, expandHome, guardTool } from './permissions.ts'

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

const guarded = (name: string, input: Record<string, unknown>, ws: string) => guardTool(name, input, ws) !== null

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

  // Claude Code のファイルのツールは ~ をホームフォルダとして扱う。Glob・Grep の path と Glob の pattern には ~ のまま届くので、
  // ワークスペースの中の「~」というフォルダとして通していた（Grep で、ホームのファイルの中身が読めた）
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
    // Claude Code が展開しない書き方は、ワークスペースからの相対（そのまま）
    expect(guarded('Read', { file_path: '$HOME/.bashrc' }, ws)).toBe(false)
    expect(guarded('Read', { file_path: '${HOME}/.bashrc' }, ws)).toBe(false)
    expect(guarded('Glob', { pattern: '~*.md' }, ws)).toBe(false)
    expect(guarded('Read', { file_path: 'notes/~draft.md' }, ws)).toBe(false)
  })

  it('reads and writes through ~ when the home folder is the workspace', () => {
    // ~ を置き換えたあとで、いつもの確かめをする（ワークスペースがホームの下なら、~/… でも中）
    const ws = join(homedir(), 'canvcode-test-workspace-that-does-not-exist')
    expect(guarded('Read', { file_path: '~/canvcode-test-workspace-that-does-not-exist/a.md' }, ws)).toBe(false)
    expect(guarded('Write', { file_path: '~/canvcode-test-workspace-that-does-not-exist/a.md', content: '' }, ws)).toBe(false)
    expect(guarded('Write', { file_path: '~/canvcode-test-workspace-that-does-not-exist/.claude/x', content: '' }, ws)).toBe(true)
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

describe('askTool', () => {
  it('denies Bash that auto mode could not decide (nobody can approve it), and allows the other listed tools inside the guard', () => {
    const ws = workspace()
    expect(askTool('Bash', { command: 'ls' }, ws).behavior).toBe('deny')
    expect(askTool('Write', { file_path: join(ws, 'a.md') }, ws).behavior).toBe('allow')
    expect(askTool('Write', { file_path: '/etc/passwd' }, ws).behavior).toBe('deny')
    expect(askTool('mcp__canvcode__edit_canvas', {}, ws).behavior).toBe('allow')
    expect(askTool('Agent', { prompt: 'x' }, ws).behavior).toBe('allow')
    expect(askTool('Skill', { skill: 'imozuru' }, ws).behavior).toBe('allow')
    expect(askTool('NotebookEdit', {}, ws).behavior).toBe('deny')
  })
})
