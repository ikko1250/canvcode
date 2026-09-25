/**
 * ブラウザ側の描画。Vite のプレビュー HTML entry とサーバー出力から同じ module を読み込む。
 * 幾何・検証は core と共有する。
 */
import {
  computeCoverGeometry,
  computeSlideGeometry,
  cssTokens,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  type SlideLayout,
} from "../core/slide-layout-spec.ts";
import {
  validateRenderSlideData,
  type BulletItem,
  type RenderSlideData,
} from "../core/slide-schema.ts";
import { parseInlineMarkup } from "../core/inline-markup.ts";

type RenderResult = { ok: boolean; message?: string };

type SlideStructure = {
  heading: HTMLHeadingElement;
  rows: HTMLDivElement;
  panel: HTMLElement;
  figurePanel: HTMLElement | null;
  figureSlots: { title: HTMLDivElement; frame: HTMLDivElement; image: HTMLImageElement }[] | null;
};

const defaultSlideData: RenderSlideData = {
  title: "先行研究の動向",
  rows: [
    {
      labelLines: ["Zhan et al.", "(2019)"],
      bodyLines: [
        "複数の不確実性（電力・水素価格など）を考慮し、",
        "風力発電のインバランス低減に向けた最適化を実施。",
      ],
    },
    {
      labelLines: ["松原ほか (2022)"],
      bodyLines: ["蓄電池と電解装置の導入による、", "太陽光発電のインバランス低減と経済的効果を評価。"],
    },
    {
      labelLines: ["Tatti et al.", "(2024)"],
      bodyLines: [
        "マイクログリッドを対象に、",
        "ルールベースの運転方針に基づきLCOE（均等化発電原価）を算定。",
      ],
    },
  ],
};

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`#${id} 要素が見つかりません。`);
  }
  return element as T;
}

const viewport = requireElement<HTMLElement>("viewport");
const slide = requireElement<HTMLElement>("slide");
const deck = requireElement<HTMLElement>("deck");

function applyTokens(): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(cssTokens())) {
    root.style.setProperty(name, value);
  }
}

function appendInline(parent: HTMLElement, text: string): void {
  for (const segment of parseInlineMarkup(text)) {
    if (segment.bold) {
      const strong = document.createElement("strong");
      strong.textContent = segment.text;
      parent.appendChild(strong);
    } else {
      parent.appendChild(document.createTextNode(segment.text));
    }
  }
}

function appendLines(parent: HTMLElement, lines: string[]): void {
  const wrapper = document.createElement("div");

  for (const text of lines) {
    const line = document.createElement("span");
    line.className = "line";
    appendInline(line, text);
    wrapper.appendChild(line);
  }

  parent.appendChild(wrapper);
}

function createSlideStructure(slideElement: HTMLElement, layout: SlideLayout): SlideStructure {
  slideElement.replaceChildren();

  const heading = document.createElement("h1");
  const rows = document.createElement("div");
  rows.className = "rows";

  if (layout === "table-image") {
    const mixedLayout = document.createElement("div");
    mixedLayout.className = "mixed-layout";

    const tablePanel = document.createElement("div");
    tablePanel.className = "mixed-table-panel";
    tablePanel.appendChild(rows);

    const figurePanel = document.createElement("figure");
    figurePanel.className = "figure-panel";

    mixedLayout.append(tablePanel, figurePanel);
    slideElement.append(heading, mixedLayout);
    return { heading, rows, panel: tablePanel, figurePanel, figureSlots: null };
  }

  if (layout === "table-images") {
    const container = document.createElement("div");
    container.className = "table-images-layout";

    const panel = document.createElement("div");
    panel.className = "research-panel table-images-panel";
    panel.appendChild(rows);

    const figuresRow = document.createElement("div");
    figuresRow.className = "figures-row";

    const figureSlots: SlideStructure["figureSlots"] = [];
    for (let index = 0; index < 2; index += 1) {
      const slot = document.createElement("div");
      slot.className = "figure-slot";

      const figureTitle = document.createElement("div");
      figureTitle.className = "figure-title";

      const figureFrame = document.createElement("div");
      figureFrame.className = "figure-frame";

      const figureImage = document.createElement("img");
      figureImage.className = "figure-image";
      figureFrame.appendChild(figureImage);

      slot.append(figureTitle, figureFrame);
      figuresRow.appendChild(slot);
      figureSlots.push({ title: figureTitle, frame: figureFrame, image: figureImage });
    }

    container.append(panel, figuresRow);
    slideElement.append(heading, container);
    return { heading, rows, panel, figurePanel: null, figureSlots };
  }

  const panel = document.createElement("div");
  panel.className = "research-panel";
  panel.appendChild(rows);
  slideElement.append(heading, panel);
  return { heading, rows, panel, figurePanel: null, figureSlots: null };
}

