# PDF のページの画像の用意（全体表示と拡大表示）

Issue #26。大きい PDF（例：RESONAC REPORT 2026、16.1 MB・72 ページ・埋め込みの画像 1044 枚）を置いた Canvas で、ページが出るまでに時間がかかる。原因と測った値は Issue に書いた。ここでは直し方を決める。

## 目的

最初の画面はほぼ 2 通りで、要るものが違う。

| | A. 全体表示（初めて・久しぶりに開く） | B. 拡大表示（読んで、閉じて、戻る） |
|---|---|---|
| 見えるページ | すべて | 1〜2 ページ |
| 要る解像度（Retina） | 1 ページ 120px 程度 | 1 ページ 約 2900px |
| 目標 | PDF も PDF.js も読まずに、1 秒ほどで全ページを出す | 前に見た状態なら、すぐくっきり出す。初めてでも、ページの中身はすぐ見えるようにする |

Canvas ごとのカメラはブラウザに保存してある（`apps/web/src/App.tsx` の `savedCamera`）ので、開く前に A か B か、B ならどのページかが分かる。

## 全体の形

ページの画像を 3 段にする。上の段ほどくっきりしていて、作るのに手間がかかる。

| 段 | 解像度 | 作る場所・時 | 置き場所 | 使う倍率（1 単位あたりの画素数） |
|---|---|---|---|---|
| 1. 縮小画像のシート | 長辺 256px | サーバー。取り込んだあと裏で | サーバー（`<ハッシュ>.preview-v1.*`） | 約 0.17 以下（A） |
| 2. 中くらいの画像 | 長辺 1024px | サーバー。1 のあとに裏で | サーバー（同上） | 約 0.7 以下。それより上では、PDF.js で描くまでの仮の表示 |
| 3. PDF.js で描いた画像 | 倍率どおり（level 1・2・4） | ブラウザ。表示するとき | メモリー。最後に見たページの分だけ IndexedDB にも置く（B） | それより上 |

ページの画像はすべて、今と同じ画像キャッシュ（`ImageCache`）のキー `${assetId}#${pageIndex}` に、解像度ごとに入れる。画像キャッシュは手元にあるいちばん近い解像度の画像を出す（`nearestLevel`）ので、上の段ができるまでは下の段の画像が出る。

Range リクエストへの対応（後述の 4）は、3 を初めて描くときの待ち時間を短くする。

## 1. サーバーで縮小画像と中くらいの画像を作る

### 描き方：poppler（pdftoppm）を使う

サーバーの PDF.js（`@napi-rs/canvas`）でも描けるが、埋め込まれていない日本語フォント（MS-Gothic・HeiseiMin など。EDINET の書類に多い）の文字が出ない。ブラウザでは OS のフォントで描けるが、Node ではフォントがないので文字が抜ける（`6a6ca694…` の有価証券報告書で、日本語がすべて消えることを確かめた）。

poppler の `pdftoppm` は fontconfig から OS のフォント（Noto CJK など）を使うので、文字が出る。速さも PDF.js より速い。RESONAC で測った値：

| | pdftoppm | PDF.js（Node） |
|---|---|---|
| 長辺 256px・72 ページ | 10.7 秒 | 27.2 秒 |
| 長辺 1024px・12 ページ | 5.9 秒 | 8.1 秒 |
| メモリー | 約 30 MB（別のプロセス） | サーバーのプロセスの中 |

別のプロセスで動くので、サーバーのイベントループを止めない（PDF.js を Node で使うと、Worker を立てない限りメインスレッドで描く）。

- `pdftoppm` は OS のパッケージ（`apt install poppler-utils`）。起動したときに `pdftoppm -v` で確かめ、なければ一度だけログに出して、段 1・2 を作らない（今までどおり PDF.js で描く）。README の準備の節に書き足す。
- `nice -n 10` で動かし、1 度に 1 つの PDF だけ扱う。1 つの PDF に 10 分以上かかったら止める。

### 作るもの

