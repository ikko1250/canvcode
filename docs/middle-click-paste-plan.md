# 中ボタンでパンすると、PRIMARY の選択の文字が貼り付けられる

Ubuntu で開くと、中ボタンでパンして離したときに、前に選んだ文字（クリップボードの中身に見える）が文字のカードとして置かれる。

## 原因

- Linux のブラウザは、中ボタンを離すと、最後にマウスで選んだ文字（X11 / Wayland の PRIMARY の選択）を貼り付ける。
  Ctrl+C のクリップボードとは別で、文字を選んだだけで入る。
- そのとき `paste` イベントが来る。キャンバスは `window` の `paste` を受けて（MAI-26）、文字なら文字のカードにする。
  フォーカスがキャンバスにあれば、編集できる要素でなくても来る（Chromium も Firefox も）。
- 文字やドキュメントを編集している間のパン（編集を続ける）では、その文字の中に貼られる。
- 中ボタンを押したときの `pointerdown` は `preventDefault` していたが、貼り付けは離したときの既定の動作なので止まらない。
  - Chromium：`pointerup`（と `mouseup`）の既定の動作。`pointerup` を `preventDefault` すると止まる。
  - Firefox：`auxclick` の既定の動作。`auxclick` を `preventDefault` すると止まる。
- Windows・macOS には中ボタンの貼り付けがないので起きない。

## 直し方

- キャンバスの要素（`root`）で、中ボタンの `pointerup` と `auxclick` を `preventDefault` する（`packages/canvas/src/view.ts`）。
  キャンバスの中ボタンは、パンと、ポータルを新しいタブで開く操作で、どちらも自分で行っているので、既定の動作は要らない。
- キャンバスの外（Claude のパネル・サイドバーなど）の中ボタンの貼り付けは、今のまま。

## タスク

1. e2e（`tests/e2e/middle-click-paste.spec.ts`）を足す。キャンバスの外の文字をマウスで選んで PRIMARY に入れ、
   - 中ボタンでパンしても、中ボタンでクリックしても、`paste` イベントが来ず、ノードが増えない
   - 文字を編集しながら中ボタンでパンしても、文字が変わらない
   - 確かめる側：キャンバスの外での中ボタンのクリックでは `paste` が来る（PRIMARY に入っている）
2. `view.ts` を直す。
3. 直す前のコードで落ち、直したあとは通ることを、Chromium と Firefox で確かめる。
