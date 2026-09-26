import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RasterImage } from '@canvcode/nodes'
import { ImageCache } from './imageCache.ts'

function fakeImage(level: number, size = 10): RasterImage {
  return { image: {} as CanvasImageSource, width: size * level, height: size * level, level }
}

describe('ImageCache', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // 1 フレーム分：描画の最初と最後で beginFrame / endFrame を呼び、その間に画像を頼む
  function frame(cache: ImageCache, requests: [string, number][], produce = (level: number) => fakeImage(level)) {
    cache.beginFrame()
    const results = requests.map(([key, level]) => cache.get(key, 'v1', level, async () => produce(level)))
    cache.endFrame()
    return results
  }

  it('produces missing images after the camera stops, and serves the nearest level meanwhile', async () => {
    const onReady = vi.fn()
    const cache = new ImageCache({ onReady, idleDelayMs: 150 })
    expect(frame(cache, [['a', 1]])).toEqual([null])
    await vi.advanceTimersByTimeAsync(200)
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(frame(cache, [['a', 1]])[0]?.level).toBe(1)

    // 倍率を上げると、作り直すまでは手元の 1 倍の画像を返す
    expect(frame(cache, [['a', 4]])[0]?.level).toBe(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(frame(cache, [['a', 4]])[0]?.level).toBe(4)
    // 下げたときは、手元の高い解像度のもののうち最も低いものを返す
    expect(frame(cache, [['a', 2]])[0]?.level).toBe(4)
  })

  it('loads a level right away, and reuses it', async () => {
    const cache = new ImageCache({ onReady: () => {}, idleDelayMs: 150 })
    const produce = vi.fn(async () => fakeImage(4))
    expect((await cache.load('a', 'v1', 4, produce))?.level).toBe(4)
    expect((await cache.load('a', 'v1', 4, produce))?.level).toBe(4)
    expect(produce).toHaveBeenCalledTimes(1)
    expect(frame(cache, [['a', 4]])[0]?.level).toBe(4)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await cache.load('b', 'v1', 1, async () => Promise.reject(new Error('x')))).toBeNull()
    error.mockRestore()
  })

  it('does not produce while the camera keeps moving', async () => {
    const onReady = vi.fn()
    const cache = new ImageCache({ onReady, idleDelayMs: 150 })
    for (let i = 0; i < 10; i++) {
      cache.notifyMotion(performance.now())
      frame(cache, [['a', 1]])
      await vi.advanceTimersByTimeAsync(16)
    }
    expect(onReady).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('drops requests for images that left the screen', async () => {
    const produced: string[] = []
    const cache = new ImageCache({ onReady: () => {}, idleDelayMs: 0 })
    cache.beginFrame()
    cache.get('offscreen', 'v1', 1, async () => {
      produced.push('offscreen')
      return fakeImage(1)
    })
    cache.endFrame()
    // 次の 2 フレームでは頼まれない（画面から外れた）
    frame(cache, [])
    frame(cache, [['visible', 1]], (level) => {
      produced.push('visible')
      return fakeImage(level)
    })
    await vi.advanceTimersByTimeAsync(50)
    expect(produced).toEqual(['visible'])
    expect(cache.idle).toBe(true)
  })

  it('keeps serving the old version until the new one is ready', async () => {
    const cache = new ImageCache({ onReady: () => {}, idleDelayMs: 0 })
    const get = (version: string) => {
      cache.beginFrame()
      const image = cache.get('card', version, 1, async () => ({ ...fakeImage(1), image: { version } as unknown as CanvasImageSource }))
      cache.endFrame()
      return image
    }
    get('v1')
    await vi.advanceTimersByTimeAsync(10)
    // 中身が変わっても、新しいものができるまでは古い版を返す
    expect((get('v2')!.image as unknown as { version: string }).version).toBe('v1')
    await vi.advanceTimersByTimeAsync(10)
    expect((get('v2')!.image as unknown as { version: string }).version).toBe('v2')
    expect(cache.stats.bytes).toBe(400)
  })

  it('evicts the least recently used images over the budget', async () => {
    // 10×10 の画像は 400 バイト。上限 1000 バイトなら 2 つまで
    const cache = new ImageCache({ onReady: () => {}, idleDelayMs: 0, budgetBytes: 1000 })
    for (const key of ['a', 'b', 'c']) {
      frame(cache, [[key, 1]])
      await vi.advanceTimersByTimeAsync(10)
    }
    expect(cache.stats.entries).toBe(2)
    expect(cache.stats.bytes).toBe(800)
    // 最初の 'a' が捨てられている
    expect(frame(cache, [['a', 1]])).toEqual([null])
  })

  it('trims down to the given size, keeping the most recently used images (MAI-66)', async () => {
    const cache = new ImageCache({ onReady: () => {}, idleDelayMs: 0 })
    for (const key of ['a', 'b', 'c']) {
      frame(cache, [[key, 1]])
      await vi.advanceTimersByTimeAsync(10)
    }
    // 'a' を使い直すと、いちばん古いのは 'b' になる
    frame(cache, [['a', 1]])
    cache.trim(800)
    expect(cache.stats).toMatchObject({ entries: 2, bytes: 800 })
    expect(frame(cache, [['b', 1]])).toEqual([null])
    expect(frame(cache, [['a', 1]])[0]?.level).toBe(1)
    cache.trim(0)
    expect(cache.stats).toMatchObject({ entries: 0, bytes: 0 })
  })
})
