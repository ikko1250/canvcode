/** @jsxImportSource preact */
import type { DeckSummary } from "../api.ts";

export type StatusMessage = { kind: "info" | "error" | "success"; text: string };
export type EditorTab = "form" | "source";

type Props = {
  decks: DeckSummary[];
  openFile: string | null;
  dirty: boolean;
  canSave: boolean;
  saving: boolean;
  onSave: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onOpenDeck: (file: string) => void;
  onCreateDeck: () => void;
  onImport: (files: File[]) => void;
  tab: EditorTab;
  onTab: (tab: EditorTab) => void;
  /** フォームが検証エラーのときソースタブへ切り替えられない */
  sourceDisabled: boolean;
  canExport: boolean;
  exporting: boolean;
  onExport: (format: "pdf" | "png") => void;
  status: StatusMessage | null;
  onClose: () => void;
};

export function Toolbar(props: Props) {
  const hasDeck = props.openFile !== null;
  return (
    <header class="toolbar">
      <span class="title">スライドエディタ</span>
      <button onClick={props.onClose}>キャンバスへ戻る</button>
      <div class="group">
        <select
          aria-label="デッキ"
          value={props.openFile ?? ""}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value) props.onOpenDeck(value);
          }}
        >
          <option value="">デッキを選択…</option>
          {props.decks.map((deck) => (
            <option key={deck.file} value={deck.file}>
              {deck.title ?? deck.file}
            </option>
          ))}
        </select>
        <button onClick={props.onCreateDeck}>新規</button>
        <label class="button-like">
          読み込み
          <input
            type="file"
            accept=".md,.json,.slide.md,.slide.json,.png,.jpg,.jpeg,.webp,.svg,application/json,text/markdown,image/*"
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              if (files.length > 0) props.onImport(files);
            }}
          />
        </label>
      </div>
      <div class="group">
        <button class="save primary" disabled={!props.canSave} onClick={props.onSave} title="Ctrl+S">
          {props.saving ? "保存中…" : "保存"}
        </button>
        <button disabled={!props.canUndo} onClick={props.onUndo} title="元に戻す (Ctrl+Z)">
          ↶ 元に戻す
        </button>
        <button disabled={!props.canRedo} onClick={props.onRedo} title="やり直す (Ctrl+Y)">
          ↷ やり直す
        </button>
        {props.dirty && <span class="dirty">● 未保存</span>}
      </div>
      <div class="group tabs" role="tablist">
        <button
          role="tab"
          class={props.tab === "form" ? "active" : ""}
          disabled={!hasDeck}
          onClick={() => props.onTab("form")}
        >
          フォーム
        </button>
        <button
          role="tab"
          class={props.tab === "source" ? "active" : ""}
          disabled={!hasDeck || props.sourceDisabled}
          title={props.sourceDisabled ? "フォームの検証エラーを直してから切り替えてください" : ""}
          onClick={() => props.onTab("source")}
        >
          ソース
        </button>
      </div>
      <div class="group">
        <button
          class="export-pdf"
          disabled={!props.canExport || props.exporting}
          onClick={() => props.onExport("pdf")}
          title="保存してから PDF を出力"
        >
          {props.exporting ? "出力中…" : "PDF 出力"}
        </button>
        <button
          class="export-png"
          disabled={!props.canExport || props.exporting}
          onClick={() => props.onExport("png")}
          title="保存してから PNG を出力"
        >
          PNG 出力
        </button>
      </div>
      <span class="spacer" />
      {props.status && <span class={`status ${props.status.kind}`}>{props.status.text}</span>}
    </header>
  );
}
