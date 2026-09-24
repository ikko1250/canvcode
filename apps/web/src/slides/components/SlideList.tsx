/** @jsxImportSource preact */
import { useState } from "preact/hooks";
import { SLIDE_LAYOUTS, type SlideLayout } from "@canvcode/slides/core/slide-layout-spec";
import { LAYOUT_LABELS, type DeckValidation, type DraftSlide } from "../state.ts";

type Props = {
  slides: DraftSlide[];
  validation: DeckValidation;
  selected: number;
  onSelect: (index: number) => void;
  onAdd: (layout: SlideLayout) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onMove: (delta: -1 | 1) => void;
};

export function SlideList(props: Props) {
  const [layout, setLayout] = useState<SlideLayout>("table");

  return (
    <nav class="slide-list" aria-label="スライド一覧">
      <div class="add">
        <select
          aria-label="追加するレイアウト"
          value={layout}
          onChange={(event) => setLayout(event.currentTarget.value as SlideLayout)}
        >
          {SLIDE_LAYOUTS.map((item) => (
            <option key={item} value={item}>
              {LAYOUT_LABELS[item]}
            </option>
          ))}
        </select>
        <button onClick={() => props.onAdd(layout)} title="選択中のスライドの後ろに追加">
          追加
        </button>
      </div>
      <ol>
        {props.slides.map((slide, index) => {
          const result = props.validation.slides[index];
          const invalid = result !== undefined && !result.ok;
          const current = index === props.selected;
          return (
            <li key={slide.id} class={`${current ? "selected" : ""} ${invalid ? "invalid" : ""}`}>
              <button class="label" onClick={() => props.onSelect(index)}>
                <span class="num">{index + 1}</span>
                {slide.title.trim() === "" ? "（無題）" : slide.title}
                {invalid && " ⚠"}
                <span class="layout">
                  {LAYOUT_LABELS[slide.layout]}
                  {slide.name !== "" ? ` · ${slide.name}` : ""}
                </span>
              </button>
              {current && (
                <span class="ops">
                  <button title="上へ" disabled={index === 0} onClick={() => props.onMove(-1)}>
                    ↑
                  </button>
                  <button
                    title="下へ"
                    disabled={index === props.slides.length - 1}
                    onClick={() => props.onMove(1)}
                  >
                    ↓
                  </button>
                  <button title="複製" onClick={props.onDuplicate}>
                    ⧉
                  </button>
                  <button
                    title="削除"
                    class="danger"
                    disabled={props.slides.length <= 1}
                    onClick={props.onRemove}
                  >
                    ✕
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
