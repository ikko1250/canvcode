import type { Effort, ModelCatalog } from './claudeClient.ts'

// Claude のパネルで選ぶモデルと effort（MAI-106）。DOM を使わない部分だけを置く。
// - どちらもなければ既定（サーバーの CANVCODE_CLAUDE_MODEL か、ワークスペースの .claude/settings.json のモデル。effort はモデルの既定）
// - 会話ごとに覚える（サーバーがジョブに残し、会話の一覧で最後の依頼の値を返す）。新しい会話は、ブラウザに覚えた最後に選んだ値から始める

export interface ModelSetting {
  model?: string
  effort?: Effort
}

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const EFFORT_LABELS: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' }

const STORAGE_KEY = 'canvcode.claude.model'

function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value)
}

// 会話（またはジョブ）の値
export function settingOf(source: { model?: string; effort?: Effort } | undefined): ModelSetting {
  return { ...(source?.model ? { model: source.model } : {}), ...(source?.effort ? { effort: source.effort } : {}) }
}

// ブラウザに覚えた、最後に選んだ値（新しい会話の初めの値）。読めなければ既定
export function loadSetting(): ModelSetting {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { model?: unknown; effort?: unknown }
    return { ...(typeof raw.model === 'string' && raw.model ? { model: raw.model } : {}), ...(isEffort(raw.effort) ? { effort: raw.effort } : {}) }
  } catch {
    return {}
  }
}

export function saveSetting(setting: ModelSetting): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settingOf(setting)))
  } catch {
    // 覚えられなくても困らない
  }
}

export function sameSetting(a: ModelSetting, b: ModelSetting): boolean {
  return a.model === b.model && a.effort === b.effort
}

// モデルの名前。既定なら、既定で動くモデルの名前を添える（わからなければ「既定」）
export function modelLabel(catalog: ModelCatalog | undefined, model: string | undefined): string {
  if (model) return catalog?.models.find((choice) => choice.value === model)?.label ?? model
  return catalog?.default.label ? `既定（${catalog.default.label}）` : '既定'
}

// ボタンに出す名前（Opus 5.5 · High）。effort が既定なら、モデルだけ
export function settingLabel(catalog: ModelCatalog | undefined, setting: ModelSetting): string {
  const model = modelLabel(catalog, setting.model)
  return setting.effort ? `${model} · ${EFFORT_LABELS[setting.effort]}` : model
}

// 終わった依頼の行に添える名前。既定のモデル・既定の effort で頼んだものには添えない
export function jobSettingLabel(catalog: ModelCatalog | undefined, job: ModelSetting): string | undefined {
  if (!job.model && !job.effort) return undefined
  const model = job.model ? modelLabel(catalog, job.model) : '既定'
  return job.effort ? `${model} · ${EFFORT_LABELS[job.effort]}` : model
}

// そのモデルで選べる effort。既定なら既定で動くモデルのもの。一覧にないモデルなら全部
export function effortsOf(catalog: ModelCatalog | undefined, model: string | undefined): readonly Effort[] {
  const value = model ?? catalog?.default.value
  const found = value ? catalog?.models.find((choice) => choice.value === value) : undefined
  return found ? found.efforts : EFFORTS
}

// モデルを替える。替えた先で選べない effort は既定に戻す
export function withModel(catalog: ModelCatalog | undefined, setting: ModelSetting, model: string | undefined): ModelSetting {
  const effort = setting.effort && effortsOf(catalog, model).includes(setting.effort) ? setting.effort : undefined
  return settingOf({ model, effort })
}
