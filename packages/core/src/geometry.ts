// 幾何計算の基本関数（MAI-6）。外部ライブラリを使わず、ここに最小限だけ置く。
// 値は作り直さずに済むよう、どれも新しいオブジェクトを返す純粋関数にしている。

export interface Vec {
  x: number
  y: number
}

// 2×3 のアフィン行列。[a c e; b d f] として点 (x, y) を (a*x + c*y + e, b*x + d*y + f) に写す。
// Canvas2D の setTransform(a, b, c, d, e, f) と同じ並び。
export interface Mat {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export const vec = (x: number, y: number): Vec => ({ x, y })
export const add = (p: Vec, q: Vec): Vec => ({ x: p.x + q.x, y: p.y + q.y })
export const sub = (p: Vec, q: Vec): Vec => ({ x: p.x - q.x, y: p.y - q.y })
export const scale = (p: Vec, s: number): Vec => ({ x: p.x * s, y: p.y * s })
export const len = (p: Vec): number => Math.hypot(p.x, p.y)
export const dist = (p: Vec, q: Vec): number => Math.hypot(p.x - q.x, p.y - q.y)

export const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

export function translation(x: number, y: number): Mat {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y }
}

// 平行移動 → 回転（ラジアン）の順に合成した行列。ノードのローカル座標 → 親の座標に使う。
export function transformOf(x: number, y: number, rotation: number): Mat {
  if (rotation === 0) return translation(x, y)
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  return { a: cos, b: sin, c: -sin, d: cos, e: x, f: y }
}

// m1 ∘ m2（先に m2、次に m1 を適用する）
export function multiply(m1: Mat, m2: Mat): Mat {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  }
}

export function invert(m: Mat): Mat {
  const det = m.a * m.d - m.b * m.c
  if (det === 0) throw new Error('Matrix is not invertible')
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  }
}

export function applyMat(m: Mat, p: Vec): Vec {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }
}

export function boxContains(box: Box, p: Vec): boolean {
  return p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h
}

export function boxesIntersect(p: Box, q: Box): boolean {
  return p.x <= q.x + q.w && q.x <= p.x + p.w && p.y <= q.y + q.h && q.y <= p.y + p.h
}

export function expandBox(box: Box, margin: number): Box {
  return { x: box.x - margin, y: box.y - margin, w: box.w + margin * 2, h: box.h + margin * 2 }
}

export function unionBoxes(boxes: Iterable<Box>): Box | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const box of boxes) {
    minX = Math.min(minX, box.x)
    minY = Math.min(minY, box.y)
    maxX = Math.max(maxX, box.x + box.w)
    maxY = Math.max(maxY, box.y + box.h)
  }
  if (minX === Infinity) return null
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

// ローカル座標の箱を行列で写したときの外接箱。回転したノードのワールド上の範囲に使う。
export function transformBox(m: Mat, box: Box): Box {
  const corners = [
    applyMat(m, { x: box.x, y: box.y }),
    applyMat(m, { x: box.x + box.w, y: box.y }),
    applyMat(m, { x: box.x + box.w, y: box.y + box.h }),
    applyMat(m, { x: box.x, y: box.y + box.h }),
  ]
  const xs = corners.map((p) => p.x)
  const ys = corners.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

// 2 点を対角とする箱（ドラッグで図形を作るときなど）
export function boxFromPoints(p: Vec, q: Vec): Box {
  const x = Math.min(p.x, q.x)
  const y = Math.min(p.y, q.y)
  return { x, y, w: Math.abs(p.x - q.x), h: Math.abs(p.y - q.y) }
}
