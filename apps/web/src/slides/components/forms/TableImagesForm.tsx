/** @jsxImportSource preact */
import type { AssetSummary } from "../../api.ts";
import type { DraftImage, DraftSlide } from "../../state.ts";
import { ImagePicker } from "../ImagePicker.tsx";
import type { SlideChange } from "../SlideForm.tsx";

type Props = {
  slide: DraftSlide;
  deckFile: string;
  assets: AssetSummary[];
  onChange: SlideChange;
  onAssetsChanged: () => void;
};

export function TableImagesForm({ slide, deckFile, assets, onChange, onAssetsChanged }: Props) {
  const setImage = (index: 0 | 1, image: DraftImage, key: string | null): void =>
    onChange(
      (current) => ({
        ...current,
        images: index === 0 ? [image, current.images[1]] : [current.images[0], image],
      }),
      key,
    );

  return (
    <>
      <div class="section">
        下部の 2 図
        <span class="count">図タイトルは必須</span>
      </div>
      <ImagePicker
        label="図 1（左）"
        value={slide.images[0]}
        showTitle={true}
        deckFile={deckFile}
        assets={assets}
        onChange={(image, key) => setImage(0, image, key)}
        onAssetsChanged={onAssetsChanged}
      />
      <ImagePicker
        label="図 2（右）"
        value={slide.images[1]}
        showTitle={true}
        deckFile={deckFile}
        assets={assets}
        onChange={(image, key) => setImage(1, image, key)}
        onAssetsChanged={onAssetsChanged}
      />
    </>
  );
}
