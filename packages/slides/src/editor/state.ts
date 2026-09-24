/**
 * GUI エディタの状態モデル（preact 非依存の純粋ロジック）。
 *
 * 下書き（Draft*）は全レイアウトの欄を持つスーパーセットで、入力途中の不正な状態を許す。
 * 保存・プレビューの直前に slideToData / deckToData で JSON 形に戻し、
 * src/core の normalizeSlideData / normalizeDeckData で検証する。
 */
import { lintSlide } from "../core/deck-lint.ts";
import { parseMarkdownDeck } from "../core/markdown-deck.ts";
import { serializeDeck } from "../core/markdown-deck-writer.ts";
import { getMaxRowCount, layoutUsesRows, type SlideLayout } from "../core/slide-layout-spec.ts";
import {
  normalizeDeckData,
  normalizeSlideData,
  type BulletItem,
  type DeckData,
  type RenderSlideData,
  type SlideData,
} from "../core/slide-schema.ts";

export type DraftBullet = { id: string; text: string; children: DraftBullet[] };
export type DraftRow = { id: string; label: string; body: string };
export type DraftImage = { path: string; alt: string; title: string };
export type FigureKind = "image" | "code";

export type DraftSlide = {
  /** UI 用のキー。保存しない */
  id: string;
  name: string;
  layout: SlideLayout;
  title: string;
  /** 改行区切り（1 行 = 1 視覚行） */
  rows: DraftRow[];
  items: DraftBullet[];
  figure: FigureKind;
  image: DraftImage;
  code: { text: string; language: string };
  images: [DraftImage, DraftImage];
  /** 改行区切り。"" は省略 */
  subtitle: string;
  credits: string;
};

export type DraftDeck = {
  schemaRef?: string;
  deckTitle: string;
  slides: DraftSlide[];
};

export const LAYOUT_LABELS: Record<SlideLayout, string> = {
  table: "全幅表",
  "table-image": "左表・右画像／コード",
  "table-images": "上表・下2図",
  title: "表紙",
  bullets: "箇条書き",
};

let nextId = 1;

export function newId(): string {
  nextId += 1;
  return `d${nextId}`;
}

const emptyImage = (): DraftImage => ({ path: "", alt: "", title: "" });

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

// ---------------------------------------------------------------------------
// DeckData ⇄ Draft
// ---------------------------------------------------------------------------

function bulletFromData(item: BulletItem): DraftBullet {
  if (typeof item === "string") {
    return { id: newId(), text: item, children: [] };
  }
  return { id: newId(), text: item.text, children: item.children.map(bulletFromData) };
}

function bulletToData(item: DraftBullet): unknown {
  if (item.children.length === 0) {
    return item.text;
  }
  return { text: item.text, children: item.children.map(bulletToData) };
}

function imageFromData(image: { path: string; alt: string; title?: string } | undefined): DraftImage {
  return image ? { path: image.path, alt: image.alt, title: image.title ?? "" } : emptyImage();
}

export function slideFromData(slide: SlideData): DraftSlide {
  return {
    id: newId(),
    name: slide.name ?? "",
    layout: slide.layout ?? "table",
    title: slide.title,
    rows: (slide.rows ?? []).map((row) => ({
      id: newId(),
      label: row.labelLines.join("\n"),
      body: row.bodyLines.join("\n"),
    })),
    items: (slide.items ?? []).map(bulletFromData),
    figure: slide.code ? "code" : "image",
    image: imageFromData(slide.image),
    code: slide.code
      ? { text: slide.code.lines.join("\n"), language: slide.code.language ?? "" }
      : { text: "", language: "" },
    images: [imageFromData(slide.images?.[0]), imageFromData(slide.images?.[1])],
    subtitle: (slide.subtitle ?? []).join("\n"),
    credits: (slide.credits ?? []).join("\n"),
  };
}

/** 下書きを JSON 形（未検証）に戻す。空欄は省略し、layout "table" は省略する */
export function slideToData(draft: DraftSlide): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (draft.name !== "") out.name = draft.name;
  if (draft.layout !== "table") out.layout = draft.layout;
  out.title = draft.title;

  if (layoutUsesRows(draft.layout)) {
    out.rows = draft.rows.map((row) => ({
      labelLines: splitLines(row.label),
      bodyLines: splitLines(row.body),
    }));
  }
  if (draft.layout === "bullets") {
    out.items = draft.items.map(bulletToData);
  }
  if (draft.layout === "table-image") {
    if (draft.figure === "code") {
      out.code = {
        lines: splitLines(draft.code.text),
        ...(draft.code.language !== "" ? { language: draft.code.language } : {}),
      };
    } else {
      out.image = { path: draft.image.path, alt: draft.image.alt };
    }
  }
  if (draft.layout === "table-images") {
    out.images = draft.images.map((image) => ({
      path: image.path,
      alt: image.alt,
      title: image.title,
    }));
  }
  if (draft.layout === "title") {
    if (draft.subtitle !== "") out.subtitle = splitLines(draft.subtitle);
    if (draft.credits !== "") out.credits = splitLines(draft.credits);
  }
  return out;
}

