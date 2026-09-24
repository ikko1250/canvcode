import { createRefId, unionBoxes, type Box, type CanvasRefTarget, type ReferenceRecord, type RefTarget } from '@canvcode/core'

// AI に見てほしい場所の参照（ref）を作って、サーバーに保存する。DOM を使わない部分だけをここに置く

// Canvas の範囲の参照を作るのに要るもの（Editor の一部）
export interface CanvasRefSource {
  canvasId: string
  selectedIds: ReadonlySet<string>
  // 直前の範囲選択（枠と、そのとき選んだノード）
  lastBrush: { rect: Box; ids: ReadonlySet<string> } | null
  boundsOf(id: string): Box | undefined
  nodesInBrush(rect: Box): string[]
}

// Canvas の範囲の参照。
// - 直前の範囲選択のあと選択を変えていなければ、その枠を範囲にする（ノードのない所も含めて見てほしいことがある）。
//   何もない所を右クリックすると選択は外れるので、選択が空のときも枠を使い、ノードは枠の中から選び直す
// - そうでなければ、選んでいるノードを囲む箱
// どちらもなければ null
export function canvasRefTarget(source: CanvasRefSource): CanvasRefTarget | null {
  const last = source.lastBrush
  const brush = last && (source.selectedIds.size === 0 || sameIds(last.ids, source.selectedIds)) ? last : null
  const ids = source.selectedIds.size > 0 ? [...source.selectedIds] : brush ? source.nodesInBrush(brush.rect) : []
  const nodes = ids.flatMap((id) => {
    const bounds = source.boundsOf(id)
    return bounds ? [{ id, bounds: roundBox(bounds) }] : []
  })
  const rect = brush?.rect ?? unionBoxes(nodes.map((n) => n.bounds))
  if (!rect || (nodes.length === 0 && !brush)) return null
  return { kind: 'canvas', canvasId: source.canvasId, rect: roundBox(rect), nodes }
}

// ref を保存する。ID が重なったら（まずないが）、作り直して 1 回だけ送り直す。保存した ref を返す
export async function postReference(target: RefTarget, id = createRefId(), baseUrl = '/api/refs'): Promise<ReferenceRecord> {
  for (let attempt = 0; ; attempt++) {
    const record = { ...target, typeName: 'ref', id, createdAt: Date.now() } as ReferenceRecord
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(record),
    })
    if (response.ok) return record
    if (response.status === 409 && attempt === 0) {
      id = createRefId()
      continue
    }
    throw new Error(`Failed to save a reference: ${response.status}`)
  }
}

export async function fetchReference(id: string, baseUrl = '/api/refs'): Promise<ReferenceRecord | null> {
  const response = await fetch(`${baseUrl}/${encodeURIComponent(id)}`)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Failed to read a reference: ${response.status}`)
  return (await response.json()) as ReferenceRecord
}

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

// 座標は小数点以下 2 桁で十分（AI に渡す JSON を短くする）
function roundBox(box: Box): Box {
  const r = (n: number) => Math.round(n * 100) / 100
  return { x: r(box.x), y: r(box.y), w: r(box.w), h: r(box.h) }
}
