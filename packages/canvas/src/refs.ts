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

// ref に添える画像（MAI-64）。手書き線や画像のノードは、JSON の座標より画像のほうが AI に読み取りやすい。
// ID をコピーした時点の見た目を PNG に描いて、ref を保存したあとに送る

// 画像の長い辺の上限。Claude は、長い辺がこれを超える画像を縮めてから読む
export const REF_IMAGE_MAX_EDGE = 1568
// 小さい範囲を大きくしすぎない（ぼやけるだけなので）
const REF_IMAGE_MAX_SCALE = 2

// 画像を添えるかを決めるのに要るもの（Editor の一部）
export interface RefImageSource {
  canvasId: string
  typeOf(id: string): string | undefined
  childrenOf(id: string): readonly string[]
  // 範囲に少しでも触れたノード（グループやフレームの中も含めて）
  search(box: Box): readonly string[]
  // PDF のページのノードのワールド座標。今の Canvas になければ undefined
  pdfPage(fileId: string, pageIndex: number): Box | undefined
}

// ref に添える画像に描く範囲（ワールド座標）。添えないなら null。
// - Canvas の範囲：範囲の中に手書き線か画像のノードがあるとき（選んだグループやフレームの中も含めて）
// - PDF の範囲：今の Canvas にそのページがあり、選んだ範囲に手書き線が重なっているとき
// 文字だけなら添えない（AI に渡すトークンを無駄にしないため）
export function refImageRegion(target: RefTarget, source: RefImageSource): Box | null {
  if (target.kind === 'canvas') {
    if (target.canvasId !== source.canvasId || !(target.rect.w > 0) || !(target.rect.h > 0)) return null
    const ids = [...target.nodes.map((n) => n.id), ...source.search(target.rect)]
    return containsType(ids, source, CANVAS_IMAGE_TYPES) ? target.rect : null
  }
  if (target.kind === 'pdf') {
    const page = source.pdfPage(target.fileId, target.pageIndex)
    if (!page) return null
    const region = {
      x: page.x + target.rect.x * page.w,
      y: page.y + target.rect.y * page.h,
      w: target.rect.w * page.w,
      h: target.rect.h * page.h,
    }
    if (!(region.w > 0) || !(region.h > 0)) return null
    return containsType(source.search(region), source, PDF_IMAGE_TYPES) ? roundBox(region) : null
  }
  return null
}

const CANVAS_IMAGE_TYPES: ReadonlySet<string> = new Set(['draw', 'image'])
const PDF_IMAGE_TYPES: ReadonlySet<string> = new Set(['draw'])

function containsType(ids: Iterable<string>, source: RefImageSource, types: ReadonlySet<string>): boolean {
  const seen = new Set<string>()
  const stack = [...ids]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const type = source.typeOf(id)
    if (type && types.has(type)) return true
    stack.push(...source.childrenOf(id))
  }
  return false
}

// 範囲を描く画像の大きさと、1 ワールド単位あたりのピクセル数
export function refImageSize(region: Box, maxEdge = REF_IMAGE_MAX_EDGE): { width: number; height: number; scale: number } {
  const scale = Math.min(maxEdge / Math.max(region.w, region.h), REF_IMAGE_MAX_SCALE)
  return { width: Math.max(1, Math.round(region.w * scale)), height: Math.max(1, Math.round(region.h * scale)), scale }
}

// 保存した ref に画像を添える。region は画像に描いたワールド座標の範囲
export async function putReferenceImage(id: string, png: Blob, region: Box, baseUrl = '/api/refs'): Promise<void> {
  const query = new URLSearchParams({ x: String(region.x), y: String(region.y), w: String(region.w), h: String(region.h) })
  const response = await fetch(`${baseUrl}/${encodeURIComponent(id)}/image?${query}`, {
    method: 'PUT',
    headers: { 'content-type': 'image/png' },
    body: png,
  })
  if (!response.ok) throw new Error(`Failed to save a reference image: ${response.status}`)
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
