/** @jsxImportSource preact */
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SlideLayout } from "@canvcode/slides/core/slide-layout-spec";
import { api, ApiError, type AssetSummary, type DeckFormat, type DeckSummary } from "../api.ts";
import {
  breakCoalescing,
  canRedo,
  canUndo,
  createHistory,
  push,
  redo,
  undo,
  type History,
} from "../history.ts";
import { PreviewController } from "../preview.ts";
import {
  collectWarnings,
  deckFromData,
  deckToData,
  duplicateDraftSlide,
  insertSlide,
  moveSlide,
  newSlide,
  parseDeckText,
  previewData,
  removeSlide,
  replaceSlide,
  serializeDraft,
  validateDeck,
  type DraftDeck,
  type DraftSlide,
} from "../state.ts";
import { ExportDialog, type ExportOutcome } from "./ExportDialog.tsx";
import { Preview } from "./Preview.tsx";
import { ProblemsPanel } from "./ProblemsPanel.tsx";
import { SlideForm } from "./SlideForm.tsx";
import { SlideList } from "./SlideList.tsx";
import { SourceTab } from "./SourceTab.tsx";
import { Toolbar, type EditorTab, type StatusMessage } from "./Toolbar.tsx";
import { suggestAssetName } from "./ImagePicker.tsx";

type OpenDeck = {
  file: string;
  format: DeckFormat;
  mtimeMs: number;
  raw: string;
  canonical: boolean;
};

const CANONICAL_NOTICE =
  "このファイルは保存時に整形されます（コメント・GFM ヘッダー行・{layout=} などは失われます）。";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readUrlState(): { deck: string | null; slide: number } {
  const params = new URLSearchParams(window.location.search);
  const slide = Number(params.get("slide") ?? "1");
  return {
    deck: params.get("deck"),
    slide: Number.isInteger(slide) && slide > 0 ? slide - 1 : 0,
  };
}

function writeUrlState(deck: string | null, slide: number): void {
  const params = new URLSearchParams(window.location.search);
  const back = params.get("back");
  params.delete("slide");
  params.delete("deck");
  if (deck) {
    params.set("deck", deck);
    params.set("slide", String(slide + 1));
  }
  if (back) params.set("back", back);
  const query = params.toString();
  window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
}