function showTemplateError(slideElement: HTMLElement, message: string): void {
  slideElement.replaceChildren();
  const error = document.createElement("div");
  error.className = "template-error";
  error.textContent = message;
  slideElement.appendChild(error);
}

async function waitForImage(image: HTMLImageElement): Promise<void> {
  try {
    if (typeof image.decode === "function") {
      await image.decode();
    } else if (!image.complete) {
      await new Promise<void>((resolve, reject) => {
        image.addEventListener("load", () => resolve(), { once: true });
        image.addEventListener("error", () => reject(new Error("load error")), { once: true });
      });
    }
  } catch {
    throw new Error("画像をデコードできませんでした。");
  }

  if (!image.complete || image.naturalWidth === 0 || image.naturalHeight === 0) {
    throw new Error("画像を読み込めませんでした。");
  }
}

/** zoom/x/y が既定値なら transform を外す。既存デッキの画素を変えないため */
function applyImageAdjust(
  image: HTMLImageElement,
  adjust: { zoom?: number; x?: number; y?: number } | undefined,
): void {
  const zoom = adjust?.zoom ?? 1;
  const x = adjust?.x ?? 0;
  const y = adjust?.y ?? 0;
  if (zoom === 1 && x === 0 && y === 0) {
    image.style.transform = "";
  } else {
    image.style.transform = `translate(${x}%, ${y}%) scale(${zoom})`;
  }
}

/** 表紙: 見出しブロック（タイトル＋副題）を領域中央に置き、credits があれば下部の灰帯に表示 */
function populateCoverSlide(slideElement: HTMLElement, data: RenderSlideData): void {
  const credits = data.credits ?? [];
  const geometry = computeCoverGeometry(credits.length > 0);

  slideElement.replaceChildren();
  slideElement.setAttribute("aria-label", data.title);
  slideElement.dataset.layout = "title";
  slideElement.dataset.rowCount = "0";
  slideElement.dataset.compact = "false";

  const heading = document.createElement("div");
  heading.className = "cover-heading";
  heading.style.height = `${geometry.headingAreaHeight}px`;

  const title = document.createElement("h1");
  title.className = "cover-title";
  appendInline(title, data.title);
  heading.appendChild(title);

  if (data.subtitle && data.subtitle.length > 0) {
    const subtitle = document.createElement("div");
    subtitle.className = "cover-subtitle";
    appendLines(subtitle, data.subtitle);
    heading.appendChild(subtitle);
  }

  slideElement.appendChild(heading);

  if (credits.length > 0) {
    const band = document.createElement("div");
    band.className = "cover-credits";
    band.style.top = `${geometry.bandTop}px`;
    band.style.height = `${geometry.bandHeight}px`;
    appendLines(band, credits);
    slideElement.appendChild(band);
  }
}

function appendBulletLines(wrapper: HTMLElement, item: BulletItem, depth: number): void {
  const line = document.createElement("span");
  line.className = depth === 0 ? "line" : `line bullet-line bullet-level-${depth + 1}`;
  appendInline(line, typeof item === "string" ? item : item.text);
  wrapper.appendChild(line);
  if (typeof item !== "string") {
    for (const child of item.children) {
      appendBulletLines(wrapper, child, depth + 1);
    }
  }
}

