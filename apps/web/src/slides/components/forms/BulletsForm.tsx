/** @jsxImportSource preact */
import { getMaxRowCount } from "@canvcode/slides/core/slide-layout-spec";
import {
  addBulletChild,
  insertBulletAfter,
  MAX_BULLET_DEPTH,
  moveBulletAt,
  newBullet,
  removeBulletAt,
  updateBulletText,
  type DraftBullet,
} from "../../state.ts";

type Change = (items: DraftBullet[], key: string | null) => void;

type NodeProps = {
  item: DraftBullet;
  path: number[];
  siblingCount: number;
  items: DraftBullet[];
  max: number;
  onChange: Change;
};

function BulletNode({ item, path, siblingCount, items, max, onChange }: NodeProps) {
  const depth = path.length;
  const position = path[path.length - 1] ?? 0;
  const topLevelFull = depth === 1 && siblingCount >= max;

  return (
    <div>
      <div class="bullet">
        <input
          type="text"
          value={item.text}
          placeholder={depth === 1 ? "項目" : "子項目"}
          onInput={(event) =>
            onChange(updateBulletText(items, path, event.currentTarget.value), `bullet:${item.id}`)
          }
        />
        <span class="ops">
          <button title="上へ" disabled={position === 0} onClick={() => onChange(moveBulletAt(items, path, -1), null)}>
            ↑
          </button>
          <button
            title="下へ"
            disabled={position === siblingCount - 1}
            onClick={() => onChange(moveBulletAt(items, path, 1), null)}
          >
            ↓
          </button>
          <button
            title="同じ階層に追加"
            disabled={topLevelFull}
            onClick={() => onChange(insertBulletAfter(items, path), null)}
          >
            ＋
          </button>
          <button
            title="子項目を追加"
            disabled={depth >= MAX_BULLET_DEPTH}
            onClick={() => onChange(addBulletChild(items, path), null)}
          >
            ＋子
          </button>
          <button
            title="削除"
            class="danger"
            disabled={depth === 1 && siblingCount <= 1}
            onClick={() => onChange(removeBulletAt(items, path), null)}
          >
            ✕
          </button>
        </span>
      </div>
      {item.children.length > 0 && (
        <div class="bullet-children">
          {item.children.map((child, index) => (
            <BulletNode
              key={child.id}
              item={child}
              path={[...path, index]}
              siblingCount={item.children.length}
              items={items}
              max={max}
              onChange={onChange}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type Props = { items: DraftBullet[]; onChange: Change };

export function BulletsForm({ items, onChange }: Props) {
  const max = getMaxRowCount("bullets");
  return (
    <>
      <div class="section">
        箇条書き
        <span class="count">
          {items.length} / {max} 項目 ・ {MAX_BULLET_DEPTH} 階層まで
        </span>
      </div>
      {items.map((item, index) => (
        <BulletNode
          key={item.id}
          item={item}
          path={[index]}
          siblingCount={items.length}
          items={items}
          max={max}
          onChange={onChange}
        />
      ))}
      <button disabled={items.length >= max} onClick={() => onChange([...items, newBullet()], null)}>
        項目を追加
      </button>
    </>
  );
}