1. `pdftoppm -scale-to 256 -png <PDF> <一時フォルダ>/p` で全ページを描く。
2. `@napi-rs/canvas` で、ページの画像を幅 4096px までのシートに並べ、WebP（品質 80）にする。シートの高さも 4096px までとし、超えたら次のシートにする（横長のページで 1 シート 400 ページほど）。RESONAC で 4096×805・**611 KB**、並べるのに 0.5 秒。
3. 1 のページの大きさ（ポイント、回転したあと）は `pdfinfo -f 1 -l <ページ数>` で読む。
4. マニフェストを書く（下）。ここで段 1 が使えるようになる。
5. `pdftoppm -scale-to 1024` で全ページを描き、ページごとに WebP にする（RESONAC で 1 ページ 約 100 KB、72 ページで約 7 MB）。終わったらマニフェストに `mid` を足して書き直す。

`@napi-rs/canvas` は今は `pdfjs-dist` の optionalDependencies で入っているだけなので、`apps/server/package.json` の dependencies に足す。

### ファイル

`.canvcode/assets/` に、ほかの派生ファイルと同じく `<ハッシュ>.` で始まる名前で置く。Asset の片付け（`assetGc.ts` の `ASSET_FILE`）が、そのまま原本と一緒に消す。

- `<ハッシュ>.preview-v1.json`：マニフェスト
- `<ハッシュ>.preview-v1.sheet<N>.webp`：縮小画像のシート
- `<ハッシュ>.preview-v1.p<ページ>.webp`：中くらいの画像（ページは 0 から）

描き方を変えて作り直すときは、`v1` を上げる（古い版は、起動したときに消す）。

マニフェスト：

```json
{
  "version": 1,
  "pages": [{ "w": 1114.02, "h": 685.98 }],
  "sheets": [{ "width": 4096, "height": 805 }],
  "thumbs": [{ "sheet": 0, "x": 0, "y": 0, "w": 256, "h": 158 }],
  "mid": { "size": 1024 }
}
```

- `pages`：ページの大きさ（ポイント、回転したあと）。`thumbs` と同じ順番
- `mid`：段 2 ができていれば付ける

### 作る順番

- PDF を受け取ったとき（`storeOriginal`。テキストの取り出しと同じ所）に、順番待ちの後ろに入れる。
- 起動したときに、マニフェストのない PDF をすべて順番待ちに入れる（`reextractEmptyPdfTexts` と同じ所。今のワークスペースでは 97 個）。
- 画面がまだマニフェストのない PDF を求めたら（下の `GET …/preview`）、その PDF を順番待ちの先頭に移す。

### API

`AssetStore.handle` に足す。

| | 返すもの | cache-control |
|---|---|---|
| `GET /api/assets/<ハッシュ>/preview` | マニフェスト。まだなければ 404 と `{ "status": "pending" }`、作れない（poppler がない・壊れた PDF）なら 404 と `{ "status": "unavailable" }` | `no-cache`（`mid` があとで足されるので） |
| `GET /api/assets/<ハッシュ>/preview/v1/sheet/<N>` | シート | `private, max-age=31536000, immutable` |
| `GET /api/assets/<ハッシュ>/preview/v1/page/<ページ>` | 中くらいの画像 | 同上 |

画像の URL に版（`v1`）を入れて、作り直したときに古いキャッシュを使わないようにする。

## 2. 画面で段 1・2 を使う

### AssetManager（`packages/canvas/src/assets.ts`）

- `pdfPreview(assetId): PdfPreview | null` を足す。同期で返す。初めて聞かれたら裏でマニフェストを読み始めて null を返し、読めたら `subscribe` で登録された関数を呼ぶ（View が受けて描き直す）。404 なら null のまま 60 秒は読み直さない。`mid` がないマニフェストも、60 秒たったら読み直す。
- `PdfPreview` は、ページごとに使える解像度（level）の一覧を返す。level は、今の `renderPdfPage` と同じく「既定の大きさのワールド座標 1 単位あたりの画素数」で、`画像の幅 / (ページの幅（ポイント） × 96/72)`。RESONAC の段 1 なら 256 / 1485 ≈ 0.17、段 2 なら約 0.69。
- `loadPdfPreview(assetId, pageIndex, level): Promise<RasterImage>` を足す。
  - 段 1：シートを 1 度だけ読んで（`fetch` → `createImageBitmap`）、`createImageBitmap(シート, x, y, w, h)` で切り出す。シートは最近使った 2 枚まで持つ（RESONAC の 1 枚は展開して 13 MB）。
  - 段 2：ページの画像を読む。
  - 返す `RasterImage` の level は、頼まれた level と同じにする。