/** 箇条書き: 全幅表と同じ灰パネルに、項目ごとのクリーム行（ラベル列なし）を並べる */
function populateBulletsSlide(slideElement: HTMLElement, data: RenderSlideData): void {
  const items = data.items ?? [];
  const count = items.length;
  const geometry = computeSlideGeometry("bullets", count, { forceFull: data.computedFullPanel === true });
  const { heading, rows, panel } = createSlideStructure(slideElement, "bullets");
  panel.classList.add("research-panel--bullets");

  slideElement.setAttribute("aria-label", data.title);
  slideElement.dataset.layout = "bullets";
  slideElement.dataset.rowCount = String(count);
  slideElement.dataset.compact = String(geometry.compact);

  heading.textContent = data.title;
  heading.style.top = `${geometry.titleTop}px`;
  panel.style.top = `${geometry.panelTop}px`;
  panel.style.height = `${geometry.panelHeight}px`;

  const rowHeights =
    data.computedRowHeights && data.computedRowHeights.length === count
      ? data.computedRowHeights
      : Array.from({ length: count }, () => geometry.grid.defaultRowPx);
  rows.className = `rows rows-${count}`;
  rows.style.gridTemplateRows = rowHeights.map((height) => `${height}px`).join(" ");
  rows.style.rowGap = count > 1 ? `${geometry.grid.gapPx}px` : "0px";

  for (const item of items) {
    const row = document.createElement("article");
    row.className = "row row--bullets";

    const summary = document.createElement("div");
    summary.className = "summary summary--bullets";
    const wrapper = document.createElement("div");
    appendBulletLines(wrapper, item, 0);
    summary.appendChild(wrapper);

    row.appendChild(summary);
    rows.appendChild(row);
  }
}

async function populateSlideElement(slideElement: HTMLElement, data: unknown): Promise<void> {
  validateRenderSlideData(data);
  const layout: SlideLayout = data.layout ?? "table";

  if (layout === "title") {
    populateCoverSlide(slideElement, data);
    return;
  }

  if (layout === "bullets") {
    populateBulletsSlide(slideElement, data);
    return;
  }

  if (!data.rows) {
    throw new Error(`${layout} レイアウトには rows が必要です。`);
  }

  const count = data.rows.length;
  const geometry = computeSlideGeometry(layout, count, { forceFull: data.computedFullPanel === true });
  const { heading, rows, panel, figurePanel, figureSlots } = createSlideStructure(
    slideElement,
    layout,
  );

  slideElement.setAttribute("aria-label", data.title);
  slideElement.dataset.layout = layout;
  slideElement.dataset.rowCount = String(count);
  slideElement.dataset.compact = String(geometry.compact);

  heading.textContent = data.title;
  heading.style.top = `${geometry.titleTop}px`;

  if (layout === "table") {
    panel.style.top = `${geometry.panelTop}px`;
  }
  panel.style.height = `${geometry.panelHeight}px`;

  const rowHeights =
    data.computedRowHeights && data.computedRowHeights.length === count
      ? data.computedRowHeights
      : Array.from({ length: count }, () => geometry.grid.defaultRowPx);
  rows.className = `rows rows-${count}`;
  rows.style.gridTemplateRows = rowHeights.map((height) => `${height}px`).join(" ");
  rows.style.rowGap = count > 1 ? `${geometry.grid.gapPx}px` : "0px";

  for (const tableRow of data.rows) {
    const row = document.createElement("article");
    row.className = "row";

    const citation = document.createElement("div");
    citation.className = "citation";
    appendLines(citation, tableRow.labelLines);

    const summary = document.createElement("div");
    summary.className = "summary";
    appendLines(summary, tableRow.bodyLines);

    row.append(citation, summary);
    rows.appendChild(row);
  }

  if (layout === "table-image" && figurePanel) {
    if (data.code) {
      figurePanel.classList.add("figure-panel--code");

      const pre = document.createElement("pre");
      pre.className = "figure-code";

      const codeElement = document.createElement("code");
      codeElement.textContent = data.code.lines.join("\n");
      if (data.code.language) {
        codeElement.dataset.language = data.code.language;
      }

      pre.appendChild(codeElement);
      figurePanel.replaceChildren(pre);
    } else if (data.image) {
      const figureFrame = document.createElement("div");
      figureFrame.className = "figure-frame";

      const figureImage = document.createElement("img");
      figureImage.className = "figure-image";
      figureImage.alt = data.image.alt;
      figureImage.src = data.image.src;
      figureFrame.appendChild(figureImage);
      figurePanel.replaceChildren(figureFrame);
      await waitForImage(figureImage);
      applyImageAdjust(figureImage, data.image);
    }
  }

  if (layout === "table-images" && figureSlots && data.images) {
    for (let index = 0; index < figureSlots.length; index += 1) {
      const slot = figureSlots[index];
      const imageData = data.images[index];
      if (!slot || !imageData) {
        continue;
      }
      slot.title.textContent = imageData.title;
      slot.image.alt = imageData.alt;
      slot.image.src = imageData.src;
      await waitForImage(slot.image);
      slot.frame.style.aspectRatio = `${slot.image.naturalWidth} / ${slot.image.naturalHeight}`;
      applyImageAdjust(slot.image, imageData);
    }
  }
}

