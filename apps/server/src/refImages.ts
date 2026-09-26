import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { REF_ID_PATTERN, type Box } from '@canvcode/core'

// ref に添える画像（MAI-64）。手書き線や画像のある範囲は、座標より画像のほうが AI に読み取りやすいので、
// ブラウザが ID をコピーしたときに範囲を PNG に描いて送ってくる。.canvcode/ref-images/<ref の id>.png に置き、
// 画像のピクセルとワールド座標の対応・撮った時刻は、同じ名前の .json に置く。
// ref は書き換えないので、画像も一度だけ受け付ける。ref は 3 日で消し、そのとき remove で画像も一緒に消す（MAI-65）

export interface RefImageInfo extends Box {
  // 1 ワールド単位あたりのピクセル数
  scale: number
  // 撮った時刻（ISO 8601）。JSON は読み出したときの内容なので、ずれていることが分かるように
  capturedAt: string
}

export const MAX_REF_IMAGE_BYTES = 8 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export class RefImageExistsError extends Error {}

export class RefImageStore {
  private readonly dir: string

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'ref-images')
  }

  // 保存する。region は画像に描いたワールド座標の範囲。PNG でなければ Error、すでにあれば RefImageExistsError
  async save(refId: string, png: Buffer, region: Box, now = new Date()): Promise<RefImageInfo> {
    const base = this.base(refId)
    if (!base) throw new Error('invalid id')
    const width = pngWidth(png)
    if (width === null) throw new Error('not a png')
    if (!(region.w > 0) || !(region.h > 0)) throw new Error('invalid region')
    if (await this.read(refId)) throw new RefImageExistsError(`image already exists: ${refId}`)
    const info: RefImageInfo = { ...region, scale: Math.round((width / region.w) * 1000) / 1000, capturedAt: now.toISOString() }
    await mkdir(this.dir, { recursive: true })
    const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    // PNG を先に置き、.json を置いた時点で「ある」ことにする
    await writeFile(`${base}.png.${suffix}`, png)
    await rename(`${base}.png.${suffix}`, `${base}.png`)
    await writeFile(`${base}.json.${suffix}`, JSON.stringify(info))
    await rename(`${base}.json.${suffix}`, `${base}.json`)
    return info
  }

  async read(refId: string): Promise<{ png: Buffer; info: RefImageInfo } | null> {
    const base = this.base(refId)
    if (!base) return null
    try {
      const info = JSON.parse(await readFile(`${base}.json`, 'utf8')) as RefImageInfo
      return { png: await readFile(`${base}.png`), info }
    } catch {
      return null
    }
  }

  async remove(refId: string): Promise<void> {
    const base = this.base(refId)
    if (!base) return
    await rm(`${base}.json`, { force: true })
    await rm(`${base}.png`, { force: true })
  }

  // 画像のファイルがある ref の id（書きかけの .tmp は数えない）
  async list(): Promise<string[]> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return []
    }
    const ids = new Set<string>()
    for (const name of names) {
      const match = /^ref_([0-9A-Za-z]{8,24})\.(png|json)$/.exec(name)
      if (match) ids.add(`ref:${match[1]}`)
    }
    return [...ids]
  }

  private base(refId: string): string | null {
    return REF_ID_PATTERN.test(refId) ? join(this.dir, refId.replace(':', '_')) : null
  }
}

// PNG の幅（IHDR）。PNG でなければ null
function pngWidth(data: Buffer): number | null {
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE) || data.toString('ascii', 12, 16) !== 'IHDR') return null
  const width = data.readUInt32BE(16)
  return width > 0 ? width : null
}