### ページの描き方（`packages/nodes/src/pdfPage.ts`）

今は `pickImageLevel(zoom × devicePixelRatio)` の解像度を PDF.js に頼むだけ。これを次のようにする。

```ts
const need = info.zoom * info.devicePixelRatio
const previews = assets.pdfPreviewLevels?.(assetId, pageIndex) ?? []  // 小さい順
// 少し引き伸ばすくらいなら、前もって作った画像で足りるとみなす
const enough = previews.find((level) => level >= need * PREVIEW_STRETCH)  // PREVIEW_STRETCH = 0.8
if (enough !== undefined) {
  raster = images.get(key, 'v1', enough, () => assets.loadPdfPreview!(assetId, pageIndex, enough))
} else {
  // PDF.js で描くまでの仮の表示に、いちばん大きい前もって作った画像を先に頼んでおく
  const largest = previews.at(-1)
  if (largest !== undefined) images.get(key, 'v1', largest, () => assets.loadPdfPreview!(assetId, pageIndex, largest))
  const level = pickImageLevel(need)
  raster = images.get(key, 'v1', level, () => assets.renderPdfPage!(assetId, pageIndex, level))
}
```

- 頼んだ level の画像ができれば、その画像が出る。それまでは、同じキーにあるいちばん近い解像度の画像が出る（`nearestLevel`）。
- 画像キャッシュの順番待ちは頼んだ順に作るので、仮の表示の画像（すぐ読める）が PDF.js より先にできる。
- 段 1・2 の level（0.17 など）は `IMAGE_LEVELS`（0.25・0.5・1・2・4）と重ならないので、同じキーの中で混ざらない。
- `AssetResolver`（`packages/nodes/src/defineNodeType.ts`）に `pdfPreviewLevels?` と `loadPdfPreview?` を足す。引用カード（`quoteCard.ts`）の図も同じキーを使っているので、同じ形で使える（このときは直さない）。

### 全体表示での速さ

画像キャッシュは 1 枚ずつ作り、作るたびに描き直す。段 1 は切り出すだけ（1 枚 1 ms ほど）なので、72 ページでも描き直しの回数の分（1 秒ほど）で済む見込み。遅ければ、すぐ作れる画像はまとめて作るようにする（測ってから決める）。

## 3. 最後に見たページの画像をブラウザに保存する（B）

### 保存する所

`packages/canvas/src/pdfPageStore.ts` を足す。IndexedDB のデータベース `canvcode-pdf-pages`、ストア `pages`。