export function deckFromData(deck: DeckData): DraftDeck {
  return {
    ...(deck.$schema !== undefined ? { schemaRef: deck.$schema } : {}),
    deckTitle: deck.deckTitle ?? "",
    slides: deck.slides.map(slideFromData),
  };
}

export function deckToData(draft: DraftDeck): Record<string, unknown> {
  return {
    ...(draft.schemaRef !== undefined ? { $schema: draft.schemaRef } : {}),
    ...(draft.deckTitle !== "" ? { deckTitle: draft.deckTitle } : {}),
    slides: draft.slides.map(slideToData),
  };
}

// ---------------------------------------------------------------------------
// スライドの生成・レイアウト切替・一覧操作
// ---------------------------------------------------------------------------

export function newRow(): DraftRow {
  return { id: newId(), label: "ラベル", body: "本文" };
}

export function newBullet(text = "項目"): DraftBullet {
  return { id: newId(), text, children: [] };
}

export function newSlide(layout: SlideLayout): DraftSlide {
  return {
    id: newId(),
    name: "",
    layout,
    title: "新しいスライド",
    rows: [newRow()],
    items: [newBullet()],
    figure: "image",
    image: emptyImage(),
    code: { text: "", language: "" },
    images: [emptyImage(), emptyImage()],
    subtitle: "",
    credits: "",
  };
}

/** レイアウトを切り替える。入力済みの欄は保持し、移行先に必要な最小構造を補う */
export function switchLayout(slide: DraftSlide, layout: SlideLayout): DraftSlide {
  const next: DraftSlide = { ...slide, layout };
  if (layoutUsesRows(layout) && next.rows.length === 0) {
    next.rows = [newRow()];
  }
  if (layout === "bullets" && next.items.length === 0) {
    next.items = [newBullet()];
  }
  if (layout === "table-images" && next.images[0].path === "" && next.image.path !== "") {
    next.images = [{ ...next.image }, next.images[1]];
  }
  if (layout === "table-image" && next.image.path === "" && next.images[0].path !== "") {
    next.image = { ...next.images[0], title: "" };
  }
  return next;
}

function cloneBullet(item: DraftBullet): DraftBullet {
  return { id: newId(), text: item.text, children: item.children.map(cloneBullet) };
}

export function duplicateDraftSlide(slide: DraftSlide): DraftSlide {
  return {
    ...slide,
    id: newId(),
    name: "",
    rows: slide.rows.map((row) => ({ ...row, id: newId() })),
    items: slide.items.map(cloneBullet),
    image: { ...slide.image },
    code: { ...slide.code },
    images: [{ ...slide.images[0] }, { ...slide.images[1] }],
  };
}

export function insertSlide(deck: DraftDeck, index: number, slide: DraftSlide): DraftDeck {
  const slides = [...deck.slides];
  slides.splice(Math.max(0, Math.min(index, slides.length)), 0, slide);
  return { ...deck, slides };
}

export function removeSlide(deck: DraftDeck, index: number): DraftDeck {
  if (deck.slides.length <= 1 || index < 0 || index >= deck.slides.length) {
    return deck;
  }
  return { ...deck, slides: deck.slides.filter((_, i) => i !== index) };
}

export function moveSlide(deck: DraftDeck, from: number, to: number): DraftDeck {
  const count = deck.slides.length;
  if (from < 0 || from >= count || to < 0 || to >= count || from === to) {
    return deck;
  }
  const slides = [...deck.slides];
  const [moved] = slides.splice(from, 1);
  if (!moved) return deck;
  slides.splice(to, 0, moved);
  return { ...deck, slides };
}

export function replaceSlide(
  deck: DraftDeck,
  index: number,
  update: (slide: DraftSlide) => DraftSlide,
): DraftDeck {
  const current = deck.slides[index];
  if (!current) return deck;
  const next = update(current);
  if (next === current) return deck;
  return { ...deck, slides: deck.slides.map((slide, i) => (i === index ? next : slide)) };
}

export function maxRows(layout: SlideLayout): number {
  return layoutUsesRows(layout) || layout === "bullets" ? getMaxRowCount(layout) : 0;
}

// ---------------------------------------------------------------------------
// 箇条書きツリーの操作（path はルートからのインデックス列）
// ---------------------------------------------------------------------------

export const MAX_BULLET_DEPTH = 3;

function mapAtPath(
  items: DraftBullet[],
  path: number[],
  update: (siblings: DraftBullet[], index: number) => DraftBullet[],
): DraftBullet[] {
  const [head, ...rest] = path;
  if (head === undefined) return items;
  if (rest.length === 0) {
    return update(items, head);
  }
  return items.map((item, i) =>
    i === head ? { ...item, children: mapAtPath(item.children, rest, update) } : item,
  );
}