async function renderSlide(data: unknown): Promise<RenderResult> {
  try {
    await populateSlideElement(slide, data);
    document.title = (data as RenderSlideData).title;
    document.documentElement.dataset.renderStatus = "ready";
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    document.documentElement.dataset.renderStatus = "error";
    showTemplateError(slide, message);
    return { ok: false, message };
  }
}

async function renderDeck(slides: unknown): Promise<RenderResult> {
  try {
    if (!Array.isArray(slides) || slides.length === 0) {
      throw new Error("slides には1件以上のスライドを指定してください。");
    }

    deck.replaceChildren();

    for (const slideData of slides) {
      const slideElement = document.createElement("section");
      slideElement.className = "slide";
      await populateSlideElement(slideElement, slideData);
      deck.appendChild(slideElement);
    }

    document.documentElement.dataset.renderStatus = "ready";
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    document.documentElement.dataset.renderStatus = "error";
    deck.replaceChildren();
    const errorSlide = document.createElement("section");
    errorSlide.className = "slide";
    showTemplateError(errorSlide, message);
    deck.appendChild(errorSlide);
    return { ok: false, message };
  }
}

function fitSlide(): void {
  if (
    document.body.classList.contains("export-mode") ||
    document.body.classList.contains("deck-export-mode")
  ) {
    viewport.style.transform = "none";
    return;
  }

  const scale = Math.min(window.innerWidth / SLIDE_WIDTH, window.innerHeight / SLIDE_HEIGHT);
  viewport.style.transform = `scale(${scale})`;
}

function setExportMode(enabled: boolean): void {
  document.body.classList.toggle("export-mode", enabled);
  fitSlide();
}

function setDeckExportMode(enabled: boolean): void {
  document.body.classList.toggle("deck-export-mode", enabled);
  fitSlide();
}

declare global {
  interface Window {
    renderSlide: typeof renderSlide;
    renderDeck: typeof renderDeck;
    setExportMode: typeof setExportMode;
    setDeckExportMode: typeof setDeckExportMode;
    getSlideRenderStatus: () => string | undefined;
  }
}

applyTokens();
window.renderSlide = renderSlide;
window.renderDeck = renderDeck;
window.setExportMode = setExportMode;
window.setDeckExportMode = setDeckExportMode;
window.getSlideRenderStatus = () => document.documentElement.dataset.renderStatus;

void renderSlide(defaultSlideData);
window.addEventListener("resize", fitSlide, { passive: true });
fitSlide();
