import type { ImageRequester, RasterImage } from '@canvcode/nodes'

// 時間のかかる画像のキャッシュと、作り直しの順番待ち（MAI-9、MAI-14、MAI-22）。
// - ノードの型は、描画のたびに「この解像度の画像が欲しい」と頼む。手元にあるいちばん近い解像度のものを返す
// - 足りない画像は順番待ちに入れ、カメラが止まってから 1 枚ずつ作る。動いている間は作らない
// - 作れたら onReady を呼び、シーンを描き直してもらう
// - 中身が変わった（version が違う）ときは、新しいものができるまで古いものを返す
// - 容量はバイト数で数え、上限を超えたら最も長く使われていないものから捨てる
// - Canvas を移るときは trim で、ほかの Canvas の画像を減らす（使った順なので、直前の Canvas のものは残りやすい。MAI-66）

export interface ImageCacheOptions {
  // カメラが止まってから作り始めるまでの時間
  idleDelayMs?: number
  budgetBytes?: number
  onReady: () => void
}

export interface ImageCacheStats {
  entries: number
  bytes: number
  queued: number
  running: boolean
  produced: number
  lastProduceMs: number
}

interface Job {
  key: string
  version: string
  level: number
  produce: () => Promise<RasterImage>
  // 最後に頼まれたフレーム。画面から外れたものは作らない
  frame: number
}

interface Entry {
  version: string
  levels: Map<number, RasterImage>
}

const DEFAULT_IDLE_DELAY_MS = 150
// 上限（MAI-66 で 512 MB から下げた。Canvas を移るときには、さらに trim で減らす）
const DEFAULT_BUDGET_BYTES = 256 * 1024 * 1024

export class ImageCache implements ImageRequester {
  private readonly images = new Map<string, Entry>()
  private readonly jobs = new Map<string, Job>()
  private readonly options: Required<ImageCacheOptions>
  private bytes = 0
  private frame = 0
  private lastMotionAt = -Infinity
  private running = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private produced = 0
  private lastProduceMs = 0
  private disposed = false

  constructor(options: ImageCacheOptions) {
    this.options = {
      idleDelayMs: options.idleDelayMs ?? DEFAULT_IDLE_DELAY_MS,
      budgetBytes: options.budgetBytes ?? DEFAULT_BUDGET_BYTES,
      onReady: options.onReady,
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) clearTimeout(this.timer)
  }

  // 描画の最初に呼ぶ。このフレームで頼まれなかった画像は、画面外とみなして作らない
  beginFrame(): void {
    this.frame++
  }

  // 描画の最後に呼ぶ。足りない画像があれば、作る準備をする
  endFrame(): void {
    this.schedule()
  }

  // カメラが動いたときに呼ぶ。動いている間は画像を作らない
  notifyMotion(now = performance.now()): void {
    this.lastMotionAt = now
  }

  get(key: string, version: string, level: number, produce: () => Promise<RasterImage>): RasterImage | null {
    const entry = this.images.get(key)
    const current = entry?.version === version
    const exact = current ? entry.levels.get(level) : undefined
    if (entry) this.touch(key, entry)
    if (exact) return exact
    const jobKey = `${key}@${level}`
    const job = this.jobs.get(jobKey)
    if (job && job.version === version) job.frame = this.frame
    else this.jobs.set(jobKey, { key, version, level, produce, frame: this.frame })
    if (!entry) return null
    return nearestLevel(entry.levels, level)
  }

  get stats(): ImageCacheStats {
    return {
      entries: this.images.size,
      bytes: this.bytes,
      queued: this.pendingJobs().length,
      running: this.running,
      produced: this.produced,
      lastProduceMs: this.lastProduceMs,
    }
  }

  // 最も長く使われていないものから捨てて、maxBytes 以下にする（Canvas を移ったときなど。MAI-66）
  trim(maxBytes: number): void {
    this.evict(maxBytes)
  }

  // 作るべき画像がもう残っていないか（ベンチマークで「くっきりするまで」を測るのに使う）
  get idle(): boolean {
    return !this.running && this.pendingJobs().length === 0
  }

  private pendingJobs(): Job[] {
    // 直近のフレームで頼まれたものだけが対象
    return [...this.jobs.values()].filter((job) => job.frame >= this.frame - 1)
  }

  private schedule(): void {
    if (this.running || this.timer !== null || this.disposed) return
    if (this.pendingJobs().length === 0) return
    const wait = this.lastMotionAt + this.options.idleDelayMs - performance.now()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.pump()
    }, Math.max(0, wait))
  }

  private async pump(): Promise<void> {
    if (this.running || this.disposed) return
    // まだ動いているなら、止まるまで待つ
    if (performance.now() - this.lastMotionAt < this.options.idleDelayMs) {
      this.schedule()
      return
    }
    // 画面から外れた（直近で頼まれていない）ものは捨てる
    for (const [jobKey, job] of this.jobs) {
      if (job.frame < this.frame - 1) this.jobs.delete(jobKey)
    }
    const next = this.jobs.entries().next()
    if (next.done) return
    const [jobKey, job] = next.value
    this.jobs.delete(jobKey)
    this.running = true
    const start = performance.now()
    try {
      const image = await job.produce()
      if (this.disposed) return
      this.store(job.key, job.version, image)
      this.produced++
      this.lastProduceMs = performance.now() - start
      this.options.onReady()
    } catch (error) {
      console.error('Failed to produce image', job.key, error)
    } finally {
      this.running = false
    }
    // 次の 1 枚は、次のタスクで作る（その間に描画や入力の処理が入れるようにする）
    this.schedule()
  }

  private store(key: string, version: string, image: RasterImage): void {
    let entry = this.images.get(key)
    if (!entry || entry.version !== version) {
      // 中身が変わったので、古い版の画像はまとめて捨てる
      if (entry) this.release(entry)
      entry = { version, levels: new Map() }
      this.images.set(key, entry)
    }
    const previous = entry.levels.get(image.level)
    if (previous) this.bytes -= sizeOf(previous)
    entry.levels.set(image.level, image)
    this.bytes += sizeOf(image)
    this.touch(key, entry)
    this.evict()
  }

  // Map の順番を「最近使った順」にするため、取り出して入れ直す
  private touch(key: string, entry: Entry): void {
    this.images.delete(key)
    this.images.set(key, entry)
  }

  private release(entry: Entry): void {
    for (const image of entry.levels.values()) {
      this.bytes -= sizeOf(image)
      if (typeof ImageBitmap !== 'undefined' && image.image instanceof ImageBitmap) image.image.close()
    }
  }

  private evict(maxBytes = this.options.budgetBytes): void {
    for (const [key, entry] of this.images) {
      if (this.bytes <= maxBytes) return
      this.release(entry)
      this.images.delete(key)
    }
  }
}

function sizeOf(image: RasterImage): number {
  return image.width * image.height * 4
}

// 手元にある解像度のうち、頼まれたものに最も近いもの。
// 頼まれた解像度以上で最も小さいものを優先し、なければそれより低いうちで最も高いもの
function nearestLevel(levels: Map<number, RasterImage>, level: number): RasterImage | null {
  let above: RasterImage | null = null
  let below: RasterImage | null = null
  for (const image of levels.values()) {
    if (image.level >= level) {
      if (!above || image.level < above.level) above = image
    } else if (!below || image.level > below.level) {
      below = image
    }
  }
  return above ?? below
}