export function updateBulletText(items: DraftBullet[], path: number[], text: string): DraftBullet[] {
  return mapAtPath(items, path, (siblings, index) =>
    siblings.map((item, i) => (i === index ? { ...item, text } : item)),
  );
}

export function insertBulletAfter(items: DraftBullet[], path: number[]): DraftBullet[] {
  return mapAtPath(items, path, (siblings, index) => {
    const next = [...siblings];
    next.splice(index + 1, 0, newBullet());
    return next;
  });
}

export function addBulletChild(items: DraftBullet[], path: number[]): DraftBullet[] {
  if (path.length >= MAX_BULLET_DEPTH) return items;
  return mapAtPath(items, path, (siblings, index) =>
    siblings.map((item, i) =>
      i === index ? { ...item, children: [...item.children, newBullet()] } : item,
    ),
  );
}

export function removeBulletAt(items: DraftBullet[], path: number[]): DraftBullet[] {
  if (path.length === 1 && items.length <= 1) return items;
  return mapAtPath(items, path, (siblings, index) => siblings.filter((_, i) => i !== index));
}

export function moveBulletAt(items: DraftBullet[], path: number[], delta: -1 | 1): DraftBullet[] {
  return mapAtPath(items, path, (siblings, index) => {
    const target = index + delta;
    if (target < 0 || target >= siblings.length) return siblings;
    const next = [...siblings];
    const [moved] = next.splice(index, 1);
    if (!moved) return siblings;
    next.splice(target, 0, moved);
    return next;
  });
}

// ---------------------------------------------------------------------------
// 検証・プレビュー
// ---------------------------------------------------------------------------

export type SlideValidation = { ok: true; data: SlideData } | { ok: false; error: string };

export type DeckValidation = {
  slides: SlideValidation[];
  deck: { ok: true; data: DeckData } | { ok: false; error: string };
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validateDeck(draft: DraftDeck): DeckValidation {
  const slides = draft.slides.map((slide, index): SlideValidation => {
    try {
      return { ok: true, data: normalizeSlideData(slideToData(slide), `スライド ${index + 1}`) };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });
  let deck: DeckValidation["deck"];
  try {
    deck = { ok: true, data: normalizeDeckData(deckToData(draft), "デッキ") };
  } catch (error) {
    deck = { ok: false, error: errorMessage(error) };
  }
  return { slides, deck };
}

/** 検証済みスライドをプレビュー描画データにする（画像はサーバー URL、行高は lint 結果） */
export function previewData(
  slide: SlideData,
  index: number,
  assetUrl: (path: string) => string,
): RenderSlideData {
  const render: RenderSlideData = { title: slide.title };
  if (slide.name !== undefined) render.name = slide.name;
  if (slide.layout !== undefined) render.layout = slide.layout;
  if (slide.rows) render.rows = slide.rows;
  if (slide.items) render.items = slide.items;
  if (slide.subtitle) render.subtitle = slide.subtitle;
  if (slide.credits) render.credits = slide.credits;
  if (slide.layout === "table-image" && slide.code) {
    render.code = slide.code;
  } else if (slide.layout === "table-image" && slide.image) {
    render.image = { src: assetUrl(slide.image.path), alt: slide.image.alt };
  } else if (slide.layout === "table-images" && slide.images) {
    render.images = slide.images.map((image) => ({
      src: assetUrl(image.path),
      alt: image.alt,
      title: image.title,
    }));
  }
  const heights = lintSlide(slide, index).computedRowHeights;
  if (heights) render.computedRowHeights = heights;
  return render;
}

// ---------------------------------------------------------------------------
// ソースタブ: テキスト ⇄ デッキ
// ---------------------------------------------------------------------------

export type DeckTextFormat = "md" | "json";

/** Markdown / JSON のテキストを検証済みデッキにする（失敗時は throw） */
export function parseDeckText(text: string, format: DeckTextFormat, sourceName: string): DeckData {
  if (format === "md") {
    return normalizeDeckData(parseMarkdownDeck(text, sourceName), sourceName);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${sourceName}: JSON を解析できませんでした。${errorMessage(error)}`);
  }
  return normalizeDeckData(parsed, sourceName);
}

/** 下書きをファイル形式の文字列にする（検証と Markdown の往復ガード込み。失敗時は throw） */
export function serializeDraft(draft: DraftDeck, fileName: string): string {
  return serializeDeck(deckToData(draft), fileName);
}

export type SlideWarning = { index: number; text: string };

/** 検証に通ったスライドの lint 警告を、スライド番号付きで並べる */
export function collectWarnings(validation: DeckValidation): SlideWarning[] {
  const warnings: SlideWarning[] = [];
  validation.slides.forEach((slide, index) => {
    if (!slide.ok) return;
    const lint = lintSlide(slide.data, index);
    for (const text of [...lint.structuralWarnings, ...lint.capacityWarnings]) {
      warnings.push({ index, text });
    }
  });
  return warnings;
}
