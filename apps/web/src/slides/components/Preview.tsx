/** @jsxImportSource preact */
import { useEffect, useState } from "preact/hooks";
import type { FontStatus, PreviewController } from "../preview.ts";

type Props = {
  controller: PreviewController;
  error: string | null;
};

export function Preview({ controller, error }: Props) {
  const [fontStatus, setFontStatus] = useState<FontStatus>("unknown");

  useEffect(() => {
    let tries = 0;
    const timer = window.setInterval(() => {
      const status = controller.fontStatus();
      setFontStatus(status);
      tries += 1;
      if (status === "loaded" || status === "error" || tries > 60) {
        window.clearInterval(timer);
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [controller]);

  return (
    <>
      {fontStatus === "error" && (
        <div class="banner warn">
          Web フォント（M PLUS 1p）を読み込めませんでした。システムフォントで表示・出力します。
        </div>
      )}
      <div class="preview-frame-wrap">
        <iframe
          name="preview"
          title="スライドプレビュー"
          src="/slides-preview.html"
          ref={(element) => controller.attach(element)}
        />
        {error && <div class="preview-overlay">{error}</div>}
      </div>
    </>
  );
}
