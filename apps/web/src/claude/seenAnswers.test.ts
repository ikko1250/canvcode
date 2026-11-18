import { describe, expect, it } from 'vitest'
import { KEPT_SEEN, SeenAnswers } from './seenAnswers.ts'

// まだ見ていない答え（ブラウザに覚える）

function memoryStorage() {
  const data = new Map<string, string>()
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) }
}

describe('SeenAnswers', () => {
  it('remembers the answer seen per note, and a newer answer is unseen again; across reloads', () => {
    const storage = memoryStorage()
    const seen = new SeenAnswers(storage)
    let calls = 0
    seen.subscribe(() => calls++)
    expect(seen.isSeen('node:a', 1)).toBe(false)
    const before = seen.getSnapshot()
    seen.mark('node:a', 1)
    seen.mark('node:a', 1)
    expect(calls).toBe(1)
    expect(seen.getSnapshot()).not.toBe(before)
    expect(seen.isSeen('node:a', 1)).toBe(true)
    expect(seen.isSeen('node:a', 2)).toBe(false)
    expect(new SeenAnswers(storage).isSeen('node:a', 1)).toBe(true)
  })

  it('forgets the oldest past KEPT_SEEN, and ignores broken saved data', () => {
    const seen = new SeenAnswers(memoryStorage())
    for (let i = 0; i <= KEPT_SEEN; i++) seen.mark(`node:${i}`, 1)
    expect(seen.isSeen('node:0', 1)).toBe(false)
    expect(seen.isSeen(`node:${KEPT_SEEN}`, 1)).toBe(true)
    const broken = memoryStorage()
    broken.setItem('canvcode.questions.seen', '{')
    expect(new SeenAnswers(broken).isSeen('node:a', 1)).toBe(false)
    expect(new SeenAnswers(null).isSeen('node:a', 1)).toBe(false)
  })
})
