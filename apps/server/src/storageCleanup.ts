import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { sweepStaleUploads } from './import/import.ts'

// .canvcode の中の、たまっていくものの片付け。起動したときと、そのあと 1 時間ごとに走らせる（ref の片付けと同じ）。
// - deleted/：ゴミ箱から完全に削除した .md / .py の退避先（files.ts の removeForever）。移してから DELETED_TTL_MS（90 日）経ったものを消す
// - imports/：旧データの取り込みで、ブラウザから送られた本文の一時ファイルが、取り込みの途中で止まって残ったもの（1 日経ったら）。
//   それ以外のファイル（以前に残した .ricbackup）には触れない
// - 失敗しても投げずに記録だけする

export const STORAGE_SWEEP_INTERVAL_MS = 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
export const DELETED_TTL_MS = 90 * DAY_MS

// deleted/ の中で、移してから DELETED_TTL_MS 経ったファイルを消し、消したものの名前を返す。
// 移した時刻は名前の頭（「<ミリ秒>-<元の名前>」）で決める。名前が違う形なら、状態の変更時刻（ctime。名前を変えると更新される）で決める。
// 更新時刻（mtime）は移しても変わらない（元のファイルの最後の編集の時刻のまま）ので使わない。フォルダには触れない
export async function sweepDeletedFiles(dataDir: string, now = Date.now()): Promise<string[]> {
  const dir = join(dataDir, 'deleted')
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const removed: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = join(dir, entry.name)
    try {
      const stamp = /^(\d{10,})-/.exec(entry.name)
      const movedAt = stamp ? Number(stamp[1]) : (await stat(path)).ctimeMs
      if (now - movedAt < DELETED_TTL_MS) continue
      await rm(path, { force: true })
      removed.push(entry.name)
    } catch (error) {
      console.error('failed to remove an old deleted file', entry.name, error)
    }
  }
  return removed
}

let sweeping = false

// まとめて片付ける（重ねて走らせない）
export async function sweepStorage(dataDir: string, now = Date.now()): Promise<void> {
  if (sweeping) return
  sweeping = true
  try {
    const removed = await sweepDeletedFiles(dataDir, now)
    if (removed.length > 0) console.log(`.canvcode/deleted/ の ${removed.length} 個（90 日経ったもの）を消しました`)
    const uploads = await sweepStaleUploads(dataDir, now)
    if (uploads.length > 0) console.log(`.canvcode/imports/ の書きかけの一時ファイル ${uploads.length} 個を消しました`)
  } catch (error) {
    console.error('failed to sweep the storage', error)
  } finally {
    sweeping = false
  }
}
