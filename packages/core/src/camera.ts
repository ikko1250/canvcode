import type { Box, Mat, Vec } from './geometry.ts'

// カメラ（MAI-6）。位置と倍率だけを持ち、回転は扱わない。
// (x, y) は画面の左上に来るワールド座標。
export interface Camera {
  x: number
  y: number
  zoom: number
}

export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 8

export const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))

export function screenToWorld(camera: Camera, p: Vec): Vec {
  return { x: camera.x + p.x / camera.zoom, y: camera.y + p.y / camera.zoom }
}

export function worldToScreen(camera: Camera, p: Vec): Vec {
  return { x: (p.x - camera.x) * camera.zoom, y: (p.y - camera.y) * camera.zoom }
}

// ワールド座標 → スクリーン座標の行列。描画時は、JS の 64 ビット浮動小数点数で
// カメラ位置を引いた値だけが Canvas に渡る（MAI-6 の精度対策）。
export function worldToScreenMat(camera: Camera): Mat {
  return {
    a: camera.zoom,
    b: 0,
    c: 0,
    d: camera.zoom,
    e: -camera.x * camera.zoom,
    f: -camera.y * camera.zoom,
  }
}

// 画面に見えているワールドの範囲
export function viewportBounds(camera: Camera, width: number, height: number): Box {
  return { x: camera.x, y: camera.y, w: width / camera.zoom, h: height / camera.zoom }
}

// スクリーン上の点 anchor を固定したまま倍率を変える（ポインタ位置を中心にしたズーム）
export function zoomAt(camera: Camera, anchor: Vec, nextZoom: number): Camera {
  const zoom = clampZoom(nextZoom)
  const world = screenToWorld(camera, anchor)
  return { x: world.x - anchor.x / zoom, y: world.y - anchor.y / zoom, zoom }
}

// スクリーン上で (dx, dy) だけ画面を動かす（内容が指の動きについてくる向き）
export function panBy(camera: Camera, dx: number, dy: number): Camera {
  return { x: camera.x - dx / camera.zoom, y: camera.y - dy / camera.zoom, zoom: camera.zoom }
}

// box 全体が width × height の画面に収まるカメラ。padding はスクリーン上の余白。
export function fitBox(box: Box, width: number, height: number, padding = 48): Camera {
  const availW = Math.max(1, width - padding * 2)
  const availH = Math.max(1, height - padding * 2)
  const zoom = clampZoom(Math.min(availW / Math.max(box.w, 1), availH / Math.max(box.h, 1), 1))
  return {
    x: box.x + box.w / 2 - width / 2 / zoom,
    y: box.y + box.h / 2 - height / 2 / zoom,
    zoom,
  }
}
