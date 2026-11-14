import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelCatalog } from './claudeClient.ts'
import { effortsOf, jobSettingLabel, loadSetting, modelLabel, saveSetting, settingLabel, settingOf, withModel } from './modelChoice.ts'

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
})
