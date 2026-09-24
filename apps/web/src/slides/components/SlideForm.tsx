/** @jsxImportSource preact */
import { layoutUsesRows, SLIDE_LAYOUTS, type SlideLayout } from "@canvcode/slides/core/slide-layout-spec";
import type { AssetSummary } from "../api.ts";
import { LAYOUT_LABELS, switchLayout, type DraftSlide } from "../state.ts";
import { BulletsForm } from "./forms/BulletsForm.tsx";
import { RowsForm } from "./forms/RowsForm.tsx";
import { TableImageForm } from "./forms/TableImageForm.tsx";
import { TableImagesForm } from "./forms/TableImagesForm.tsx";
import { TitleForm } from "./forms/TitleForm.tsx";

export type SlideChange = (fn: (slide: DraftSlide) => DraftSlide, key: string | null) => void;

type Props = {
  slide: DraftSlide;
  deckFile: string;
  assets: AssetSummary[];
  onChange: SlideChange;
  onBlur: () => void;
  onAssetsChanged: () => void;
};

export function SlideForm(props: Props) {
  const { slide, onChange } = props;
  const fieldKey = (field: string): string => `slide:${slide.id}:${field}`;

  return (
    <div class="form" onFocusOut={props.onBlur}>
      <div class="field-row">
        <div class="field">
          <label>レイアウト</label>
          <select
            name="layout"
            value={slide.layout}
            onChange={(event) => {
              const layout = event.currentTarget.value as SlideLayout;
              onChange((current) => switchLayout(current, layout), null);
            }}
          >
            {SLIDE_LAYOUTS.map((layout) => (
              <option key={layout} value={layout}>
                {LAYOUT_LABELS[layout]}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label>
            name
            <span class="hint">PNG のファイル名（英小文字・数字・ハイフン）。省略可</span>
          </label>
          <input
            type="text"
            name="name"
            value={slide.name}
            placeholder="prior-research-3"
            onInput={(event) => {
              const name = event.currentTarget.value;
              onChange((current) => ({ ...current, name }), fieldKey("name"));
            }}
          />
        </div>
      </div>

      <div class="field">
        <label>
          {slide.layout === "title" ? "発表タイトル" : "スライドタイトル"}
          <span class="hint">**強調** が使えます</span>
        </label>
        <input
          type="text"
          name="title"
          value={slide.title}
          onInput={(event) => {
            const title = event.currentTarget.value;
            onChange((current) => ({ ...current, title }), fieldKey("title"));
          }}
        />
      </div>

      {slide.layout === "title" && <TitleForm slide={slide} onChange={onChange} />}

      {slide.layout === "bullets" && (
        <BulletsForm
          items={slide.items}
          onChange={(items, key) => onChange((current) => ({ ...current, items }), key)}
        />
      )}

      {layoutUsesRows(slide.layout) && (
        <RowsForm
          rows={slide.rows}
          layout={slide.layout}
          onChange={(rows, key) => onChange((current) => ({ ...current, rows }), key)}
        />
      )}

      {slide.layout === "table-image" && (
        <TableImageForm
          slide={slide}
          deckFile={props.deckFile}
          assets={props.assets}
          onChange={onChange}
          onAssetsChanged={props.onAssetsChanged}
        />
      )}

      {slide.layout === "table-images" && (
        <TableImagesForm
          slide={slide}
          deckFile={props.deckFile}
          assets={props.assets}
          onChange={onChange}
          onAssetsChanged={props.onAssetsChanged}
        />
      )}
    </div>
  );
}
