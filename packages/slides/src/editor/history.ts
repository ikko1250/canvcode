/**
 * 不変スナップショットの undo / redo。
 * 同じ key（例: "slide:3:title"）で短時間に続く push は 1 手にまとめる。
 */
export type History<T> = {
  past: T[];
  present: T;
  future: T[];
  lastKey: string | null;
  lastTime: number;
};

export const HISTORY_LIMIT = 100;
export const COALESCE_WINDOW_MS = 1000;

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], lastKey: null, lastTime: 0 };
}

export function push<T>(
  history: History<T>,
  next: T,
  key: string | null = null,
  now: number = Date.now(),
  limit: number = HISTORY_LIMIT,
): History<T> {
  if (next === history.present) {
    return history;
  }
  const coalesce =
    key !== null && key === history.lastKey && now - history.lastTime < COALESCE_WINDOW_MS;
  if (coalesce) {
    return { ...history, present: next, future: [], lastTime: now };
  }
  const past = [...history.past, history.present];
  return {
    past: past.length > limit ? past.slice(past.length - limit) : past,
    present: next,
    future: [],
    lastKey: key,
    lastTime: now,
  };
}

/** 次の push を必ず新しい 1 手にする（フォーカスが外れたときなど） */
export function breakCoalescing<T>(history: History<T>): History<T> {
  return history.lastKey === null ? history : { ...history, lastKey: null };
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0;
}

export function undo<T>(history: History<T>): History<T> {
  const previous = history.past[history.past.length - 1];
  if (previous === undefined) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
    lastKey: null,
    lastTime: 0,
  };
}

export function redo<T>(history: History<T>): History<T> {
  const [next, ...rest] = history.future;
  if (next === undefined) return history;
  return {
    past: [...history.past, history.present],
    present: next,
    future: rest,
    lastKey: null,
    lastTime: 0,
  };
}