function isTextInput(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export function App() {
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [assets, setAssets] = useState<AssetSummary[]>([]);
  const [open, setOpen] = useState<OpenDeck | null>(null);
  const [history, setHistory] = useState<History<DraftDeck> | null>(null);
  const [savedJson, setSavedJson] = useState("");
  const [selected, setSelected] = useState(0);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<EditorTab>("form");
  const [sourceText, setSourceText] = useState("");
  const [sourceApplied, setSourceApplied] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportOutcome, setExportOutcome] = useState<ExportOutcome | null>(null);
  const previewRef = useRef(new PreviewController());
  /** ソースタブが最後に同期した下書き（undo/redo で変わったら再生成する） */
  const sourceDraftRef = useRef<DraftDeck | null>(null);

  const draft = history?.present ?? null;
  const validation = useMemo(() => (draft ? validateDeck(draft) : null), [draft]);
  const warnings = useMemo(() => (validation ? collectWarnings(validation) : []), [validation]);
  const dirty = draft !== null && JSON.stringify(deckToData(draft)) !== savedJson;
  const sourcePending = tab === "source" && sourceText !== sourceApplied;
  const canSave = Boolean(open && validation?.deck.ok && (dirty || sourcePending) && !saving);
  const canExport = Boolean(open && validation?.deck.ok && !saving);
  const currentValidation = validation?.slides[selected] ?? null;
  const currentSlide = draft?.slides[selected] ?? null;

  const refreshDecks = useCallback(async () => {
    try {
      setDecks(await api.listDecks());
    } catch (error) {
      setStatus({ kind: "error", text: errorText(error) });
    }
  }, []);

  const refreshAssets = useCallback(async (file: string) => {
    try {
      setAssets(await api.listAssets(file));
    } catch (error) {
      setStatus({ kind: "error", text: errorText(error) });
    }
  }, []);

  const loadDeck = useCallback(async (file: string, slideIndex = 0) => {
    try {
      const response = await api.getDeck(file);
      setOpen({
        file,
        format: response.format,
        mtimeMs: response.mtimeMs,
        raw: response.raw,
        canonical: response.canonical,
      });
      setTab("form");
      setSourceText("");
      setSourceApplied("");
      sourceDraftRef.current = null;
      if (response.deck) {
        const loaded = deckFromData(response.deck);
        setHistory(createHistory(loaded));
        setSavedJson(JSON.stringify(deckToData(loaded)));
        setSelected(Math.max(0, Math.min(slideIndex, loaded.slides.length - 1)));
        setLoadError(null);
        setPreviewError(null);
        setStatus(response.canonical ? null : { kind: "info", text: CANONICAL_NOTICE });
      } else {
        setHistory(null);
        setSavedJson("");
        setLoadError(response.error ?? "デッキを読み込めませんでした。");
        setSourceText(response.raw);
        setSourceApplied("");
        setTab("source");
        setStatus(null);
      }
    } catch (error) {
      setStatus({ kind: "error", text: errorText(error) });
    }
  }, []);

  useEffect(() => {
    void refreshDecks();
    const initial = readUrlState();
    if (initial.deck) {
      void loadDeck(initial.deck, initial.slide);
    }
  }, [refreshDecks, loadDeck]);

  useEffect(() => {
    if (open?.file) void refreshAssets(open.file);
  }, [open?.file, refreshAssets]);

  useEffect(() => {
    writeUrlState(open?.file ?? null, selected);
  }, [open?.file, selected]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent): void => {
      if (dirty || sourcePending) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty, sourcePending]);

  useEffect(() => {
    previewRef.current.onResult = (result) => {
      setPreviewError(result.ok ? null : (result.message ?? "プレビューを描画できませんでした。"));
    };
  }, []);

  useEffect(() => {
    if (!open || !currentValidation || !currentValidation.ok) return;
    const data = previewData(currentValidation.data, selected, (assetPath) =>
      api.assetUrl(open.file, assetPath),
    );
    const timer = window.setTimeout(() => previewRef.current.render(data), 120);
    return () => window.clearTimeout(timer);
  }, [open, currentValidation, selected]);

  // ---- 下書きの更新 ----

  const update = useCallback((fn: (deck: DraftDeck) => DraftDeck, key: string | null = null) => {
    setHistory((current) => (current ? push(current, fn(current.present), key) : current));
  }, []);

  const updateSlide = useCallback(
    (index: number, fn: (slide: DraftSlide) => DraftSlide, key: string | null) =>
      update((deck) => replaceSlide(deck, index, fn), key),
    [update],
  );

  const doUndo = useCallback(() => setHistory((current) => (current ? undo(current) : current)), []);
  const doRedo = useCallback(() => setHistory((current) => (current ? redo(current) : current)), []);
  const commitEdits = useCallback(
    () => setHistory((current) => (current ? breakCoalescing(current) : current)),
    [],
  );

  // ---- ソースタブ ----

  const sourceNotice = open && !open.canonical ? CANONICAL_NOTICE : null;

  const validateSource = useCallback(
    (text: string): string | null => {
      if (!open) return null;
      try {
        parseDeckText(text, open.format, open.file);
        return null;
      } catch (error) {
        return errorText(error);
      }
    },
    [open],
  );

  /** ソースをフォームに反映する。成功時は新しい下書きを返す */
  const applySource = useCallback((): { draft: DraftDeck } | { error: string } => {
    if (!open) return { error: "デッキが開かれていません。" };
    try {
      const next = deckFromData(parseDeckText(sourceText, open.format, open.file));
      sourceDraftRef.current = next;
      setHistory((current) => (current ? push(current, next) : createHistory(next)));
      setSourceApplied(sourceText);
      setLoadError(null);
      setSelected((current) => Math.max(0, Math.min(current, next.slides.length - 1)));
      return { draft: next };
    } catch (error) {
      return { error: errorText(error) };
    }
  }, [open, sourceText]);

  const enterSourceTab = useCallback(() => {
    if (!open || !draft) return;
    let text: string;
    if (!dirty) {
      text = open.raw;
    } else {
      try {
        text = serializeDraft(draft, open.file);
      } catch (error) {
        setStatus({ kind: "error", text: errorText(error) });
        return;
      }
    }
    sourceDraftRef.current = draft;
    setSourceText(text);
    setSourceApplied(text);
    setTab("source");
  }, [open, draft, dirty]);

  const enterFormTab = useCallback(() => {
    if (loadError) {
      setStatus({ kind: "error", text: "ソースを修正して「適用」してからフォームに切り替えてください。" });
      return;
    }
    if (sourcePending) {
      const result = applySource();
      if ("error" in result) {
        if (
          !window.confirm(
            `ソースにエラーがあります:\n${result.error}\n\n未適用の変更を破棄してフォームに戻りますか？`,
          )
        ) {
          return;
        }
      }
    }
    setTab("form");
  }, [loadError, sourcePending, applySource]);

  // undo / redo などでソースタブの外から下書きが変わったら、ソースを作り直す
  useEffect(() => {
    if (tab !== "source" || !open || !draft || draft === sourceDraftRef.current) return;
    try {
      const text = serializeDraft(draft, open.file);
      sourceDraftRef.current = draft;
      setSourceText(text);
      setSourceApplied(text);
    } catch {
      // 往復できない内容は表示を更新しない（保存時にエラーになる）
    }
  }, [tab, open, draft]);

  // ---- 保存・出力 ----

  const performSave = useCallback(
    async (target: DraftDeck): Promise<boolean> => {
      if (!open) return false;
      const data = deckToData(target);
      setSaving(true);
      try {
        let result;
        try {
          result = await api.saveDeck(open.file, data, open.mtimeMs);
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) {
            if (!window.confirm(`${error.message}\n\nこの内容で上書きしますか？`)) {
              setStatus({ kind: "error", text: "保存を中止しました。" });
              return false;
            }
            result = await api.saveDeck(open.file, data, open.mtimeMs, true);
          } else {
            throw error;
          }
        }
        setOpen({ ...open, mtimeMs: result.mtimeMs, raw: result.text, canonical: true });
        setSavedJson(JSON.stringify(data));
        setStatus({
          kind: "success",
          text:
            result.warnings.length > 0
              ? `保存しました（出力時の警告 ${result.warnings.length} 件）`
              : "保存しました",
        });
        void refreshDecks();
        return true;
      } catch (error) {
        setStatus({ kind: "error", text: errorText(error) });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [open, refreshDecks],
  );

  /** ソースタブの未適用分を反映してから保存する */
  const save = useCallback(async (): Promise<boolean> => {
    if (!open) return false;
    let target = draft;
    if (tab === "source" && (sourcePending || loadError)) {
      const result = applySource();
      if ("error" in result) {
        setStatus({ kind: "error", text: result.error });
        return false;
      }
      target = result.draft;
    }
    if (!target) return false;
    const check = validateDeck(target);
    if (!check.deck.ok) {
      setStatus({ kind: "error", text: check.deck.error });
      return false;
    }
    return performSave(target);
  }, [open, draft, tab, sourcePending, loadError, applySource, performSave]);

  const exportDeck = useCallback(
    async (format: "pdf" | "png") => {
      if (!open || exporting) return;
      if (dirty || sourcePending) {
        const saved = await save();
        if (!saved) return;
      }
      setExporting(true);
      setStatus({ kind: "info", text: `${format.toUpperCase()} を出力しています…` });
      try {
        const result = await api.exportDeck(open.file, format);
        setExportOutcome({ format, ...result });
        setStatus({ kind: "success", text: `${format.toUpperCase()} を出力しました` });
      } catch (error) {
        setStatus({ kind: "error", text: errorText(error) });
      } finally {
        setExporting(false);
      }
    },
    [open, exporting, dirty, sourcePending, save],
  );

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        if (canSave) void save();
        return;
      }
      if (isTextInput(event.target)) return;
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        doUndo();
      } else if (key === "y" || (key === "z" && event.shiftKey)) {
        event.preventDefault();
        doRedo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [canSave, save, doUndo, doRedo]);

  // ---- デッキ・スライドの操作 ----

  const openDeck = useCallback(
    (file: string) => {
      if (file === open?.file) return;
      if ((dirty || sourcePending) && !window.confirm("未保存の変更があります。破棄して別のデッキを開きますか？")) {
        return;
      }
      void loadDeck(file);
    },
    [open?.file, dirty, sourcePending, loadDeck],
  );

  const createDeck = useCallback(async () => {
    const name = window.prompt(
      "新しいデッキのファイル名（英数字・-・_ と拡張子 .md / .json）",
      "new-deck.md",
    );
    if (!name) return;
    if ((dirty || sourcePending) && !window.confirm("未保存の変更があります。破棄して新しいデッキを作りますか？")) {
      return;
    }
    try {
      const created = await api.createDeck(name.trim());
      await refreshDecks();
      await loadDeck(created.file);
    } catch (error) {
      setStatus({ kind: "error", text: errorText(error) });
    }
  }, [dirty, sourcePending, refreshDecks, loadDeck]);

  const importDeck = useCallback(async (files: File[]) => {
    if ((dirty || sourcePending) && !window.confirm("未保存の変更があります。破棄してデッキを読み込みますか？")) return;
    try {
      const deckFiles = files.filter((file) => /\.(?:slide\.)?(?:md|json)$/i.test(file.name));
      if (deckFiles.length !== 1) throw new Error("デッキファイルを 1 つ選んでください（画像も一緒に選べます）。");
      const deckFile = deckFiles[0];
      if (!deckFile) return;
      const imageFiles = files.filter((file) => /\.(?:png|jpe?g|webp|svg)$/i.test(file.name));
      if (new Set(imageFiles.map((file) => file.name)).size !== imageFiles.length) {
        throw new Error("同じ名前の画像が複数あります。別々に読み込んでください。");
      }
      const uploads = imageFiles.map((file) => ({ file, name: suggestAssetName(file.name) }));
      if (new Set(uploads.map(({ name }) => name.toLowerCase())).size !== uploads.length) {
        throw new Error("取り込み後に同じ名前になる画像があります。名前を変えてから読み込んでください。");
      }
      const created = await api.importDeck(
        deckFile.name,
        await deckFile.text(),
        uploads.map(({ file, name }) => ({ sourceName: file.name, name })),
      );
      const failedAssets: string[] = [];
      for (const { file, name } of uploads) {
        try {
          try {
            await api.uploadAsset(created.file, name, file);
          } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 409 || !window.confirm(`${name} は既に assets/ にあります。上書きしますか？`)) throw error;
            await api.uploadAsset(created.file, name, file, true);
          }
        } catch {
          failedAssets.push(name);
        }
      }
      await refreshDecks();
      await loadDeck(created.file);
      if (failedAssets.length > 0) setStatus({ kind: "error", text: `デッキは読み込みました。画像 ${failedAssets.join(", ")} は取り込めませんでした。` });
    } catch (error) {
      setStatus({ kind: "error", text: errorText(error) });
    }
  }, [dirty, sourcePending, refreshDecks, loadDeck]);

  const addSlide = useCallback(
    (layout: SlideLayout) => {
      if (!draft) return;
      const index = Math.min(selected + 1, draft.slides.length);
      update((deck) => insertSlide(deck, index, newSlide(layout)));
      setSelected(index);
    },
    [draft, selected, update],
  );

  const duplicateSlide = useCallback(() => {
    if (!draft) return;
    const source = draft.slides[selected];
    if (!source) return;
    update((deck) => insertSlide(deck, selected + 1, duplicateDraftSlide(source)));
    setSelected(selected + 1);
  }, [draft, selected, update]);

  const deleteSlide = useCallback(() => {
    if (!draft || draft.slides.length <= 1) return;
    const target = draft.slides[selected];
    if (!target) return;
    if (!window.confirm(`スライド ${selected + 1}「${target.title}」を削除しますか？`)) return;
    update((deck) => removeSlide(deck, selected));
    setSelected(Math.max(0, Math.min(selected, draft.slides.length - 2)));
  }, [draft, selected, update]);

  const shiftSlide = useCallback(
    (delta: -1 | 1) => {
      if (!draft) return;
      const target = selected + delta;
      if (target < 0 || target >= draft.slides.length) return;
      update((deck) => moveSlide(deck, selected, target));
      setSelected(target);
    },
    [draft, selected, update],
  );

  // ---- 描画 ----

  const sourceView = open ? (
    <SourceTab
      format={open.format}
      text={sourceText}
      notice={loadError ? `読み込みエラー: ${loadError}` : sourceNotice}
      onTextChange={setSourceText}
      validate={validateSource}
      onApply={() => {
        const result = applySource();
        return "error" in result ? result.error : null;
      }}
      pending={sourcePending || loadError !== null}
    />
  ) : null;

  return (
    <div class="app">
      <Toolbar
        decks={decks}
        openFile={open?.file ?? null}
        dirty={dirty || sourcePending}
        canSave={canSave}
        saving={saving}
        onSave={() => void save()}
        canUndo={history ? canUndo(history) : false}
        canRedo={history ? canRedo(history) : false}
        onUndo={doUndo}
        onRedo={doRedo}
        onOpenDeck={openDeck}
        onCreateDeck={() => void createDeck()}
        onImport={(file) => void importDeck(file)}
        tab={tab}
        onTab={(next) => (next === "source" ? enterSourceTab() : enterFormTab())}
        sourceDisabled={!loadError && !validation?.deck.ok}
        canExport={canExport}
        exporting={exporting}
        onExport={(format) => void exportDeck(format)}
        status={status}
        onClose={() => {
          const back = new URLSearchParams(window.location.search).get("back");
          let destination = "/";
          if (back) {
            try {
              const target = new URL(back, window.location.origin);
              if (target.origin === window.location.origin) destination = `${target.pathname}${target.search}${target.hash}`;
            } catch {
              destination = "/";
            }
          }
          window.location.href = destination;
        }}
      />
      {!open ? (
        <div class="empty-state">
          <p>上のメニューからデッキを選ぶか、「新規」または「読み込み」で用意してください。</p>
        </div>
      ) : loadError ? (
        <div class="workspace">
          <div class="slide-list" />
          <div class="form-pane">{sourceView}</div>
          <div class="preview-pane">
            <div class="banner error">
              ファイルを解釈できないためフォームを表示できません。ソースを修正して「適用」してください。
            </div>
          </div>
        </div>
      ) : draft && validation && currentSlide ? (
        <div class="workspace">
          <SlideList
            slides={draft.slides}
            validation={validation}
            selected={selected}
            onSelect={setSelected}
            onAdd={addSlide}
            onDuplicate={duplicateSlide}
            onRemove={deleteSlide}
            onMove={shiftSlide}
          />
          <div class="form-pane">
            {tab === "source" ? (
              sourceView
            ) : (
              <SlideForm
                key={currentSlide.id}
                slide={currentSlide}
                deckFile={open.file}
                assets={assets}
                onChange={(fn, key) => updateSlide(selected, fn, key)}
                onBlur={commitEdits}
                onAssetsChanged={() => { if (open) void refreshAssets(open.file); }}
              />
            )}
          </div>
          <div class="preview-pane">
            <Preview
              controller={previewRef.current}
              error={currentValidation && !currentValidation.ok ? currentValidation.error : previewError}
            />
            <ProblemsPanel validation={validation} warnings={warnings} onSelect={setSelected} />
          </div>
        </div>
      ) : null}
      {exportOutcome && <ExportDialog outcome={exportOutcome} onClose={() => setExportOutcome(null)} />}
    </div>
  );
}
