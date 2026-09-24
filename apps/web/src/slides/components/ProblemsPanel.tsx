/** @jsxImportSource preact */
import type { DeckValidation, SlideWarning } from "../state.ts";

type Props = {
  validation: DeckValidation;
  warnings: SlideWarning[];
  onSelect: (index: number) => void;
};

export function ProblemsPanel({ validation, warnings, onSelect }: Props) {
  const errors = validation.slides.flatMap((slide, index) =>
    slide.ok ? [] : [{ index, text: slide.error }],
  );
  const deckError = !validation.deck.ok && errors.length === 0 ? validation.deck.error : null;
  const errorCount = errors.length + (deckError ? 1 : 0);

  return (
    <div class="problems" aria-live="polite">
      <h3>
        エラー {errorCount} 件 ・ 警告 {warnings.length} 件
      </h3>
      {errorCount === 0 && warnings.length === 0 ? (
        <div class="empty">問題はありません。</div>
      ) : (
        <ul>
          {deckError && <li class="error">{deckError}</li>}
          {errors.map((item) => (
            <li class="error" key={`e${item.index}`}>
              <button onClick={() => onSelect(item.index)}>スライド {item.index + 1}</button>
              {item.text}
            </li>
          ))}
          {warnings.map((item, i) => (
            <li class="warning" key={`w${i}`}>
              <button onClick={() => onSelect(item.index)}>スライド {item.index + 1}</button>
              {item.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
