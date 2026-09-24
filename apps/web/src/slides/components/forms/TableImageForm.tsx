/** @jsxImportSource preact */
import type { AssetSummary } from "../../api.ts";
import type { DraftSlide, FigureKind } from "../../state.ts";
import { ImagePicker } from "../ImagePicker.tsx";
import type { SlideChange } from "../SlideForm.tsx";

type Props = {
  slide: DraftSlide;
  deckFile: string;
  assets: AssetSummary[];
  onChange: SlideChange;
  onAssetsChanged: () => void;
};

export function TableImageForm({ slide, deckFile, assets, onChange, onAssetsChanged }: Props) {
  const setFigure = (figure: FigureKind): void =>
    onChange((current) => ({ ...current, figure }), null);

  return (
    <>
      <div class="section">右ペイン</div>
      <div class="radio-group">
        <label>
          <input
            type="radio"
            name="figure"
            checked={slide.figure === "image"}
            onChange={() => setFigure("image")}
          />
          画像
        </label>
        <label>
          <input
            type="radio"
            name="figure"
            checked={slide.figure === "code"}
            onChange={() => setFigure("code")}
          />
          コード
        </label>
      </div>

      {slide.figure === "image" ? (
        <ImagePicker
          value={slide.image}
          showTitle={false}
          deckFile={deckFile}
          assets={assets}
          onChange={(image, key) => onChange((current) => ({ ...current, image }), key)}
          onAssetsChanged={onAssetsChanged}
        />
      ) : (
        <>
          <div class="field">
            <label>
              コード
              <span class="hint">推奨 15〜22 行・1 行 60〜75 字。空行はそのまま保持。インデントはスペース推奨</span>
            </label>
            <textarea
              class="code"
              name="code"
              rows={14}
              spellcheck={false}
              value={slide.code.text}
              onInput={(event) => {
                const text = event.currentTarget.value;
                onChange((current) => ({ ...current, code: { ...current.code, text } }), `slide:${slide.id}:code`);
              }}
            />
          </div>
          <div class="field">
            <label>
              言語
              <span class="hint">任意（表示には未使用）</span>
            </label>
            <input
              type="text"
              name="language"
              value={slide.code.language}
              placeholder="python"
              onInput={(event) => {
                const language = event.currentTarget.value;
                onChange(
                  (current) => ({ ...current, code: { ...current.code, language } }),
                  `slide:${slide.id}:language`,
                );
              }}
            />
          </div>
        </>
      )}
    </>
  );
}
