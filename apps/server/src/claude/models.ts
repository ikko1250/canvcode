import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EffortLevel, ModelInfo, Options } from '@anthropic-ai/claude-agent-sdk'
import { InputQueue, type RunQuery } from './session.ts'

// 画面の Claude のパネルで選べるモデルと effort（MAI-106）。
// - 一覧は Claude Code に聞く（supportedModels）。プロンプトを送らずに Claude Code を立てて聞くだけなので、API は呼ばない。
//   聞けなければ、opus・sonnet・haiku の 3 つにする
// - SDK の一覧の 'default' の行は Claude Code の組み込みの既定（ワークスペースの設定を見ない）なので出さない。
//   画面の「既定」は、モデルを渡さないこと。そのとき動くモデル（サーバーの CANVCODE_CLAUDE_MODEL か、ワークスペースの
//   .claude/settings.json の model。settingSources が project だけなので settings.local.json は読まれない）を、名前を添えて出す

export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

// モデルの名前として受けるもの（opus・claude-opus-5-5・opus[1m] など）
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/

export function isModelName(value: unknown): value is string {
  return typeof value === 'string' && MODEL_NAME.test(value)
}

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value)
}

export interface ModelChoice {
  // model に渡す名前
  value: string
  // 画面に出す名前（Opus 5.5 など）
  label: string
  description?: string
  // 選べる effort（effort のないモデルなら空）
  efforts: EffortLevel[]
}

export interface ModelCatalog {
  models: ModelChoice[]
  // モデルを渡さないとき（「既定」）に動くモデル。value は設定に書いてある名前（なければ Claude Code の組み込みの既定）、label は画面に出す名前
  default: { value?: string; label?: string }
  // Claude Code に聞けたか（false なら固定の 3 つ）
  fromClaude: boolean
}

export const FALLBACK_MODELS: readonly ModelChoice[] = [
  { value: 'opus', label: 'Opus', efforts: [...EFFORT_LEVELS] },
  { value: 'sonnet', label: 'Sonnet', efforts: [...EFFORT_LEVELS] },
  { value: 'haiku', label: 'Haiku', efforts: [...EFFORT_LEVELS] },
]

export function choicesOf(models: readonly ModelInfo[]): ModelChoice[] {
  return models
    .filter((model) => model.value !== 'default' && isModelName(model.value))
    .map((model) => ({
      value: model.value,
      label: model.displayName || model.value,
      ...(model.description ? { description: model.description } : {}),
      efforts: model.supportsEffort === false ? [] : (model.supportedEffortLevels ?? []).filter(isEffortLevel),
    }))
}

// モデルを渡さないときに使われるモデルの名前：サーバーの CANVCODE_CLAUDE_MODEL、なければワークスペースの .claude/settings.json の model
export function defaultModelValue(workspace: string, serverModel: string | undefined): string | undefined {
  return serverModel || workspaceSettings(workspace).model
}

// ワークスペースの .claude/settings.json の model と effortLevel（読めなければ、ないもの）。
// 動いているプロセスを「既定」に戻すときは、これを明示して渡す（setModel(undefined) や effortLevel: null は、設定ファイルではなく
// Claude Code の組み込みの既定に戻すため）
export function workspaceSettings(workspace: string): { model?: string; effortLevel?: EffortLevel } {
  try {
    const settings = JSON.parse(readFileSync(join(workspace, '.claude', 'settings.json'), 'utf8')) as { model?: unknown; effortLevel?: unknown }
    return {
      ...(typeof settings.model === 'string' && settings.model ? { model: settings.model } : {}),
      ...(isEffortLevel(settings.effortLevel) ? { effortLevel: settings.effortLevel } : {}),
    }
  } catch {
    return {}
  }
}

export function catalogOf(models: readonly ModelInfo[] | undefined, defaultValue: string | undefined): ModelCatalog {
  const choices = models ? choicesOf(models) : [...FALLBACK_MODELS]
  let label: string | undefined
  if (defaultValue) {
    const found = choices.find((choice) => choice.value === defaultValue) ?? choicesOf((models ?? []).filter((model) => model.resolvedModel === defaultValue))[0]
    label = found?.label ?? defaultValue
  } else {
    // 設定がなければ Claude Code の組み込みの既定（'default' の行の説明がモデルの名前）
    label = models?.find((model) => model.value === 'default')?.description
  }
  return { models: choices, default: { ...(defaultValue ? { value: defaultValue } : {}), ...(label ? { label } : {}) }, fromClaude: Boolean(models) }
}

// プロンプトを送らずに Claude Code を立て、使えるモデルの一覧を聞いて閉じる（API は呼ばない）。timeoutMs で諦める
export async function probeModels(run: RunQuery, options: Options, timeoutMs = 30_000): Promise<ModelInfo[]> {
  const abort = new AbortController()
  const input = new InputQueue()
  let timer: NodeJS.Timeout | undefined
  try {
    const query = await run({ prompt: input, options: { ...options, abortController: abort } })
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Claude Code did not answer the list of models in time')), timeoutMs)
    })
    return await Promise.race([query.supportedModels(), timeout])
  } finally {
    clearTimeout(timer)
    input.close()
    abort.abort()
  }
}
