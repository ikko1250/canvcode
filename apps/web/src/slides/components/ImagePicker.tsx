/** @jsxImportSource preact */
import { useEffect, useId, useState } from "preact/hooks";
import { api, ApiError, type AssetSummary } from "../api.ts";
import type { DraftImage } from "../state.ts";

const CUSTOM = "__custom__";
const ASSET_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,78}[A-Za-z0-9])?\.(png|jpe?g|webp|svg)$/i;

/** サーバーが受け付ける ASCII 名に寄せる（日本語名などは置換） */
export function suggestAssetName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "png";
  const ascii = base
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
    .slice(0, 60);
  return `${ascii === "" ? "image" : ascii}.${extension}`;
}

type Props = {
  label?: string;
  value: DraftImage;
  showTitle: boolean;
  deckFile: string;
  assets: AssetSummary[];
  onChange: (value: DraftImage, key: string | null) => void;
  onAssetsChanged: () => void;
};

export function ImagePicker(props: Props) {
  const { value, onChange } = props;
  const id = useId();
  const [broken, setBroken] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const known = props.assets.some((asset) => asset.path === value.path);

  useEffect(() => {
    setBroken(false);
  }, [value.path, props.deckFile]);

  const upload = async (file: File): Promise<void> => {
    let name = file.name;
    if (!ASSET_NAME_PATTERN.test(name)) {
      const entered = window.prompt(
        "画像名は英数字・ハイフン・アンダースコアのみ使えます。保存する名前を入力してください。",
        suggestAssetName(file.name),
      );
      if (!entered) return;
      name = entered.trim();
    }

    setUploading(true);
    setUploadError(null);
    try {
      let result;
      try {
        result = await api.uploadAsset(props.deckFile, name, file);
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          if (!window.confirm(`${name} は既に assets/ にあります。上書きしますか？`)) return;
          result = await api.uploadAsset(props.deckFile, name, file, true);
        } else {
          throw error;
        }
      }
      props.onAssetsChanged();
      const fallbackAlt = name.replace(/\.[^.]+$/, "");
      onChange({ ...value, path: result.path, alt: value.alt === "" ? fallbackAlt : value.alt }, null);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div class="image-picker">
      {props.label && (
        <div class="field">
          <strong>{props.label}</strong>
        </div>
      )}
      <div class="field">
        <label>
          画像ファイル
          <span class="hint">assets/ から選ぶか、デッキファイルからの相対パスを入力</span>
        </label>
        <select
          aria-label="assets の画像"
          value={known ? value.path : CUSTOM}
          onChange={(event) => {
            const selected = event.currentTarget.value;
            if (selected !== CUSTOM) onChange({ ...value, path: selected }, null);
          }}
        >
          <option value={CUSTOM}>
            {value.path === "" ? "（未選択）" : known ? "（直接入力）" : `（直接入力: ${value.path}）`}
          </option>
          {props.assets.map((asset) => (
            <option key={asset.name} value={asset.path}>
              {asset.name}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={value.path}
          placeholder="../assets/figure.png"
          onInput={(event) => onChange({ ...value, path: event.currentTarget.value }, `${id}:path`)}
        />
      </div>

      <div class="upload">
        <label>
          アップロード:
          <input
            type="file"
            accept=".png,.jpg,.jpeg,.webp,.svg,image/png,image/jpeg,image/webp,image/svg+xml"
            disabled={uploading}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void upload(file);
            }}
          />
        </label>
        {uploading && <span class="hint">送信中…</span>}
      </div>
      {uploadError && <div class="banner error">{uploadError}</div>}

      {value.path === "" ? (
        <div class="missing">画像が未選択です。</div>
      ) : broken ? (
        <div class="missing">画像を読み込めません: {value.path}</div>
      ) : (
        <img
          class="thumb"
          src={api.assetUrl(props.deckFile, value.path)}
          alt=""
          onError={() => setBroken(true)}
        />
      )}

      <div class="field">
        <label>alt（代替テキスト）</label>
        <input
          type="text"
          value={value.alt}
          onInput={(event) => onChange({ ...value, alt: event.currentTarget.value }, `${id}:alt`)}
        />
      </div>
      {props.showTitle && (
        <div class="field">
          <label>図タイトル</label>
          <input
            type="text"
            value={value.title}
            onInput={(event) => onChange({ ...value, title: event.currentTarget.value }, `${id}:title`)}
          />
        </div>
      )}
      {value.path !== "" && <FigureAdjust id={id} value={value} onChange={onChange} />}
    </div>
  );
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.05;
const OFFSET_MIN = -100;
const OFFSET_MAX = 100;
const OFFSET_STEP = 1;

function clampRound(value: number, min: number, max: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return Math.min(max, Math.max(min, rounded));
}

type AdjustProps = {
  id: string;
  value: DraftImage;
  onChange: (value: DraftImage, key: string | null) => void;
};

/** 図の拡大率・位置を調整する行（拡大／横位置／縦位置）。範囲外にはみ出た部分は描画時に切り取られる */
function FigureAdjust(props: AdjustProps) {
  const { id, value, onChange } = props;
  const isDefault = value.zoom === 1 && value.x === 0 && value.y === 0;

  const change = (field: "zoom" | "x" | "y", min: number, max: number, decimals: number) =>
    (event: Event) => {
      const raw = Number((event.currentTarget as HTMLInputElement).value);
      if (!Number.isFinite(raw)) return;
      const next = clampRound(raw, min, max, decimals);
      onChange({ ...value, [field]: next }, `${id}:${field}`);
    };

  return (
    <div class="field figure-adjust">
      <div class="figure-adjust-row">
        <label>拡大</label>
        <input
          type="range"
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={ZOOM_STEP}
          value={value.zoom}
          onInput={change("zoom", ZOOM_MIN, ZOOM_MAX, 2)}
        />
        <input
          type="number"
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={ZOOM_STEP}
          value={value.zoom}
          onInput={change("zoom", ZOOM_MIN, ZOOM_MAX, 2)}
        />
      </div>
      <div class="figure-adjust-row">
        <label>横位置</label>
        <input
          type="range"
          min={OFFSET_MIN}
          max={OFFSET_MAX}
          step={OFFSET_STEP}
          value={value.x}
          onInput={change("x", OFFSET_MIN, OFFSET_MAX, 0)}
        />
        <input
          type="number"
          min={OFFSET_MIN}
          max={OFFSET_MAX}
          step={OFFSET_STEP}
          value={value.x}
          onInput={change("x", OFFSET_MIN, OFFSET_MAX, 0)}
        />
      </div>
      <div class="figure-adjust-row">
        <label>縦位置</label>
        <input
          type="range"
          min={OFFSET_MIN}
          max={OFFSET_MAX}
          step={OFFSET_STEP}
          value={value.y}
          onInput={change("y", OFFSET_MIN, OFFSET_MAX, 0)}
        />
        <input
          type="number"
          min={OFFSET_MIN}
          max={OFFSET_MAX}
          step={OFFSET_STEP}
          value={value.y}
          onInput={change("y", OFFSET_MIN, OFFSET_MAX, 0)}
        />
      </div>
      <div class="figure-adjust-footer">
        <button
          type="button"
          disabled={isDefault}
          onClick={() => onChange({ ...value, zoom: 1, x: 0, y: 0 }, `${id}:reset`)}
        >
          リセット
        </button>
        <span class="hint">枠からはみ出た部分は切り取られます</span>
      </div>
    </div>
  );
}
