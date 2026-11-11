// PDF の上で選んだ語を調べる（o メニューの「単語を調べる」。MAI-99）。
// サーバーの POST /api/claude/lookup（apps/server/src/claude/lookup.ts）が Claude（既定は Haiku）に頼み、
// その文の中での意味（日本語）と、読み方・品詞（あれば）を返す

export interface LookupResult {
  phrase: string
  meaning: string
  reading?: string
  partOfSpeech?: string
  model: string
}

export async function requestLookup(phrase: string, context: string, signal?: AbortSignal): Promise<LookupResult> {
  const response = await fetch('/api/claude/lookup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phrase, context }),
    ...(signal ? { signal } : {}),
  })
  const body = (await response.json().catch(() => null)) as (Partial<LookupResult> & { error?: string }) | null
  if (response.status === 404) throw new Error('このサーバーでは使えません（CANVCODE_CLAUDE=0 か、サーバーを再起動していない）')
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
  if (typeof body?.meaning !== 'string' || !body.meaning) throw new Error('意味が返ってきませんでした')
  return {
    phrase: typeof body.phrase === 'string' ? body.phrase : phrase,
    meaning: body.meaning,
    ...(typeof body.reading === 'string' && body.reading ? { reading: body.reading } : {}),
    ...(typeof body.partOfSpeech === 'string' && body.partOfSpeech ? { partOfSpeech: body.partOfSpeech } : {}),
    model: typeof body.model === 'string' ? body.model : '',
  }
}

// 品詞と読み方の 1 行（「名詞 /ˈkɔːrpəs/」）。どちらもなければ空。
// 読み方は、発音記号だけなら / で囲み、かなだけなら括弧に入れ、ほか（「ステート（/steɪt/）」のように、もう書き方の決まったもの）はそのまま出す
export function lookupHeading(result: Pick<LookupResult, 'reading' | 'partOfSpeech'>): string {
  const reading = result.reading?.trim() ?? ''
  const shown = !reading
    ? ''
    : /^[\u3040-\u30ff\s・]+$/.test(reading)
      ? `（${reading}）`
      : /[/[\]()（）\u3040-\u30ff\u4e00-\u9fff]/.test(reading)
        ? reading
        : `/${reading}/`
  return [result.partOfSpeech ?? '', shown].filter(Boolean).join(' ')
}

// 引用ノートのメモにする文（1 行目に品詞と読み方、そのあとに意味）
export function lookupMemo(result: LookupResult): string {
  const heading = lookupHeading(result)
  return heading ? `${heading}\n${result.meaning}` : result.meaning
}
