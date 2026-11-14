import type { Effort, ModelCatalog, ModelChoice } from './claudeClient.ts'

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

// モデルの系統。選ぶ欄のスライダーの段で、左から軽く速いものの順
export const FAMILIES = ['haiku', 'sonnet', 'opus', 'fable'] as const
export type Family = (typeof FAMILIES)[number]
export const FAMILY_LABELS: Record<Family, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' }

// モデルの系統。名前（opus・claude-opus-4-8 など）か、一覧の表示名から見分ける。どれでもなければ undefined
export function familyOf(catalog: ModelCatalog | undefined, model: string | undefined): Family | undefined {
  if (!model) return undefined
  const label = catalog?.models.find((choice) => choice.value === model)?.label ?? ''
  const text = `${model} ${label}`.toLowerCase()
  return FAMILIES.find((family) => text.includes(family))
}

export interface ModelStop {
  family: Family
  value: string
  label: string
}

// スライダーの段：系統ごとの最新版。Claude Code の一覧は最新版を指す名前（opus など）の行を先に返すので、その行を使い、
// なければ一覧で最初に出てくる同じ系統の行を使う。一覧にない系統（固定の一覧の Fable など）の段は作らない
export function modelStops(catalog: ModelCatalog | undefined): ModelStop[] {
  const models = catalog?.models ?? []
  return FAMILIES.flatMap((family) => {
    const choice = models.find((c) => c.value === family) ?? models.find((c) => familyOf(catalog, c.value) === family)
    return choice ? [{ family, value: choice.value, label: choice.label }] : []
  })
}

// 選んでいるモデルがスライダーのどの段か（古いバージョンなら、その系統の段）。既定なら、既定で動くモデルの系統。
// どの段でもなければ -1
export function modelStopIndex(catalog: ModelCatalog | undefined, stops: readonly ModelStop[], model: string | undefined): number {
  const family = familyOf(catalog, model ?? catalog?.default.value)
  return family ? stops.findIndex((stop) => stop.family === family) : -1
}

// 「Model ›」で開く、全部のバージョンの一覧。スライダーと同じ系統の順にまとめ、系統の中は Claude Code の順（新しいものが先）。
// 系統のわからないものは最後。選んでいるモデルが一覧になければ（前の会話で使った古いモデルなど）足す
export function modelGroups(catalog: ModelCatalog | undefined, model: string | undefined): ModelChoice[][] {
  const models = [...(catalog?.models ?? [])]
  if (model && !models.some((choice) => choice.value === model)) models.push({ value: model, label: model, efforts: [...EFFORTS] })
  const families: (Family | undefined)[] = [...FAMILIES, undefined]
  return families.map((family) => models.filter((choice) => familyOf(catalog, choice.value) === family)).filter((group) => group.length > 0)
}
