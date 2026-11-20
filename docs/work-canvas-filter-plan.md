# 作業のタブの Canvas の絞り込みを、ボタンにする

ユーザーの頼み：作業パネル（Claude のパネル）の作業のタブの「すべてのキャンバス」と「今開いているキャンバス」は、ボタンにする。
「Canvas current / all」のように。

## 今の作り

- 作業のタブ（`QuestionPanel.tsx`）の一覧の上に、`<select>` と ▾ がある（「すべてのキャンバス」「いま開いているキャンバス」）。既定はすべて。
- 選んだものは覚えない。パネルを閉じると QuestionPanel が消えるので、開き直すとすべてに戻る（会話のタブに替えても、隠すだけなので残る）。
- いま開いている Canvas にすると、動作中の作業・許可の問い合わせ・過去の作業を、その Canvas のものだけにし、過去の作業は `?canvasId=` を付けて読み直す。
- 絞って何もないときも、空の説明は「どの Canvas で頼んだものも」のままだった。

## 直し方

1. `<select>` と ▾ を、`Canvas [ current | all ]` の 2 択の切り替えにする。
   - 前に「Canvas」を弱い文字の色・14px で置く（読み上げない。`aria-hidden`）。ボタンの文字は `current`・`all`。並びは current → all。
   - 既定は all のまま。選んだものは覚えない（今どおり）。
2. 見た目と操作は、会話の入力欄の「会話｜質問」の切り替えにそろえる。
   - 入れ物は `role="radiogroup"`、`aria-label="どの Canvas の作業を出すか"`。ボタンは `role="radio"` と `aria-checked`。
   - 選んでいる方だけ Tab で止まる。←→↑↓ で切り替え、フォーカスも移す。
   - 読み上げの名前は見えている文字（current／all）のまま。日本語の説明は title に書く（「いま開いている Canvas で頼んだ作業だけ」「どの Canvas で頼んだ作業も」）。
   - 会話のタブの e2e は `getByRole('radio', { name: '質問' })` で範囲を絞らずに探すので、新しいボタンの名前に「質問」を入れない。
3. 「会話｜質問」の切り替えを、小さな部品 `ChoiceSwitch.tsx` に切り出し、両方で使う。会話の入力欄の見た目・操作は変えない
   （2 つなら、どの矢印でももう一方に移る。今と同じ）。
4. CSS（`styles.css`）
   - `.claude-panel .claude-mode button` の 2 つの規則を、作業のタブにも効くよう `:is(.claude-panel, .question-panel)` に広げる。
   - 当たりの下 8px（`.claude-mode > button`）は、入力欄の枠の余白のためのものなので、`.claude-compose-actions` の中に限る。
     作業のタブでは、パネルのボタンと同じ 4px（下の並びとの間は 10px）。
   - select 用の `.question-filter` と `.question-filter-caret` を消し、「Canvas」と切り替えを横に並べる（間 6px、`align-self: flex-start`）。
   - 狭い幅（パネルの中身 356px。720px 以下の画面では全面）でも 1 行に収まる（「Canvas」から all の右の端まで 180px ほど）。
5. ついでに直す
   - current に絞って何もないときの空の説明を、「いま開いている Canvas で頼んだ作業は、まだありません。…ほかの Canvas で頼んだものは、
     上の「all」で見られます。」にする。
   - `QuestionPanel.tsx` の先頭のコメント（「すべてのキャンバス ▾」）と、README の作業のタブの説明を直す。

## タスク

- [x] e2e を足す（`tests/e2e/canvas-answer.spec.ts`）。直す前のコードで落ちることを確かめる。
  - いまの Canvas の報告 1 件と、ほかの Canvas の動作中の作業・許可の問い合わせ・過去の作業を置く。
  - 既定で all が `aria-checked="true"`（Tab で止まるのも all）。current を押すと、ほかの Canvas の 3 つが消え、いまの Canvas の報告は残る。
    過去の作業は `?canvasId=` を付けて読み直す。
  - ←→ で切り替わり、フォーカスも移る。
  - いまの Canvas の報告を消すと、current 用の空の説明が出る。all で戻る（`?canvasId=` を付けずに読み直す）。
  - 幅 320px の画面（パネルは全面）でも、「Canvas」と 2 つのボタンが 1 行に並び、一覧の幅に収まる。
- [x] `ChoiceSwitch.tsx` を作り、`ChatComposer.tsx` をそれで書き直す。
- [x] `QuestionPanel.tsx` の select を `ChoiceSwitch` にし、空の説明を出し分け、コメントを直す。
- [x] `styles.css` を直す。
- [x] README の作業のタブの説明を直す。
- [x] 型チェック・lint・関わる単体テスト・関わる e2e（canvas-answer・claude-panel・target-size・ui-typography）を回す。
- [ ] 独立したサブエージェントのレビューを受けて直す。
- [ ] 空のワークスペースで確認用のサーバーを立てて、確かめてもらう。
- [ ] ユーザーの承認を受けて、統合ブランチへの PR を作る。
