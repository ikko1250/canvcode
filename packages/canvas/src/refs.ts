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
  // 枠に触れた PDF のページ（固定したページも、グループやフレームの中も含めて）
  pdfPagesIn(rect: Box): PdfPageInRange[]
}

export interface PdfPageInRange {
  id: string
  bounds: Box
  fileId: string
  pageIndex: number
  assetId: string
}

// 範囲選択の枠がかかった PDF のページの、ページの中の範囲。文字はまだ入っていない（ブラウザで PDF から読む）
export interface PdfRegionRequest {
  nodeId: string
  assetId: string
  fileId: string
  pageIndex: number
  rect: Box
}

// 範囲を付けるページの数の上限（ページごとに PDF の文字を読むので）
const MAX_PDF_REGIONS = 8
// 枠がページのこれ以上を覆っていれば、ページ全体とみなして範囲を付けない
const WHOLE_PAGE = 0.95

// Canvas の範囲の参照。
// - 直前の範囲選択のあと選択を変えていなければ、その枠を範囲にする（ノードのない所も含めて見てほしいことがある）。
//   何もない所を右クリックすると選択は外れるので、選択が空のときも枠を使い、ノードは枠の中から選び直す。
//   固定した PDF のページは範囲選択で選ばれないが、ページの一部を囲むことはよくあるので、ノードに加える
// - そうでなければ、選んでいるノードを囲む箱
// どちらもなければ null
export function canvasRefTarget(source: CanvasRefSource): CanvasRefTarget | null {
  const brush = activeBrush(source)
  const ids = source.selectedIds.size > 0 ? [...source.selectedIds] : brush ? source.nodesInBrush(brush.rect) : []
  if (brush) {
    const known = new Set(ids)
    for (const page of source.pdfPagesIn(brush.rect)) if (!known.has(page.id)) ids.push(page.id)
  }
  const nodes = ids.flatMap((id) => {
    const bounds = source.boundsOf(id)
    return bounds ? [{ id, bounds: roundBox(bounds) }] : []
  })
  const rect = brush?.rect ?? unionBoxes(nodes.map((n) => n.bounds))
  if (!rect || (nodes.length === 0 && !brush)) return null
  return { kind: 'canvas', canvasId: source.canvasId, rect: roundBox(rect), nodes }
}

// 範囲選択の枠が一部にかかった PDF のページと、ページの中の範囲（割合）。
// 枠を使わないとき（選んだノードを囲む箱）や、ページのほぼ全体を囲んだときは付けない（ページ全体の文字はサーバーが返す）
export function pdfRegionRequests(source: CanvasRefSource): PdfRegionRequest[] {
  const brush = activeBrush(source)
  if (!brush) return []
  const out: PdfRegionRequest[] = []
  for (const page of source.pdfPagesIn(brush.rect)) {
    const { bounds } = page
    if (!(bounds.w > 0) || !(bounds.h > 0)) continue
    const x0 = clamp01((brush.rect.x - bounds.x) / bounds.w)
    const y0 = clamp01((brush.rect.y - bounds.y) / bounds.h)
    const x1 = clamp01((brush.rect.x + brush.rect.w - bounds.x) / bounds.w)
    const y1 = clamp01((brush.rect.y + brush.rect.h - bounds.y) / bounds.h)
    const area = (x1 - x0) * (y1 - y0)
    if (!(area > 0) || area >= WHOLE_PAGE) continue
    const r = (n: number) => Math.round(n * 10000) / 10000
    const rect = { x: r(x0), y: r(y0), w: r(x1 - x0), h: r(y1 - y0) }
    // 丸めで 1 をわずかに超えないように
    rect.w = Math.min(rect.w, 1 - rect.x)
    rect.h = Math.min(rect.h, 1 - rect.y)
    out.push({ nodeId: page.id, assetId: page.assetId, fileId: page.fileId, pageIndex: page.pageIndex, rect })
    if (out.length >= MAX_PDF_REGIONS) break
  }
  return out
}

// 参照の範囲に使う、直前の範囲選択の枠（そのあと選択を変えていないときだけ）
function activeBrush(source: CanvasRefSource): { rect: Box; ids: ReadonlySet<string> } | null {
  const last = source.lastBrush
  return last && (source.selectedIds.size === 0 || sameIds(last.ids, source.selectedIds)) ? last : null
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
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
// - Canvas の範囲：範囲の中に手書き線か画像のノードがあるとき（選んだグループやフレームの中も含めて）、
//   または囲んだ PDF のページの範囲が図のとき（文字がほとんどない）
// - PDF の範囲：今の Canvas にそのページがあり、選んだ範囲に手書き線が重なっているか、範囲が図のとき
// 文字だけなら添えない（AI に渡すトークンを無駄にしないため）
export function refImageRegion(target: RefTarget, source: RefImageSource): Box | null {
  if (target.kind === 'canvas') {
    if (target.canvasId !== source.canvasId || !(target.rect.w > 0) || !(target.rect.h > 0)) return null
    if (target.nodes.some((n) => n.pdf?.figure)) return target.rect
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
    if (target.figure) return roundBox(region)
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
