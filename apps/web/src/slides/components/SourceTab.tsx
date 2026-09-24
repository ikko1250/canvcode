/** @jsxImportSource preact */
import { useEffect, useState } from "preact/hooks";
import type { DeckFormat } from "../api.ts";

type Props = {
  format: DeckFormat;
  text: string;
  /** 元ファイルが保存時に整形される（コメント等が失われる）とき true */
  notice: string | null;
  onTextChange: (text: string) => void;
  /** 適用せずに検証だけ行い、エラー文字列（なければ null）を返す */
  validate: (text: string) => string | null;
  /** 適用する。エラー文字列（なければ null）を返す */
  onApply: () => string | null;
  /** テキストが最後に適用した内容と異なるか */
  pending: boolean;
};

const VALIDATE_DELAY_MS = 400;

export function SourceTab(props: Props) {
  const { text, validate } = props;
  const [error, setError] = useState<string | null>(null);
  const [applyMessage, setApplyMessage] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setError(validate(text)), VALIDATE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [text, validate]);

  const apply = (): void => {
    const result = props.onApply();
    setError(result);
    setApplyMessage(result ? null : "フォームに反映しました。");
  };

  return (
    <div class="source">
      <div class="bar">
        <strong>{props.format === "md" ? "Markdown" : "JSON"} ソース</strong>
        <span class="hint">編集後に「適用」（Ctrl+Enter）でフォームとプレビューに反映します。保存時は自動で適用されます。</span>
        <span class="spacer" />
        <button class="primary" disabled={!props.pending || error !== null} onClick={apply}>
          適用
        </button>
      </div>
      {props.notice && <div class="banner info">{props.notice}</div>}
      <textarea
        name="source"
        spellcheck={false}
        value={text}
        onInput={(event) => {
          setApplyMessage(null);
          props.onTextChange(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            if (props.pending && error === null) apply();
          }
        }}
      />
      <div class="bar">
        {error ? (
          <span class="banner error">{error}</span>
        ) : applyMessage ? (
          <span class="banner info">{applyMessage}</span>
        ) : props.pending ? (
          <span class="hint">未適用の変更があります。</span>
        ) : (
          <span class="hint">フォームと同期しています。</span>
        )}
      </div>
    </div>
  );
}
