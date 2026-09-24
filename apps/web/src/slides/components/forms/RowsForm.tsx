/** @jsxImportSource preact */
import { getMaxRowCount, type SlideLayout } from "@canvcode/slides/core/slide-layout-spec";
import { newRow, type DraftRow } from "../../state.ts";

type Props = {
  rows: DraftRow[];
  layout: SlideLayout;
  onChange: (rows: DraftRow[], key: string | null) => void;
};

export function RowsForm({ rows, layout, onChange }: Props) {
  const max = getMaxRowCount(layout);

  const setRow = (index: number, patch: Partial<DraftRow>, field: string): void => {
    const target = rows[index];
    if (!target) return;
    onChange(
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
      `row:${target.id}:${field}`,
    );
  };

  const move = (index: number, delta: -1 | 1): void => {
    const to = index + delta;
    if (to < 0 || to >= rows.length) return;
    const next = [...rows];
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    onChange(next, null);
  };

  return (
    <>
      <div class="section">
        表の行
        <span class="count">
          {rows.length} / {max} 行 ・ セル内は改行で視覚行を分ける
        </span>
      </div>
      {rows.map((row, index) => (
        <div class="row-editor" key={row.id}>
          <div>
            <label>ラベル（左列）</label>
            <textarea
              rows={2}
              value={row.label}
              onInput={(event) => setRow(index, { label: event.currentTarget.value }, "label")}
            />
          </div>
          <div>
            <label>本文（右列）</label>
            <textarea
              rows={3}
              value={row.body}
              onInput={(event) => setRow(index, { body: event.currentTarget.value }, "body")}
            />
          </div>
          <div class="ops">
            <button title="上へ" disabled={index === 0} onClick={() => move(index, -1)}>
              ↑
            </button>
            <button title="下へ" disabled={index === rows.length - 1} onClick={() => move(index, 1)}>
              ↓
            </button>
            <button
              title="削除"
              class="danger"
              disabled={rows.length <= 1}
              onClick={() => onChange(rows.filter((_, i) => i !== index), null)}
            >
              ✕
            </button>
          </div>
        </div>
      ))}
      <button disabled={rows.length >= max} onClick={() => onChange([...rows, newRow()], null)}>
        行を追加
      </button>
    </>
  );
}
