/** @jsxImportSource preact */
export type ExportOutcome = {
  format: "pdf" | "png";
  outputs: string[];
  warnings: string[];
  elapsedMs: number;
};

type Props = { outcome: ExportOutcome; onClose: () => void };

export function ExportDialog({ outcome, onClose }: Props) {
  return (
    <div class="modal-backdrop" onClick={onClose}>
      <div class="modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <h2>
          {outcome.format.toUpperCase()} 出力が完了しました（{(outcome.elapsedMs / 1000).toFixed(1)} 秒）
        </h2>
        <p>出力先:</p>
        <ul>
          {outcome.outputs.map((output) => (
            <li key={output}>
              <code>{output}</code>
            </li>
          ))}
        </ul>
        {outcome.warnings.length > 0 && (
          <>
            <p>警告（出力は完了しています）:</p>
            <ul class="warnings">
              {outcome.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          </>
        )}
        <div class="actions">
          <button class="primary" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