```ts
interface StoredPdfPage {
  key: string        // `${hash}#${pageIndex}@${level}`
  hash: string
  pageIndex: number
  level: number
  width: number
  height: number
  blob: Blob         // WebP（品質 0.92）。WebP にできないブラウザ（Safari）では PNG
  usedAt: number     // 最後に使った時刻。上限を超えたら古いものから消す
}
```

- 上限は 24 枚・合計 48 MB。2900px のページは WebP で 1 枚 約 0.5 MB、PNG では数 MB。
- 端末ごとに持つ。カメラの位置（localStorage）と同じ考え方。
- IndexedDB は、プライベートウィンドウなどで使えないことがある。読み書きはすべて try/catch で包み、使えなければ何もしない。

### 読む

`AssetManager.renderPdfPage` の最初で、`level >= 1` なら保存した画像を探す。同じ level のものがあれば `createImageBitmap(blob)` で返し、`usedAt` を更新する。このとき PDF は開かない（受け取りもしない）。

level がぴったり同じものだけを使う。違う level の画像を返すと、画像キャッシュは頼んだ level がないとみなして、また同じ関数を呼び続ける。ウィンドウの大きさや devicePixelRatio が前と同じなら、カメラも前と同じなので level も同じになる。

### 書く

View が、カメラが止まって 1.5 秒たち、画像キャッシュの順番待ちが空になったときに保存する。

- 画面に見えている PDF のページのうち、画面の 25% 以上を占めるもの（読んでいるページ）を、多くて 4 枚まで選ぶ。
- 画像キャッシュに今の level（1 以上）の画像があり、まだ保存していなければ、`OffscreenCanvas` に描いて `convertToBlob` で WebP にし、保存する。保存したキーはメモリーにも覚えておき、同じものを 2 度書かない。
- 画像キャッシュに `peek(key, version, level): RasterImage | null` を足す（今の `get` は、ないときに作る順番待ちに入れてしまうので）。

## 4. Asset の配信を Range リクエストに対応させる

`AssetStore.send`（`apps/server/src/assets.ts`）を直す。

- すべての応答に `accept-ranges: bytes` と `etag`（原本は `"<ハッシュ>"`、縮小版は `"<ハッシュ>.<長辺>"`）を付ける。
- `Range: bytes=a-b`・`bytes=a-`・`bytes=-n` の 1 つの範囲だけを扱う。`206` と `content-range: bytes a-b/全体` を返し、`createReadStream(path, { start, end })` で送る。
- 範囲が 2 つ以上、または書き方が違うときは、Range を無視して 200 で全体を返す（HTTP の決まりで許されている）。
- 範囲の始まりがファイルの大きさ以上なら、`416` と `content-range: bytes */全体` を返す。
- `If-Range` が付いていて `etag` と違えば、200 で全体を返す（中身は変わらないので、ふつうは起きない）。

画面側は変えない。PDF.js は `accept-ranges: bytes` を見て、要る部分だけを Range で読む。RESONAC は 1 ページ目まで約 2 MB で、ほかのページも、そのページの中身の分だけ読めば描ける。読み終わった部分の残りは、裏で読み続ける（PDF.js の既定。`disableAutoFetch: false`）。

ブラウザとサーバーの間にリバースプロキシなどがあれば、Range を通すか確かめる。

## 期待する効果（RESONAC）

| | 今 | 直したあと |
|---|---|---|
| A. 初めて全体表示で開く | 16 MB を受け取る ＋ 72 ページを PDF.js で描く（約 30 秒） | マニフェストとシート 0.6 MB を受け取る ＋ 切り出す（約 1 秒） |
| B. 前に読んでいたページに戻る（タブを開き直した後も） | 16 MB を受け取る ＋ 1〜2 ページを描く（約 1 秒〜） | IndexedDB から読む（0.1 秒ほど） |
| B'. 初めて、またはほかの端末で拡大表示 | 同上 | 段 2 の画像（1 ページ 100 KB）がすぐ出る ＋ 要る部分だけ Range で読んで描く |

## PR の分け方

1. **サーバー：ページの画像を作る**（1 の全部）。画面は変わらない。
2. **画面：ページの画像を使う**（2）。ここで A が速くなる。
3. **画面：最後に見たページの画像を保存する**（3）。ここで B が速くなる。
4. **サーバー：Range リクエスト**（4）。小さく、ほかと関係ないので、いつ入れてもよい。

## 確かめること

- サーバー：小さな PDF（日本語のフォントを埋め込んでいないものを含む）からマニフェスト・シート・中くらいの画像ができること。シートの位置とページの大きさが合うこと。poppler がなければ作らず、`/preview` が `unavailable` を返すこと（ユニットテスト。poppler がない環境では飛ばす）。
- サーバー：Range（`a-b`・`a-`・`-n`・2 つ以上・範囲外・`If-Range`）の応答（ユニットテスト）。
- 画面：倍率に応じて、段 1・段 2・PDF.js のどれを頼むか（`pdfPage` のユニットテスト）。PDF.js を待つ間に段 2 の画像が出ること。
- 画面：`PdfPageStore` の上限と古いものからの消去（IndexedDB の代わりにメモリーの実装を渡して確かめる）。保存した level と違う level では使わないこと。
- e2e：RESONAC 相当の PDF の Canvas を全体表示で開き、すべてのページがそろうまでの時間と、PDF の本体を受け取らないこと。

## 決めておきたいこと

- **poppler に頼ってよいか。** OS のパッケージが 1 つ増える。代わりに、取り込んだブラウザで描いて送る形（画像の縮小版と同じ）もあるが、取り込むたびにブラウザで 30 秒ほど描くことになり（iPad では長くなる）、今ある 97 個の PDF は作れない。ここでは poppler を勧める。
- **段 2（1024px）を作るか。** なくても A は速くなる。ページの少ない PDF の全体表示（倍率が 0.25 を超える）と、B' の仮の表示が今と同じになる。容量は PDF 1 つで数 MB 増える。作ることを勧める。
