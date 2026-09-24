/**
 * プレビュー iframe（/slides-preview.html）の制御。
 * renderSlide は画像のデコードを待つ非同期処理なので、描画中に来た要求は最新の 1 件だけ保持し、
 * 完了後に描画する（最後の要求が勝つ）。
 */
export type PreviewRenderResult = { ok: boolean; message?: string };

type PreviewWindow = Window & {
  renderSlide?: (data: unknown) => Promise<PreviewRenderResult> | PreviewRenderResult;
};

export type FontStatus = "loaded" | "error" | "pending" | "unknown";

const PREVIEW_STYLE_ID = "editor-preview-style";

/**
 * index.html は body{display:grid} の中で 1920×1080 の .viewport を中心基準で縮小するため、
 * 小さな iframe では縮小後のスライドが可視領域の外に出る。iframe 内では左上基準で縮小し、
 * 16:9 の枠にぴったり収める（export モードのスタイルには影響しない）。
 */
function injectPreviewStyle(doc: Document | null): void {
  if (!doc || doc.getElementById(PREVIEW_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = PREVIEW_STYLE_ID;
  style.textContent =
    "body:not(.export-mode):not(.deck-export-mode){display:block!important;place-items:start!important}" +
    "body:not(.export-mode):not(.deck-export-mode) .viewport{transform-origin:0 0!important;justify-self:start!important;align-self:start!important}";
  doc.head.appendChild(style);
}

export class PreviewController {
  private frame: HTMLIFrameElement | null = null;
  private ready = false;
  private inFlight = false;
  private queued: unknown = undefined;
  private hasQueued = false;

  onResult: ((result: PreviewRenderResult) => void) | null = null;

  attach(frame: HTMLIFrameElement | null): void {
    if (this.frame === frame) return;
    this.frame = frame;
    this.ready = false;
    if (!frame) return;

    const markReady = (): void => {
      injectPreviewStyle(frame.contentDocument);
      this.ready = true;
      void this.flush();
    };
    frame.addEventListener("load", markReady);
    if (typeof (frame.contentWindow as PreviewWindow | null)?.renderSlide === "function") {
      markReady();
    }
  }

  render(data: unknown): void {
    this.queued = data;
    this.hasQueued = true;
    void this.flush();
  }

  fontStatus(): FontStatus {
    const link = this.frame?.contentDocument?.getElementById("mplus-font");
    const status = link instanceof HTMLElement ? link.dataset.status : undefined;
    if (status === "loaded" || status === "error") return status;
    return link ? "pending" : "unknown";
  }

  private async flush(): Promise<void> {
    if (!this.ready || this.inFlight || !this.hasQueued || !this.frame) return;
    const data = this.queued;
    this.queued = undefined;
    this.hasQueued = false;
    this.inFlight = true;
    try {
      const target = this.frame.contentWindow as PreviewWindow | null;
      if (target && typeof target.renderSlide === "function") {
        const result = await target.renderSlide(data);
        this.onResult?.(result);
      }
    } catch (error) {
      this.onResult?.({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.inFlight = false;
      if (this.hasQueued) {
        void this.flush();
      }
    }
  }
}
