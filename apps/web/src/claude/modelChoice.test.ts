import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelCatalog } from './claudeClient.ts'
import {
  effortsOf,
  familyOf,
  jobSettingLabel,
  loadSetting,
  modelGroups,
  modelLabel,
  modelStopIndex,
  modelStops,
  saveSetting,
  settingLabel,
  settingOf,
  withModel,
} from './modelChoice.ts'

// Claude のパネルで選ぶモデルと effort（MAI-106）

const catalog: ModelCatalog = {
  models: [
    { value: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'claude-opus-4-6', label: 'Opus 4.6', efforts: ['low', 'medium', 'high', 'max'] },
    { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', efforts: [] },
  ],
  default: { value: 'opus', label: 'Opus 5.5' },
  fromClaude: true,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  }
}

describe('model choice (MAI-106)', () => {
  it('names the model and effort, and the model the default runs', () => {
    expect(settingLabel(catalog, { model: 'opus', effort: 'high' })).toBe('Opus 5.5 · High')
    expect(settingLabel(catalog, { model: 'claude-opus-4-6' })).toBe('Opus 4.6')
    expect(settingLabel(catalog, { effort: 'xhigh' })).toBe('既定（Opus 5.5） · XHigh')
    expect(settingLabel(catalog, {})).toBe('既定（Opus 5.5）')
    // 一覧を読む前・一覧にないモデル
    expect(settingLabel(undefined, {})).toBe('既定')
    expect(modelLabel(catalog, 'claude-old')).toBe('claude-old')
    // 終わった依頼の行には、選んで頼んだものだけを添える
    expect(jobSettingLabel(catalog, {})).toBeUndefined()
    expect(jobSettingLabel(catalog, { model: 'opus', effort: 'max' })).toBe('Opus 5.5 · Max')
    expect(jobSettingLabel(catalog, { effort: 'low' })).toBe('既定 · Low')
  })

  it('offers the efforts of the chosen model, and drops one the new model does not have', () => {
    expect(effortsOf(catalog, 'claude-opus-4-6')).toEqual(['low', 'medium', 'high', 'max'])
    expect(effortsOf(catalog, 'claude-haiku-4-5-20251001')).toEqual([])
    // 既定なら、既定で動くモデルのもの。わからなければ全部
    expect(effortsOf(catalog, undefined)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(effortsOf({ ...catalog, default: {} }, undefined)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(effortsOf(undefined, 'opus')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(withModel(catalog, { model: 'opus', effort: 'xhigh' }, 'claude-opus-4-6')).toEqual({ model: 'claude-opus-4-6' })
    expect(withModel(catalog, { model: 'opus', effort: 'high' }, 'claude-opus-4-6')).toEqual({ model: 'claude-opus-4-6', effort: 'high' })
    expect(withModel(catalog, { model: 'opus', effort: 'high' }, 'claude-haiku-4-5-20251001')).toEqual({ model: 'claude-haiku-4-5-20251001' })
    expect(withModel(catalog, { model: 'opus', effort: 'high' }, undefined)).toEqual({ effort: 'high' })
  })

  it('remembers the last choice in the browser for new threads, and reads a thread without empty values', () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    expect(loadSetting()).toEqual({})
    saveSetting({ model: 'opus', effort: 'high' })
    expect(loadSetting()).toEqual({ model: 'opus', effort: 'high' })
    saveSetting({})
    expect(loadSetting()).toEqual({})
    // 壊れた値・知らない effort は既定として読む
    storage.data.set('canvcode.claude.model', '{"model":3,"effort":"extreme"}')
    expect(loadSetting()).toEqual({})
    storage.data.set('canvcode.claude.model', 'not json')
    expect(loadSetting()).toEqual({})
    // 使えないとき（プライベートブラウズなど）も既定
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    })
    expect(loadSetting()).toEqual({})
    expect(() => saveSetting({ model: 'opus' })).not.toThrow()
    expect(settingOf({ model: '', effort: undefined })).toEqual({})
    expect(settingOf(undefined)).toEqual({})
  })

  // 選ぶ欄のスライダー：Haiku・Sonnet・Opus・Fable のそれぞれの最新版の段と、「Model ›」で開く全部のバージョンの一覧
  describe('slider of model families', () => {
    // Claude Code が返す順（最新版を指す名前の行が先、古いバージョンはあと）
    const full: ModelCatalog = {
      models: [
        { value: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { value: 'fable', label: 'Fable 5.2', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { value: 'sonnet', label: 'Sonnet 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { value: 'haiku', label: 'Haiku 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { value: 'claude-fable-5-1', label: 'Fable 5.1', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', efforts: [] },
        { value: 'claude-opus-4-8', label: 'Opus 4.8', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { value: 'gpt-x', label: 'Other', efforts: [] },
      ],
      default: { value: 'opus', label: 'Opus 5.5' },
      fromClaude: true,
    }

    it('tells the family from the name or the label', () => {
      expect(familyOf(full, 'claude-opus-4-8')).toBe('opus')
      expect(familyOf(full, 'opus[1m]')).toBe('opus')
      expect(familyOf({ ...full, models: [{ value: 'x-1', label: 'Sonnet 9', efforts: [] }] }, 'x-1')).toBe('sonnet')
      expect(familyOf(full, 'gpt-x')).toBeUndefined()
      expect(familyOf(full, undefined)).toBeUndefined()
    })

    it('makes a stop for the latest of each family, from the lightest', () => {
      expect(modelStops(full).map((stop) => stop.value)).toEqual(['haiku', 'sonnet', 'opus', 'fable'])
      // 最新版を指す名前の行がなければ、一覧で最初に出てくる同じ系統の行。ない系統の段は作らない
      const explicit: ModelCatalog = { ...full, models: full.models.filter((choice) => choice.value.startsWith('claude-')) }
      expect(modelStops(explicit).map((stop) => stop.value)).toEqual(['claude-haiku-4-5-20251001', 'claude-opus-4-8', 'claude-fable-5-1'])
      expect(modelStops(undefined)).toEqual([])
    })

    it('puts an older version and the default on the stop of their family', () => {
      const stops = modelStops(full)
      expect(modelStopIndex(full, stops, 'fable')).toBe(3)
      expect(modelStopIndex(full, stops, 'claude-opus-4-8')).toBe(2)
      expect(modelStopIndex(full, stops, 'claude-haiku-4-5-20251001')).toBe(0)
      // 既定なら既定で動くモデルの段。わからなければどの段でもない
      expect(modelStopIndex(full, stops, undefined)).toBe(2)
      expect(modelStopIndex({ ...full, default: {} }, stops, undefined)).toBe(-1)
      expect(modelStopIndex(full, stops, 'gpt-x')).toBe(-1)
    })

    it('lists every version grouped by family, with an unlisted model that is chosen', () => {
      const values = (groups: ReturnType<typeof modelGroups>) => groups.map((group) => group.map((choice) => choice.value))
      expect(values(modelGroups(full, undefined))).toEqual([
        ['haiku', 'claude-haiku-4-5-20251001'],
        ['sonnet'],
        ['opus', 'claude-opus-4-8'],
        ['fable', 'claude-fable-5-1'],
        ['gpt-x'],
      ])
      expect(values(modelGroups(catalog, 'claude-opus-3'))).toEqual([['claude-haiku-4-5-20251001'], ['opus', 'claude-opus-4-6', 'claude-opus-3']])
      expect(modelGroups(undefined, undefined)).toEqual([])
    })
  })
})
