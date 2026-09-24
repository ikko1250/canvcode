/** @jsxImportSource preact */
import type { DraftSlide } from "../../state.ts";
import type { SlideChange } from "../SlideForm.tsx";

type Props = { slide: DraftSlide; onChange: SlideChange };

export function TitleForm({ slide, onChange }: Props) {
  return (
    <>
      <div class="section">表紙</div>
      <div class="field">
        <label>
          副題
          <span class="hint">1 行 1 項目。空なら省略</span>
        </label>
        <textarea
          name="subtitle"
          rows={2}
          value={slide.subtitle}
          onInput={(event) => {
            const subtitle = event.currentTarget.value;
            onChange((current) => ({ ...current, subtitle }), `slide:${slide.id}:subtitle`);
          }}
        />
      </div>
      <div class="field">
        <label>
          発表者・所属・日付など
          <span class="hint">1 行 1 項目。下部の灰帯に中央揃えで表示（推奨 3 行以内）</span>
        </label>
        <textarea
          name="credits"
          rows={4}
          value={slide.credits}
          onInput={(event) => {
            const credits = event.currentTarget.value;
            onChange((current) => ({ ...current, credits }), `slide:${slide.id}:credits`);
          }}
        />
      </div>
    </>
  );
}
