import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decideTool } from './permissions.ts'

// 画面から頼んだ Claude Code に許すツール

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

const behavior = (name: string, input: Record<string, unknown>, ws: string) => decideTool(name, input, ws).behavior

describe('decideTool', () => {
  it('allows the canvcode MCP tools and web tools', () => {
    const ws = workspace()
    expect(behavior('mcp__canvcode__edit_canvas', { ops: [] }, ws)).toBe('allow')
    expect(behavior('WebSearch', { query: 'x' }, ws)).toBe('allow')
    expect(behavior('WebFetch', { url: 'https://example.com' }, ws)).toBe('allow')
  })

  it('denies tools that are not listed, and other MCP servers', () => {
    const ws = workspace()
    expect(behavior('Bash', { command: 'ls' }, ws)).toBe('deny')
    expect(behavior('Agent', {}, ws)).toBe('deny')
    expect(behavior('mcp__other__run', {}, ws)).toBe('deny')
  })

  it('reads only inside the workspace (the data folder too)', () => {
    const ws = workspace()
    expect(behavior('Read', { file_path: join(ws, 'notes', 'a.md') }, ws)).toBe('allow')
    expect(behavior('Read', { file_path: join(ws, '.canvcode', 'assets', 'x.txt') }, ws)).toBe('allow')
    expect(behavior('Grep', { pattern: 'x' }, ws)).toBe('allow')
    expect(behavior('Read', { file_path: join(ws, '..', 'outside', 'secret') }, ws)).toBe('deny')
    expect(behavior('Glob', { pattern: '*', path: '/etc' }, ws)).toBe('deny')
  })

  it('writes only inside the workspace, and not into .canvcode or .claude', () => {
    const ws = workspace()
    expect(behavior('Write', { file_path: join(ws, 'notes', 'new', 'b.md'), content: '' }, ws)).toBe('allow')
    expect(behavior('Edit', { file_path: 'notes/a.md' }, ws)).toBe('allow')
    expect(behavior('Write', { file_path: join(ws, '.canvcode', 'workspace.db') }, ws)).toBe('deny')
    expect(behavior('Write', { file_path: join(ws, '.claude', 'settings.json') }, ws)).toBe('deny')
    expect(behavior('Write', { file_path: join(ws, '..', 'outside', 'x') }, ws)).toBe('deny')
    expect(behavior('Write', {}, ws)).toBe('deny')
  })

  it('treats a symlink that points outside as outside', () => {
    const ws = workspace()
    symlinkSync(join(ws, '..', 'outside'), join(ws, 'link'))
    expect(behavior('Write', { file_path: join(ws, 'link', 'x.md') }, ws)).toBe('deny')
    expect(behavior('Read', { file_path: join(ws, 'link', 'x.md') }, ws)).toBe('deny')
  })
})
