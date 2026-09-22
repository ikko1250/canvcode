import type { Camera } from '@canvcode/core'

// 背景グリッド（MAI-19）。画面上の間隔が一定以上になるよう、倍率に応じて 4 倍ずつ切り替える。
// 線は物理ピクセル単位で計算し、どの devicePixelRatio でも 1 物理ピクセル幅でにじまずに描く。

const BASE_STEP = 16
const MIN_SCREEN_STEP = 14

export function drawGrid(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  width: number,
  height: number,
  dpr: number,
  colors: { minor: string; major: string },
): void {
  let step = BASE_STEP
  while (step * camera.zoom < MIN_SCREEN_STEP) step *= 4
  while (step * camera.zoom >= MIN_SCREEN_STEP * 4 && step > BASE_STEP / 64) step /= 4
  const major = step * 4

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.lineWidth = 1
  drawLines(ctx, camera, width, height, dpr, step, major, colors.minor)
  drawLines(ctx, camera, width, height, dpr, major, null, colors.major)
}

function drawLines(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  width: number,
  height: number,
  dpr: number,
  step: number,
  skipMultipleOf: number | null,
  color: string,
): void {
  const startX = Math.floor(camera.x / step) * step
  const startY = Math.floor(camera.y / step) * step
  const endX = camera.x + width / camera.zoom
  const endY = camera.y + height / camera.zoom
  const deviceW = width * dpr
  const deviceH = height * dpr
  const scale = camera.zoom * dpr
  ctx.beginPath()
  for (let x = startX; x <= endX; x += step) {
    if (skipMultipleOf !== null && isMultiple(x, skipMultipleOf)) continue
    const dx = Math.round((x - camera.x) * scale) + 0.5
    ctx.moveTo(dx, 0)
    ctx.lineTo(dx, deviceH)
  }
  for (let y = startY; y <= endY; y += step) {
    if (skipMultipleOf !== null && isMultiple(y, skipMultipleOf)) continue
    const dy = Math.round((y - camera.y) * scale) + 0.5
    ctx.moveTo(0, dy)
    ctx.lineTo(deviceW, dy)
  }
  ctx.strokeStyle = color
  ctx.stroke()
}

function isMultiple(value: number, of: number): boolean {
  const r = Math.abs(value % of)
  return r < 1e-6 || Math.abs(r - of) < 1e-6
}
