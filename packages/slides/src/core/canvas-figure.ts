/**
 * キャンバスのフレームを図にする（提案 B）。
 * 画像のパスに `canvas:<フレームのノード id>` を書くと、そのフレームをブラウザが描いた PNG を図として使う。
 * パスの形はふつうの画像と同じなので、スキーマ（SlideImage.path / TableImagesImage.path）は変えない。
 */
import type { DeckData, SlideData } from "./slide-schema.ts";
import { slideKey } from "./slide-ids.ts";
import { computeSlideGeometry, getMaxRowCount, lineBoxHeight, TABLE_IMAGE_SPEC, TABLE_IMAGES_SPEC } from "./slide-layout-spec.ts";

export const CANVAS_FIGURE_PREFIX = "canvas:";

// ノードの id（MAI-7 の node:<16 文字の base62>。取り込んだ旧データの id も通るよう、少し広めに取る）
const FRAME_ID_PATTERN = /^node:[A-Za-z0-9_-]{1,120}$/;

/** 図の欄。1 枚の図（table-image）か、2 図（table-images）の左右 */
export type FigureSlot = "image" | "images.0" | "images.1";

export function isFrameId(value: string): boolean {
  return FRAME_ID_PATTERN.test(value);
}

/** `canvas:node:…` ならフレームの id、そうでなければ null */
export function canvasFigureFrameId(path: string): string | null {
  if (!path.startsWith(CANVAS_FIGURE_PREFIX)) return null;
  const id = path.slice(CANVAS_FIGURE_PREFIX.length);
  return isFrameId(id) ? id : null;
}

export function isCanvasFigurePath(path: string): boolean {
  return path.startsWith(CANVAS_FIGURE_PREFIX);
}

export function canvasFigurePath(frameId: string): string {
  return `${CANVAS_FIGURE_PREFIX}${frameId}`;
}

/** スライドの図の欄のパス（その欄が無ければ undefined） */
export function figurePathAt(slide: SlideData, slot: FigureSlot): string | undefined {
  if (slot === "image") return slide.image?.path;
  return slide.images?.[slot === "images.0" ? 0 : 1]?.path;
}

/** デッキの中の、キャンバスの図の参照（フレームの id と、使っているスライド） */
export function deckCanvasFigures(deck: Pick<DeckData, "slides">): { frameId: string; slideKey: string; slot: FigureSlot }[] {
  const out: { frameId: string; slideKey: string; slot: FigureSlot }[] = [];
  deck.slides.forEach((slide, index) => {
    for (const slot of ["image", "images.0", "images.1"] as const) {
      const path = figurePathAt(slide, slot);
      const frameId = path === undefined ? null : canvasFigureFrameId(path);
      if (frameId) out.push({ frameId, slideKey: slideKey(slide, index), slot });
    }
  });
  return out;
}

/**
 * 図の欄の大きさ（スライドの座標、px）。「キャンバスで描く」で作るフレームの大きさに使う。rowCount は表の行数（2 図のとき、図の高さが変わる）。
 * 図は object-fit: contain で入るので、ここが少しずれても崩れはしない（余白が出るだけ）
 */
export function figureSlotSize(slot: FigureSlot, rowCount = 1): { w: number; h: number } {
  if (slot === "image") {
    const s = TABLE_IMAGE_SPEC;
    return { w: s.figureWidth - s.figurePadding * 2, h: s.height - s.figurePadding * 2 };
  }
  const s = TABLE_IMAGES_SPEC;
  const rows = Math.min(getMaxRowCount("table-images"), Math.max(1, rowCount));
  const figuresHeight = computeSlideGeometry("table-images", rows).figuresHeightPx ?? s.minFiguresHeightPx;
  const titleHeight = lineBoxHeight(s.figureTitle) + s.figureTitle.gap;
  return { w: s.figureColumnWidth, h: Math.max(200, Math.round(figuresHeight - titleHeight - s.padding.bottom)) };
}
