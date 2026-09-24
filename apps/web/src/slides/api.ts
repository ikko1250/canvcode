import type { DeckData } from '@canvcode/slides'

export type DeckFormat = 'md' | 'json'
export type DeckSummary = { file: string; format: DeckFormat; mtimeMs: number; size: number; title?: string }
export type DeckResponse = {
  file: string
  format: DeckFormat
  raw: string
  mtimeMs: number
  eol: 'lf' | 'crlf'
  canonical: boolean
  deck?: DeckData
  error?: string
}
export type SaveResponse = { mtimeMs: number; text: string; warnings: string[] }
export type AssetSummary = { name: string; path: string; size: number; mtimeMs: number }
export type ExportResponse = { outputs: string[]; warnings: string[]; elapsedMs: number }

export class ApiError extends Error {
  readonly status: number
  readonly extra: Record<string, unknown>

  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

async function json<T>(method: string, route: string, body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(route, {
      method,
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    })
  } catch {
    throw new ApiError(0, 'CanvCode サーバーに接続できません。')
  }
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    const { error, ...extra } = payload
    throw new ApiError(response.status, typeof error === 'string' ? error : `エラー ${response.status}`, extra)
  }
  return payload as T
}

export const api = {
  listDecks: async () => (await json<{ decks: DeckSummary[] }>('GET', '/api/slides')).decks,
  getDeck: (file: string) => json<DeckResponse>('GET', `/api/slides/${encodeURIComponent(file)}`),
  saveDeck: (file: string, deck: unknown, expectedMtimeMs?: number, force = false) =>
    json<SaveResponse>('PUT', `/api/slides/${encodeURIComponent(file)}`, { deck, expectedMtimeMs, force }),
  createDeck: (file: string) => json<{ file: string; format: DeckFormat; mtimeMs: number }>('POST', '/api/slides', { file }),
  importDeck: (fileName: string, text: string, assets: { sourceName: string; name: string }[] = []) =>
    json<{ file: string; format: DeckFormat; mtimeMs: number }>('POST', '/api/slides/import', { fileName, text, assets }),
  listAssets: async (file: string) => (await json<{ assets: AssetSummary[] }>('GET', `/api/slides/${encodeURIComponent(file)}/assets`)).assets,
  uploadAsset: async (file: string, name: string, data: Blob, overwrite = false) => {
    const extension = name.slice(name.lastIndexOf('.')).toLowerCase()
    const contentType = data.type || ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' } as Record<string, string>)[extension] || 'application/octet-stream'
    const response = await fetch(`/api/slides/${encodeURIComponent(file)}/assets?name=${encodeURIComponent(name)}${overwrite ? '&overwrite=1' : ''}`, {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body: data,
    })
    const result = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) throw new ApiError(response.status, typeof result.error === 'string' ? result.error : `エラー ${response.status}`, result)
    return result as { name: string; path: string; size: number }
  },
  exportDeck: async (file: string, format: 'pdf' | 'png', scale?: number): Promise<ExportResponse> => {
    const response = await fetch(`/api/slides/${encodeURIComponent(file)}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format, scale }),
    })
    if (!response.ok) {
      const result = await response.json().catch(() => ({})) as Record<string, unknown>
      throw new ApiError(response.status, typeof result.error === 'string' ? result.error : `エラー ${response.status}`, result)
    }
    const blob = await response.blob()
    const encodedName = response.headers.get('x-canvcode-export-name')
    const encodedWarnings = response.headers.get('x-canvcode-export-warnings')
    const name = encodedName ? decodeURIComponent(encodedName) : `slides.${format === 'pdf' ? 'pdf' : 'zip'}`
    const warnings = JSON.parse(encodedWarnings ? decodeURIComponent(encodedWarnings) : '[]') as string[]
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
    return { outputs: [name], warnings, elapsedMs: Number(response.headers.get('x-canvcode-export-ms') ?? 0) }
  },
  assetUrl: (file: string, assetPath: string) => `/api/slides/${encodeURIComponent(file)}/asset?path=${encodeURIComponent(assetPath)}`,
}
