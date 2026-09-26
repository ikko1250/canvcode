import { REF_TTL_MS } from '@canvcode/core'
import type { RecordStore } from './records.ts'
import type { RefImageStore } from './refImages.ts'

// ref の後片付け（MAI-65）。作ってから REF_TTL_MS（3 日）経った ref を、添えた画像と一緒に消す。
// 起動したときと、そのあと 1 時間ごとに走らせる。
// - 画像だけが残っていれば（消している途中で止まった、など）それも消す。ref は画像を受け取る前に保存されるので、
//   受け取っている途中の画像を消すことはない（書きかけの .tmp は list に入らない）
// - 失敗しても投げずに記録だけする

export const REF_SWEEP_INTERVAL_MS = 60 * 60 * 1000

export async function sweepRefs(records: RecordStore, refImages: RefImageStore, now = Date.now()): Promise<void> {
  try {
    const expired = records.deleteRefsOlderThan(now - REF_TTL_MS)
    for (const id of expired) await refImages.remove(id).catch((error) => console.error('failed to remove a ref image', id, error))
    for (const id of await refImages.list()) {
      if (!records.getRef(id)) await refImages.remove(id).catch((error) => console.error('failed to remove a ref image', id, error))
    }
  } catch (error) {
    console.error('failed to sweep refs', error)
  }
}
